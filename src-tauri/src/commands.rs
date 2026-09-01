use crate::applog;
use crate::aws::{creds_cache, engage, sso, sso_oidc, token_cache};
use crate::config::aws_config_editor::{self, AwsFile};
use crate::config::{self, Account, OrgConfig, Project};
use crate::error::AppError;
use crate::secrets;
use crate::state;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgStatus {
    pub name: String,
    pub start_url: String,
    pub region: String,
    pub token_expires_at: Option<String>,
}

fn status_for(org: &OrgConfig) -> OrgStatus {
    let token_expires_at = token_cache::read(&org.name).map(|t| t.expires_at);
    OrgStatus {
        name: org.name.clone(),
        start_url: org.start_url.clone(),
        region: org.region.clone(),
        token_expires_at,
    }
}

fn find_org(name: &str) -> Result<OrgConfig, AppError> {
    config::load_or_seed()
        .orgs
        .into_iter()
        .find(|o| o.name == name)
        .ok_or_else(|| AppError::UnknownOrg(name.to_string()))
}

#[tauri::command]
pub fn list_orgs() -> Vec<OrgStatus> {
    config::load_or_seed().orgs.iter().map(status_for).collect()
}

#[tauri::command]
pub fn save_org(mut org: OrgConfig) -> Result<Vec<OrgStatus>, AppError> {
    // Regions are case-sensitive in SigV4 scopes — "US-EAST-1" breaks
    // every signature downstream. Normalize at the door.
    org.region = org.region.trim().to_lowercase();
    applog::info("save_org", &org);
    let cfg = config::upsert_org(org)?;
    Ok(cfg.orgs.iter().map(status_for).collect())
}

/// Removes an Org along with any Accounts/Projects that reference it, and
/// its cached credentials (token cache file + keyring entries).
#[tauri::command]
pub fn delete_org(name: String) -> Result<Vec<OrgStatus>, AppError> {
    let cfg = config::delete_org(&name)?;
    let _ = token_cache::delete(&name);
    secrets::clear_org(&name);
    applog::info("delete_org", &json!({"name": name}));
    Ok(cfg.orgs.iter().map(status_for).collect())
}

/// Clears an Org's cached credentials without removing its configuration —
/// the next login for it starts a fresh device-auth flow.
#[tauri::command]
pub fn sign_out_org(name: String) -> Result<OrgStatus, AppError> {
    let org = find_org(&name)?;
    let _ = token_cache::delete(&name);
    secrets::clear_org(&name);
    applog::info("sign_out_org", &json!({"name": name}));
    Ok(status_for(&org))
}

#[tauri::command]
pub async fn login_org(app: AppHandle, name: String) -> Result<OrgStatus, AppError> {
    let org = find_org(&name)?;
    match sso_oidc::login(&app, &org).await {
        Ok(_) => {
            // A fresh session means stale static keys can rotate NOW —
            // don't leave expired credentials lying around for a tick.
            let _ = refresh_engaged_credentials().await;
            Ok(status_for(&org))
        }
        Err(e) => {
            let app_err: AppError = e.into();
            applog::error("login_org failed", &json!({"name": name, "error": app_err.to_string()}));
            Err(app_err)
        }
    }
}

/// Aborts an in-flight device-authorization login.
///
/// Exists because closing the browser window leaves nothing to abort it:
/// the poll would otherwise run for the full ten-minute device-code
/// lifetime, and the frontend refuses to start a second login while one is
/// active — so the user was stranded with no way forward or back.
#[tauri::command]
pub fn cancel_login() {
    sso_oidc::request_cancel();
}

#[tauri::command]
pub fn list_accounts() -> Vec<Account> {
    config::load_or_seed().accounts
}

#[tauri::command]
pub fn save_account(account: Account) -> Result<Vec<Account>, AppError> {
    applog::info("save_account", &account);
    Ok(config::upsert_account(account)?.accounts)
}

