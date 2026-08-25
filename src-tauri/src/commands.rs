use crate::applog;
use crate::aws::{creds_cache, engage, sso, sso_oidc, token_cache};
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
pub fn save_org(org: OrgConfig) -> Result<Vec<OrgStatus>, AppError> {
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
        Ok(_) => Ok(status_for(&org)),
        Err(e) => {
            let app_err: AppError = e.into();
            applog::error("login_org failed", &json!({"name": name, "error": app_err.to_string()}));
            Err(app_err)
        }
    }
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

/// Stand-down: removes profiles from the engaged map (the authority the
/// creds resolver honors) and deletes their cached role credentials. The
/// `~/.aws/config` stanzas stay — a disengaged profile simply refuses to
/// resolve until re-engaged.
#[tauri::command]
pub fn disengage(profiles: Vec<String>) -> Result<state::AppState, AppError> {
    let mut st = state::load();
    for p in &profiles {
        st.engaged.remove(p);
        let _ = creds_cache::delete(p);
    }
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
    st.engaged.clear();
    state::save(&st)?;
    applog::info(format!("disengaged ALL ({} profile(s))", profiles.len()), &json!({"profiles": profiles}));
    Ok(st)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub config_path: String,
    pub log_dir: String,
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
    entries.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());

    let Some(latest) = entries.last() else { return Ok(String::new()) };
    let contents = std::fs::read_to_string(latest.path())?;
    let max_lines = max_lines.unwrap_or(2000);
    let lines: Vec<&str> = contents.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    Ok(lines[start..].join("\n"))
}
