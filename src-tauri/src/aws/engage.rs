//! Real Engage: resolve each target service's account + role for the
//! requested env/mode, fetch role credentials via `GetRoleCredentials`,
//! seed the per-profile creds cache, wire `~/.aws/config` stanzas
//! (`credential_process` delivery), and record the engagement in
//! `state.json`. Partial failure is first-class — one service failing
//! never blocks the rest.

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::applog;
use crate::config::aws_config_editor::{self, ProfileKeys};
use crate::config::{Account, Env, Mode, OrgConfig};
use crate::discovery::classify_role;
use crate::state::{self, EngagedProfile};
use super::creds_cache::{self, CachedRoleCreds};
use super::sso::{concise_aws_error, is_retryable, send_retrying, sso_client, valid_access_token, DiscoveryError};

/// `GetRoleCredentials` fan-out width — same throttling caution as
/// discovery, and engages are usually ≤ a dozen accounts anyway.
const ENGAGE_CONCURRENCY: usize = 3;

pub fn env_label(env: Env) -> &'static str {
    match env {
        Env::Sbx => "SBX",
        Env::Dev => "DEV",
        Env::Stg => "STG",
        Env::Prd => "PRD",
        Env::Global => "GLOBAL",
    }
}

pub fn mode_label(mode: Mode) -> &'static str {
    match mode {
        Mode::ReadOnly => "READONLY",
        Mode::PowerUser => "POWERUSER",
        Mode::Admin => "ADMIN",
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngageRequest {
    pub org_name: String,
    /// Set when a project card/panel drove this engage; None for ad-hoc
    /// single-service engages from the catalog.
    #[serde(default)]
    pub project: Option<String>,
    pub aliases: Vec<String>,
    pub env: Env,
    pub mode: Mode,
    /// Second-pass flag after the UI showed the collision list.
    #[serde(default)]
    pub acknowledge_collisions: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collision {
    pub alias: String,
    pub current: EngagedProfile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngagedRow {
    pub alias: String,
    pub env: Env,
    /// The mode actually engaged — may be lower than requested when the
    /// account lacks the requested mode's role (ADMIN → POWERUSER →
    /// READONLY fallback).
    pub mode: Mode,
    pub role_name: String,
    pub account_id: String,
    /// Set when anything differed from the plain request: a mode
    /// downgrade, or a same-mode alternate role — surfaced as a note, not
    /// a failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedRow {
    pub alias: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngageOutcome {
    /// Non-empty means NOTHING was engaged — the UI must re-invoke with
    /// `acknowledge_collisions` after showing what would be repointed.
    pub collisions: Vec<Collision>,
    pub succeeded: Vec<EngagedRow>,
    pub failed: Vec<FailedRow>,
    /// Post-engage state so the frontend refreshes in one hop.
    pub state: state::AppState,
}

/// One resolved target, ready for `GetRoleCredentials`.
#[derive(Debug)]
struct ResolvedTarget {
    alias: String,
    account_id: String,
    env: Env,
    /// Mode actually resolved — may be below the requested one.
    mode: Mode,
    role_name: String,
    region: String,
    note: Option<String>,
}

/// The graceful-degradation chain: request ADMIN and an account without an
/// admin role engages as POWERUSER, then READONLY — loudly noted, never a
/// silent failure. Requesting low never escalates high.
fn mode_chain(mode: Mode) -> &'static [Mode] {
    match mode {
        Mode::Admin => &[Mode::Admin, Mode::PowerUser, Mode::ReadOnly],
        Mode::PowerUser => &[Mode::PowerUser, Mode::ReadOnly],
        Mode::ReadOnly => &[Mode::ReadOnly],
    }
}

/// Resolves one mode's role on one env-target: explicit per-env override →
/// service-wide preference → best classified candidate (shortest = least
/// specialized). The bool marks "an alternate role, not the preference".
fn role_for_mode(account: &Account, target: &crate::config::EnvTarget, mode: Mode) -> Option<(String, bool)> {
    let preferred = target.role_overrides.get(&mode).or_else(|| account.roles.get(&mode));
    if target.available_roles.is_empty() {
        // Imported without role data (manual escape hatch) — trust the
        // preference blindly.
        return preferred.map(|r| (r.clone(), false));
    }
    if let Some(r) = preferred.filter(|r| target.available_roles.contains(r)) {
        return Some((r.clone(), false));
    }
    let mut candidates: Vec<&String> = target
        .available_roles
        .iter()
        .filter(|r| classify_role(r) == Some(mode))
        .collect();
    candidates.sort_by_key(|r| (r.len(), r.as_str()));
    candidates.first().map(|r| ((*r).clone(), true))
}

/// Picks the effective env + mode + role for one account, or explains why
/// it can't be engaged at all.
fn resolve_target(account: &Account, env: Env, mode: Mode, default_region: &str) -> Result<ResolvedTarget, String> {
    // Standalone services only have a `global` target; engaging them under
    // any requested env transparently uses it.
    let (effective_env, target) = match account.environments.get(&env) {
        Some(t) => (env, t),
        None => match account.environments.get(&Env::Global) {
            Some(t) if account.environments.len() == 1 => (Env::Global, t),
            _ => {
                let available: Vec<&str> = account.environments.keys().map(|e| env_label(*e)).collect();
                return Err(format!(
                    "no {} account for this service (has: {})",
                    env_label(env),
                    available.join(", ")
                ));
            }
        },
    };

    for &m in mode_chain(mode) {
        if let Some((role_name, via_alternate)) = role_for_mode(account, target, m) {
            let note = if m != mode {
                Some(format!(
                    "no {} on {} — fell back to {} ({role_name})",
                    mode_label(mode),
                    env_label(effective_env),
                    mode_label(m)
                ))
            } else if via_alternate {
                Some(format!("used {role_name}"))
            } else {
                None
            };
            return Ok(ResolvedTarget {
                alias: account.alias.clone(),
                account_id: target.account_id.clone(),
                env: effective_env,
                mode: m,
                role_name,
                // Defensive lowercase — an uppercased region in config
                // poisons SigV4 signatures for every credential downstream.
                region: target
                    .region
                    .clone()
                    .unwrap_or_else(|| default_region.to_string())
                    .trim()
                    .to_lowercase(),
                note,
            });
        }
    }

    Err(format!(
        "no {} (or lower) role on {} — available: {}",
        mode_label(mode),
        env_label(effective_env),
        if target.available_roles.is_empty() { "none recorded".to_string() } else { target.available_roles.join(", ") }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::EnvTarget;
    use std::collections::HashMap;

    fn account(available: &[&str]) -> Account {
        let mut environments = HashMap::new();
        environments.insert(
            Env::Prd,
            EnvTarget {
                account_id: "111122223333".into(),
                account_name: "Svc Production".into(),
                region: None,
                available_roles: available.iter().map(|s| s.to_string()).collect(),
                role_overrides: HashMap::new(),
            },
        );
        let mut roles = HashMap::new();
        roles.insert(Mode::PowerUser, "PowerUserAccess".to_string());
        roles.insert(Mode::ReadOnly, "ReadOnlyAccess".to_string());
        Account { alias: "svc".into(), display_name: "Svc".into(), org: "t".into(), environments, roles }
    }

    #[test]
    fn admin_request_falls_back_to_poweruser_then_readonly() {
        let a = account(&["PowerUserAccess", "ReadOnlyAccess"]);
        let r = resolve_target(&a, Env::Prd, Mode::Admin, "us-east-2").unwrap();
        assert_eq!(r.mode, Mode::PowerUser);
        assert_eq!(r.role_name, "PowerUserAccess");
        assert!(r.note.as_deref().unwrap().contains("fell back to POWERUSER"));

        let a = account(&["ReadOnlyAccess"]);
        let r = resolve_target(&a, Env::Prd, Mode::Admin, "us-east-2").unwrap();
        assert_eq!(r.mode, Mode::ReadOnly);
        assert!(r.note.as_deref().unwrap().contains("fell back to READONLY"));
    }

    #[test]
    fn readonly_request_never_escalates() {
        let a = account(&["AdministratorAccess", "PowerUserAccess"]);
        let err = resolve_target(&a, Env::Prd, Mode::ReadOnly, "us-east-2").unwrap_err();
        assert!(err.contains("no READONLY"));
    }

    #[test]
    fn exact_match_carries_no_note() {
        let a = account(&["PowerUserAccess", "ReadOnlyAccess"]);
        let r = resolve_target(&a, Env::Prd, Mode::PowerUser, "us-east-2").unwrap();
        assert_eq!(r.mode, Mode::PowerUser);
        assert!(r.note.is_none());
    }
}

/// Runs the full engage. Assumes the org's SSO token is already valid —
/// the command layer handles the login-chaining detour before calling
/// this. `on_progress(alias, status, message)` fires per row with status
/// "assuming" | "done" | "failed".
pub async fn engage(
    org: &OrgConfig,
    accounts: &[Account],
    req: &EngageRequest,
    on_progress: impl Fn(&str, &str, Option<&str>) + Send + Sync,
) -> Result<EngageOutcome, DiscoveryError> {
    let mut app_state = state::load();

    // Cross-project collision gate: engaging a profile that is currently
    // engaged with a DIFFERENT env/mode silently repoints every terminal
    // already using it. Surface that before writing anything.
    if !req.acknowledge_collisions {
        let collisions: Vec<Collision> = req
            .aliases
            .iter()
            .filter_map(|alias| {
                let current = app_state.engaged.get(alias)?;
                let repoints = current.env != req.env || current.mode != req.mode;
                repoints.then(|| Collision { alias: alias.clone(), current: current.clone() })
            })
            .collect();
        if !collisions.is_empty() {
            applog::warn(
                format!("engage blocked by {} collision(s) — awaiting acknowledgement", collisions.len()),
                &json!({"collisions": collisions.iter().map(|c| c.alias.as_str()).collect::<Vec<_>>()}),
            );
            return Ok(EngageOutcome { collisions, succeeded: Vec::new(), failed: Vec::new(), state: app_state });
        }
    }

    let access_token = valid_access_token(&org.name)?;
    let client = sso_client(&org.region);
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "sleipnir".to_string());

    // Resolve everything up front; unresolvable rows fail immediately with
    // a per-row explanation and never hit the network.
    let mut resolved: Vec<ResolvedTarget> = Vec::new();
    let mut failed: Vec<FailedRow> = Vec::new();
    for alias in &req.aliases {
        let Some(account) = accounts.iter().find(|a| &a.alias == alias) else {
            failed.push(FailedRow { alias: alias.clone(), message: "unknown service".into() });
            on_progress(alias, "failed", Some("unknown service"));
            continue;
        };
        match resolve_target(account, req.env, req.mode, &org.region) {
            Ok(t) => resolved.push(t),
            Err(message) => {
                on_progress(alias, "failed", Some(&message));
                failed.push(FailedRow { alias: alias.clone(), message });
            }
        }
    }

    // Fan out GetRoleCredentials.
    let fetches: Vec<Result<(ResolvedTarget, CachedRoleCreds), FailedRow>> = stream::iter(resolved.into_iter())
        .map(|target| {
            let client = &client;
            let access_token = &access_token;
            let org_name = org.name.as_str();
            let on_progress = &on_progress;
            async move {
                on_progress(&target.alias, "assuming", None);
                let result = send_retrying(format!("GetRoleCredentials({})", target.alias), || {
                    client
                        .get_role_credentials()
                        .access_token(access_token)
                        .account_id(&target.account_id)
                        .role_name(&target.role_name)
                        .send()
                })
                .await;

                match result {
                    Ok(out) => {
                        let Some(c) = out.role_credentials() else {
                            let msg = "response missing credentials".to_string();
                            on_progress(&target.alias, "failed", Some(&msg));
                            return Err(FailedRow { alias: target.alias.clone(), message: msg });
                        };
                        let creds = CachedRoleCreds {
                            org: org_name.to_string(),
                            account_id: target.account_id.clone(),
                            role_name: target.role_name.clone(),
                            region: target.region.clone(),
                            access_key_id: c.access_key_id().unwrap_or_default().to_string(),
                            secret_access_key: c.secret_access_key().unwrap_or_default().to_string(),
                            session_token: c.session_token().unwrap_or_default().to_string(),
                            expiration_unix_ms: c.expiration(),
                        };
                        Ok((target, creds))
                    }
                    Err(e) => {
                        let msg = if is_retryable(&e) {
                            "AWS rate-limited the request even after retries — try again shortly".to_string()
                        } else {
                            concise_aws_error(&e)
                        };
                        applog::error(
                            format!("{}: GetRoleCredentials failed", target.alias),
                            &json!({"alias": target.alias, "accountId": target.account_id, "roleName": target.role_name, "awsError": format!("{e:?}")}),
                        );
                        on_progress(&target.alias, "failed", Some(&msg));
                        Err(FailedRow { alias: target.alias.clone(), message: msg })
                    }
                }
            }
        })
        .buffer_unordered(ENGAGE_CONCURRENCY)
        .collect()
        .await;

    let mut succeeded: Vec<EngagedRow> = Vec::new();
    let mut profile_writes: Vec<ProfileKeys> = Vec::new();
    let now = state::now_unix_ms();

    for fetch in fetches {
        match fetch {
            Err(row) => failed.push(row),
            Ok((target, creds)) => {
                if let Err(e) = creds_cache::write(&target.alias, &creds) {
                    let msg = format!("writing credential cache: {e}");
                    on_progress(&target.alias, "failed", Some(&msg));
                    failed.push(FailedRow { alias: target.alias.clone(), message: msg });
                    continue;
                }
                profile_writes.push(ProfileKeys {
                    profile: target.alias.clone(),
                    keys: vec![
                        ("credential_process".to_string(), format!("\"{exe}\" creds --profile {}", target.alias)),
                        ("region".to_string(), target.region.clone()),
                    ],
                });
                app_state.engaged.insert(
                    target.alias.clone(),
                    EngagedProfile {
                        org: org.name.clone(),
                        env: target.env,
                        // The mode actually granted, not the one asked
                        // for — the ENGAGED strip must never claim ADMIN
                        // where the fallback delivered READONLY.
                        mode: target.mode,
                        account_id: target.account_id.clone(),
                        role_name: target.role_name.clone(),
                        region: target.region.clone(),
                        project: req.project.clone(),
                        engaged_at_unix_ms: now,
                    },
                );
                app_state.last_engage.insert(
                    format!("service:{}", target.alias),
                    state::LastEngage { env: req.env, mode: req.mode, at_unix_ms: now },
                );
                succeeded.push(EngagedRow {
                    alias: target.alias.clone(),
                    env: target.env,
                    mode: target.mode,
                    role_name: target.role_name,
                    account_id: target.account_id,
                    note: target.note,
                });
            }
        }
    }

    // One atomic ~/.aws/config write for everything that succeeded — vpb
    // lines and unmanaged stanzas preserved byte-for-byte by the editor.
    if !profile_writes.is_empty() {
        if let Err(e) = aws_config_editor::upsert_profiles(&aws_config_editor::default_path(), &profile_writes) {
            // The creds are fetched but profiles unwritten — fail everything
            // loudly rather than pretend the terminals will work.
            let msg = format!("writing ~/.aws/config failed: {e}");
            applog::error("engage: aws config write failed", &json!({"error": e.to_string()}));
            for row in &succeeded {
                on_progress(&row.alias, "failed", Some(&msg));
                failed.push(FailedRow { alias: row.alias.clone(), message: msg.clone() });
                app_state.engaged.remove(&row.alias);
            }
            succeeded.clear();
        }
    }

    for row in &succeeded {
        on_progress(&row.alias, "done", None);
    }

    if let Some(project) = &req.project {
        if !succeeded.is_empty() {
            app_state
                .last_engage
                .insert(format!("project:{project}"), state::LastEngage { env: req.env, mode: req.mode, at_unix_ms: now });
        }
    }
    if let Err(e) = state::save(&app_state) {
        applog::error("engage: state.json write failed", &json!({"error": e.to_string()}));
    }

    applog::info(
        format!(
            "engage {} {}/{}: {} succeeded, {} failed",
            req.project.as_deref().unwrap_or("(ad-hoc)"),
            env_label(req.env),
            mode_label(req.mode),
            succeeded.len(),
            failed.len()
        ),
        &json!({
            "org": org.name,
            "project": req.project,
            "env": env_label(req.env),
            "mode": mode_label(req.mode),
            "succeeded": succeeded.iter().map(|s| s.alias.as_str()).collect::<Vec<_>>(),
            "failed": failed,
        }),
    );

    Ok(EngageOutcome { collisions: Vec::new(), succeeded, failed, state: app_state })
}