#[tauri::command]
pub fn delete_account(alias: String) -> Result<Vec<Account>, AppError> {
    applog::info("delete_account", &json!({"alias": alias}));
    Ok(config::delete_account(&alias)?.accounts)
}

#[tauri::command]
pub fn list_projects() -> Vec<Project> {
    config::load_or_seed().projects
}

#[tauri::command]
pub fn save_project(project: Project) -> Result<Vec<Project>, AppError> {
    applog::info("save_project", &project);
    Ok(config::upsert_project(project)?.projects)
}

#[tauri::command]
pub fn delete_project(name: String) -> Result<Vec<Project>, AppError> {
    applog::info("delete_project", &json!({"name": name}));
    Ok(config::delete_project(&name)?.projects)
}

/// Enumerates every AWS account + permission-set the current Org's SSO
/// assignment grants — legacy flat listing kept for the manual add-account
/// escape hatch. Requires a valid cached login for `org_name`.
#[tauri::command]
pub async fn discover_accounts(org_name: String) -> Result<Vec<sso::DiscoveredAccount>, AppError> {
    let org = find_org(&org_name)?;
    let result = sso::discover_accounts(&org.name, &org.region).await;
    if let Err(e) = &result {
        applog::error("discover_accounts failed", &json!({"org": org_name, "error": e.to_string()}));
    }
    Ok(result?)
}

/// Full auto-discovery: fetch every account + its roles (emitting
/// `discover:progress {done, total}` as each account's roles resolve, so
/// the scan UI streams instead of sitting on a mute spinner), then apply
/// the naming-convention grouping heuristic and return fully-formed,
/// pre-checked import candidates.
#[tauri::command]
pub async fn discover_grouped(app: AppHandle, org_name: String) -> Result<crate::discovery::GroupedDiscovery, AppError> {
    use tauri::Emitter;
    let org = find_org(&org_name)?;
    // Session chaining: silent refresh if the access token lapsed (the
    // 1h AWS lifetime), browser flow only if the whole SSO session is
    // gone — either way the user's one SCAN click carries through.
    sso_oidc::login(&app, &org).await.map_err(AppError::from)?;
    let raw = sso::fetch_raw_accounts(&org.name, &org.region, |done, total| {
        let _ = app.emit("discover:progress", json!({"done": done, "total": total}));
    })
    .await
    .map_err(|e| {
        applog::error("discover_grouped failed", &json!({"org": org_name, "error": e.to_string()}));
        AppError::Discovery(e.to_string())
    })?;

    let grouped = crate::discovery::group_accounts(&org.name, raw);
    applog::info(
        format!(
            "{org_name}: grouped {} accounts into {} services + {} standalone",
            grouped.total_accounts,
            grouped.services.len(),
            grouped.standalone.len()
        ),
        &json!({
            "org": org_name,
            "serviceAliases": grouped.services.iter().map(|s| s.account.alias.as_str()).collect::<Vec<_>>(),
            "standaloneAliases": grouped.standalone.iter().map(|s| s.account.alias.as_str()).collect::<Vec<_>>(),
        }),
    );
    Ok(grouped)
}

/// Bulk import from the discovery review screen — upserts every selected
/// account in one pass and returns the full updated account list.
#[tauri::command]
pub fn import_accounts(accounts: Vec<Account>) -> Result<Vec<Account>, AppError> {
    applog::info(
        format!("import_accounts: {} account(s)", accounts.len()),
        &json!({"aliases": accounts.iter().map(|a| a.alias.as_str()).collect::<Vec<_>>()}),
    );
    let mut cfg = config::load_or_seed();
    for account in accounts {
        match cfg.accounts.iter_mut().find(|a| a.alias == account.alias) {
            Some(existing) => *existing = account,
            None => cfg.accounts.push(account),
        }
    }
    config::save(&cfg)?;
    Ok(cfg.accounts)
}

/// Background session upkeep: silently refreshes the org's access token
/// via the keyring refresh token when it's expired or close to it. Never
/// opens a browser — a dead session simply stays expired until the user
/// clicks log in. Returns the (possibly updated) status either way.
#[tauri::command]
pub async fn refresh_session(name: String) -> Result<OrgStatus, AppError> {
    let org = find_org(&name)?;
    let _ = sso_oidc::ensure_fresh_token(&org).await;
    Ok(status_for(&org))
}

#[tauri::command]
pub fn get_state() -> state::AppState {
    state::load()
}

#[tauri::command]
pub fn set_pin(project: String, pinned: bool) -> Result<state::AppState, AppError> {
    let mut st = state::load();
    st.pins.retain(|p| p != &project);
    if pinned {
        st.pins.push(project);
    }
    state::save(&st)?;
    Ok(st)
}

/// Real engage: role credentials fetched, `~/.aws/config` wired, state
/// recorded. Emits `engage:progress {alias, status, message}` per service.
/// If the org's SSO session is expired, the login flow (browser approval)
/// runs first and the SAME engage continues automatically after — the
/// user's one click survives the reauth detour.
#[tauri::command]
pub async fn engage(app: AppHandle, request: engage::EngageRequest) -> Result<engage::EngageOutcome, AppError> {
    use tauri::Emitter;
    let org = find_org(&request.org_name)?;

    // login() short-circuits instantly on a valid token, silently
    // refreshes a lapsed one, and only opens the browser when the whole
    // SSO session is gone — so the engage click always carries through.
    sso_oidc::login(&app, &org).await.map_err(AppError::from)?;

    let accounts = config::load_or_seed().accounts;
    let outcome = engage::engage(&org, &accounts, &request, |alias, status, message| {
        let _ = app.emit("engage:progress", json!({"alias": alias, "status": status, "message": message}));
    })
    .await?;
    Ok(outcome)
}

/// Physically strips the static keys for the given profiles from
/// ~/.aws/credentials in one write — with static-key delivery, disengage
/// means the secrets are GONE, not merely refused. Key list is owned by
/// engage so write and strip can never disagree.
fn strip_static_keys(profiles: &[String]) {
    let refs: Vec<&str> = profiles.iter().map(String::as_str).collect();
    let _ = aws_config_editor::remove_profiles_keys(AwsFile::Credentials, &refs, &engage::STATIC_CRED_KEYS);
}

/// Stand-down: removes profiles from the engaged map, deletes their cached
/// role credentials, and strips the static keys out of
/// `~/.aws/credentials`. The `~/.aws/config` stanza (region) stays.
#[tauri::command]
pub fn disengage(profiles: Vec<String>) -> Result<state::AppState, AppError> {
    let mut st = state::load();
    for p in &profiles {
        st.engaged.remove(p);
        let _ = creds_cache::delete(p);
    }
    strip_static_keys(&profiles);
    state::save(&st)?;
    applog::info(format!("disengaged {} profile(s)", profiles.len()), &json!({"profiles": profiles}));
    Ok(st)
}

#[tauri::command]
pub fn disengage_all() -> Result<state::AppState, AppError> {
    let mut st = state::load();
    let profiles: Vec<String> = st.engaged.keys().cloned().collect();
    for p in &profiles {
        let _ = creds_cache::delete(p);
    }
    strip_static_keys(&profiles);
    st.engaged.clear();
    state::save(&st)?;
    applog::info(format!("disengaged ALL ({} profile(s))", profiles.len()), &json!({"profiles": profiles}));
    Ok(st)
}

/// Background credential rotation for static-key delivery. The schedule
/// lives in the backend (see lib.rs setup); this command exists so the
/// frontend can also trigger an immediate pass. Skips instantly when
/// nothing is engaged.
#[tauri::command]
pub async fn refresh_engaged_credentials() -> Result<usize, AppError> {
    let st = state::load();
    if st.engaged.is_empty() {
        return Ok(0);
    }
    let entries: Vec<(String, state::EngagedProfile)> = st.engaged.into_iter().collect();
    let orgs = config::load_or_seed().orgs;
    Ok(engage::rotate_stale_profiles(&orgs, &entries, engage::ROTATE_MARGIN_MS).await)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTest {
    pub ok: bool,
    pub account: Option<String>,
    pub arn: Option<String>,
    pub user_id: Option<String>,
    pub message: Option<String>,
    pub ms: u64,
}

/// End-to-end profile verification: shells out to the REAL AWS CLI
/// (`aws sts get-caller-identity --profile <alias>`), which reads
/// `~/.aws/config`, invokes sleipnir's own `credential_process`, and hits
/// STS — the exact path every terminal uses. Nothing simulated.
#[tauri::command]
pub async fn test_profile(alias: String) -> Result<ProfileTest, AppError> {
    // Self-heal before probing: a stale engaged profile (e.g. the org's
    // session just came back after days away) gets its static keys
    // rotated first — same policy as the background tick — so the test
    // reports the health of the live path, not yesterday's leftovers.
    let st = state::load();
    if let Some(entry) = st.engaged.get(&alias) {
        let orgs = config::load_or_seed().orgs;
        let _ = engage::rotate_stale_profiles(&orgs, &[(alias.clone(), entry.clone())], engage::ROTATE_MARGIN_MS).await;
    }

    let started = std::time::Instant::now();
    let run = tokio::process::Command::new("aws")
        .args(["sts", "get-caller-identity", "--profile", &alias, "--output", "json"])
        .output();

    let output = match tokio::time::timeout(std::time::Duration::from_secs(20), run).await {
        Err(_) => {
            return Ok(ProfileTest {
                ok: false,
                account: None,
                arn: None,
                user_id: None,
                message: Some("timed out after 20s — network or credential resolution is hanging".into()),
                ms: started.elapsed().as_millis() as u64,
            })
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProfileTest {
                ok: false,
                account: None,
                arn: None,
                user_id: None,
                message: Some("AWS CLI not found on PATH — install awscli to run this test".into()),
                ms: started.elapsed().as_millis() as u64,
            })
        }
        Ok(Err(e)) => return Err(AppError::Io(e.to_string())),
        Ok(Ok(out)) => out,
    };

    let ms = started.elapsed().as_millis() as u64;
    if output.status.success() {
        let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
        let result = ProfileTest {
            ok: true,
            account: parsed.get("Account").and_then(|v| v.as_str()).map(String::from),
            arn: parsed.get("Arn").and_then(|v| v.as_str()).map(String::from),
            user_id: parsed.get("UserId").and_then(|v| v.as_str()).map(String::from),
            message: None,
            ms,
        };
        applog::info(format!("test_profile {alias}: OK in {ms}ms"), &result);
        Ok(result)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() { format!("aws exited with {}", output.status) } else { stderr };
        applog::warn(format!("test_profile {alias}: FAILED in {ms}ms"), &json!({"alias": alias, "message": message}));
        Ok(ProfileTest { ok: false, account: None, arn: None, user_id: None, message: Some(message), ms })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    pub accounts: Vec<Account>,
    pub state: state::AppState,
}

/// Renames a service's alias everywhere it's load-bearing: config accounts
/// + project memberships, the engaged map and last-engage memory, the
/// per-profile creds cache file, and the `[profile X]` stanza (incl. its
/// `credential_process --profile` argument) in `~/.aws/config`.
#[tauri::command]
pub fn rename_account(old_alias: String, new_alias: String) -> Result<RenameOutcome, AppError> {
    let new_alias = new_alias.trim().to_string();
    if new_alias.is_empty()
        || !new_alias.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(AppError::Invalid(
            "alias must be lowercase letters, digits and dashes (it becomes the AWS profile name)".into(),
        ));
    }

    let mut cfg = config::load_or_seed();
    if new_alias != old_alias && cfg.accounts.iter().any(|a| a.alias == new_alias) {
        return Err(AppError::Invalid(format!("alias '{new_alias}' is already in use")));
    }
    let Some(account) = cfg.accounts.iter_mut().find(|a| a.alias == old_alias) else {
        return Err(AppError::Invalid(format!("unknown service '{old_alias}'")));
    };
    account.alias = new_alias.clone();
    for project in &mut cfg.projects {
        for member in &mut project.members {
            if *member == old_alias {
                *member = new_alias.clone();
            }
        }
    }
    config::save(&cfg)?;

    let mut st = state::load();
    if let Some(e) = st.engaged.remove(&old_alias) {
        st.engaged.insert(new_alias.clone(), e);
    }
    if let Some(le) = st.last_engage.remove(&format!("service:{old_alias}")) {
        st.last_engage.insert(format!("service:{new_alias}"), le);
    }
    if let Err(e) = state::save(&st) {
        applog::error("rename_account: state.json write failed", &json!({"error": e.to_string()}));
    }

    let _ = creds_cache::rename(&old_alias, &new_alias);
    for file in [AwsFile::Config, AwsFile::Credentials] {
        if let Err(e) = aws_config_editor::rename_profile(file, &old_alias, &new_alias) {
            applog::error("rename_account: aws file rename failed", &json!({"file": format!("{file:?}"), "error": e.to_string()}));
        }
    }

    applog::info(
        format!("renamed service '{old_alias}' → '{new_alias}'"),
        &json!({"oldAlias": old_alias, "newAlias": new_alias}),
    );
    Ok(RenameOutcome { accounts: cfg.accounts, state: st })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub config_path: String,
    pub log_dir: String,
}

/// Whether this is a `tauri dev` build. The badge in the rail reads this
/// rather than sniffing `location.protocol`, so what the UI claims and
/// which `~/.sleipnir*` directory is actually in use come from one source
/// and cannot drift apart.
#[tauri::command]
pub fn is_dev_build() -> bool {
    crate::paths::is_dev()
}

#[tauri::command]
pub fn app_paths(app: AppHandle) -> Result<AppPaths, AppError> {
    let log_dir = app.path().app_log_dir().map_err(|e| AppError::Io(e.to_string()))?;
    Ok(AppPaths {
        config_path: config::path().display().to_string(),
        log_dir: log_dir.display().to_string(),
    })
}

/// Reveals a file or folder in the OS file manager (Finder on macOS,
/// Explorer on Windows) — used by the Developer settings tab.
#[tauri::command]
pub fn open_in_file_manager(path: String) -> Result<(), AppError> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| AppError::Io(e.to_string()))
}

/// Tails the current log file for the Developer settings tab.
#[tauri::command]
pub fn read_logs(app: AppHandle, max_lines: Option<usize>) -> Result<String, AppError> {
    let dir = app.path().app_log_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let mut entries: Vec<_> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(AppError::Io(e.to_string())),
    };
    entries.retain(|e| e.path().extension().map(|ext| ext == "log").unwrap_or(false));
    // Dev and production share this directory (it derives from the bundle
    // identifier), so pick only this build's own log — otherwise the newest
    // file wins and a dev run hijacks the production log viewer.
    entries.retain(|e| {
        e.path()
            .file_stem()
            .and_then(|s| s.to_str())
            .map(crate::paths::owns_log_file)
            .unwrap_or(false)
    });
    entries.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());

    let Some(latest) = entries.last() else { return Ok(String::new()) };
    let contents = std::fs::read_to_string(latest.path())?;
    let max_lines = max_lines.unwrap_or(2000);
    let lines: Vec<&str> = contents.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    Ok(lines[start..].join("\n"))
}
