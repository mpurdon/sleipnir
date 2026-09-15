//! Real Engage: resolve each target service's account + role for the
//! requested env/mode, fetch role credentials via `GetRoleCredentials`,
//! seed the per-profile creds cache, deliver static keys into
//! `~/.aws/credentials` (works for every consumer, sandboxed ones
//! included), and record the engagement in `state.json`. Partial failure
//! is first-class — one service failing never blocks the rest.

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::applog;
use crate::config::aws_config_editor::{self, AwsFile, ProfileKeys};
use crate::config::{Account, Env, Mode, OrgConfig};
use crate::discovery::classify_role;
use crate::state::{self, EngagedProfile};
use super::creds_cache::{self, CachedRoleCreds};
use super::sso::{concise_aws_error, is_retryable, send_retrying, sso_client, valid_access_token, DiscoveryError, SsoClient};

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

/// The static-credential key names — the single owner both the write
/// side (engage / rotation) and the strip side (disengage) consume, so
/// they can never disagree.
pub const STATIC_CRED_KEYS: [&str; 3] = ["aws_access_key_id", "aws_secret_access_key", "aws_session_token"];

/// The ~/.aws/credentials stanza for one profile's static keys.
fn static_cred_writes(alias: &str, creds: &CachedRoleCreds) -> ProfileKeys {
    ProfileKeys {
        profile: alias.to_string(),
        keys: vec![
            (STATIC_CRED_KEYS[0].to_string(), creds.access_key_id.clone()),
            (STATIC_CRED_KEYS[1].to_string(), creds.secret_access_key.clone()),
            (STATIC_CRED_KEYS[2].to_string(), creds.session_token.clone()),
        ],
    }
}

/// One `GetRoleCredentials` round-trip mapped into the cache shape — the
/// shared fetch used by engage's fan-out and background rotation.
async fn fetch_role_creds(
    client: &aws_sdk_sso::Client,
    access_token: &str,
    org_name: &str,
    account_id: &str,
    role_name: &str,
    region: &str,
) -> Result<CachedRoleCreds, String> {
    let out = send_retrying(format!("GetRoleCredentials({account_id}/{role_name})"), || {
        client
            .get_role_credentials()
            .access_token(access_token)
            .account_id(account_id)
            .role_name(role_name)
            .send()
    })
    .await
    .map_err(|e| {
        if is_retryable(&e) {
            "AWS rate-limited the request even after retries — try again shortly".to_string()
        } else {
            concise_aws_error(&e)
        }
    })?;
    let Some(c) = out.role_credentials() else {
        return Err("response missing credentials".into());
    };
    Ok(CachedRoleCreds::from_sdk(org_name, account_id, role_name, region, c))
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

/// Why a profile's last credential rotation failed, per alias, cleared the
/// moment one succeeds.
///
/// A rotation that fails is otherwise completely silent: the sweep logs a
/// warning and moves on, the rail keeps showing the service as ENGAGED,
/// and the keys in `~/.aws/credentials` quietly rot until someone runs an
/// `aws` command and gets a wall of SDK error text. A dead SSO session is
/// already visible on the org lamp, but a failure that affects one profile
/// while the session is fine — a renamed permission set, throttling, a
/// network blip mid-sweep — had nowhere to show up at all.
static ROTATION_TROUBLE: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

/// The guarded data is a plain map, so a panic elsewhere poisons nothing
/// worth protecting — recover rather than cascade into the rotation sweep.
fn trouble_map() -> std::sync::MutexGuard<'static, BTreeMap<String, String>> {
    ROTATION_TROUBLE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn note_trouble(alias: &str, message: String) {
    trouble_map().insert(alias.to_string(), message);
}

/// Called on every successful rotation and on disengage — a profile with no
/// entry is a profile with nothing to report.
pub fn clear_trouble(alias: &str) {
    trouble_map().remove(alias);
}

/// Everything sleipnir keeps about a profile outside `state.json` — the
/// cached role credentials and the rotation note — dropped together.
///
/// The two stores were being cleared side by side by hand at every
/// lifecycle site, which is how the rename path came to move one and not
/// the other. One owner means the next store added here is handled
/// everywhere at once instead of needing the same four edits.
pub fn forget_profile(alias: &str) {
    let _ = creds_cache::delete(alias);
    clear_trouble(alias);
}

/// The same pair, carried to a new name.
pub fn rename_profile_data(old_alias: &str, new_alias: &str) {
    let _ = creds_cache::rename(old_alias, new_alias);
    let mut map = trouble_map();
    if let Some(note) = map.remove(old_alias) {
        map.insert(new_alias.to_string(), note);
    }
}

/// A snapshot, so a caller reporting on many profiles takes the lock once
/// rather than once per alias.
pub fn trouble_snapshot() -> BTreeMap<String, String> {
    trouble_map().clone()
}

/// Default rotation margin: engaged profiles whose static keys are within
/// this of expiry get fresh ones (shared by the background tick and the
/// connection test's pre-probe self-heal).
///
/// It has to clear 15 minutes by a comfortable margin. Static keys in
/// `~/.aws/credentials` carry no expiry, so an SDK that reads them invents
/// one: the AWS SDKs' lazy identity cache stamps expiry-less credentials
/// with a 15-minute default lifetime and won't re-read the file until then.
/// Rotate at exactly 15 and a long-lived client can still be holding the
/// previous set when it dies — the 240s sweep means we often replace keys
/// with only ~11 minutes left, inside that client's 15-minute entitlement,
/// which is a guaranteed ExpiredTokenException window once an hour.
/// Rotating while the old keys have a comfortable margin of life left
/// leaves every such consumer holding something still valid.
pub const ROTATE_MARGIN_MS: i64 = SDK_IDENTITY_CACHE_MS + SWEEP_HEADROOM_MS;

/// The lifetime the AWS SDKs invent for credentials that carry no expiry
/// of their own — `DEFAULT_EXPIRATION` in the Smithy lazy identity cache.
///
/// This is the one external fact the rotation schedule is built on, so it
/// is named once and derived from, rather than restated as a number in
/// each place that needs it. A client that resolved static keys may keep
/// using them for this long without re-reading the file.
pub const SDK_IDENTITY_CACHE_MS: i64 = 15 * 60_000;

/// Slack on top, so a rotation is never racing the deadline it exists to
/// beat: enough for several 30s sweeps plus the round trip to fetch.
const SWEEP_HEADROOM_MS: i64 = 10 * 60_000;

/// Rotates static credentials for every listed engaged profile whose
/// cached creds are within `margin_ms` of expiry — the moral equivalent
/// of Leapp's credential rotation. The org-token check is memoized per
/// org (a dead session skips all of that org's profiles at the cost of
/// one check), and every fresh key lands in `~/.aws/credentials` via ONE
/// atomic write. Returns how many profiles rotated.
pub async fn rotate_stale_profiles(entries: &[(String, EngagedProfile)], margin_ms: i64) -> usize {
    use std::collections::HashMap;

    // One pass at a time. Four things ask for a rotation — the 30s tick,
    // the post-login pass, the connection test's pre-probe, and the window
    // coming back into view — and none of them coordinate; overlapping
    // passes would fetch and cache the same aliases twice over. The guard
    // belongs here rather than on any one command, because this is the
    // thing that must not overlap: every caller is covered, and a new
    // trigger costs nothing to add.
    static IN_FLIGHT: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let Ok(_pass) = IN_FLIGHT.get_or_init(Default::default).try_lock() else {
        return 0;
    };

    // Staleness decided once, here, rather than by the caller and again in
    // the loop below — profiles engaged together expire together, so the
    // passes that rotate anything usually touch every profile, and a
    // second predicate over the same files is a second read of all of them.
    let stale: Vec<&(String, EngagedProfile)> =
        entries.iter().filter(|(alias, _)| !creds_cache::fresh_within(alias, margin_ms)).collect();
    if stale.is_empty() {
        return 0;
    }

    // Only now is the org list worth having: `config.toml` carries every
    // org, account and project and is the largest file in play, while the
    // overwhelmingly common pass has nothing due and never gets here.
    let orgs = crate::config::load_or_seed().orgs;
    // Token and client together: both are per-org and per-pass, so one
    // memo covers both. A dead session still costs one check for all of
    // that org's profiles, and a live one now builds a single SDK client —
    // connector, TLS config and connection pool — that every profile on
    // that org reuses. Building it inside the loop meant a fresh pool per
    // stale profile, which the rotation margin makes worse than it sounds:
    // profiles engaged together expire together, so a pass that rotates
    // anything usually rotates several at once.
    let mut org_sessions: HashMap<String, Option<(String, SsoClient)>> = HashMap::new();
    let mut writes: Vec<ProfileKeys> = Vec::new();
    let mut rotated = 0usize;

    for (alias, entry) in stale {
        let Some(org) = orgs.iter().find(|o| o.name == entry.org) else { continue };
        if !org_sessions.contains_key(&entry.org) {
            let session = crate::aws::sso_oidc::ensure_fresh_token(org)
                .await
                .map(|c| (c.access_token, sso_client(&org.region)));
            org_sessions.insert(entry.org.clone(), session);
        }
        let Some((token, client)) = &org_sessions[&entry.org] else {
            // The org lamp already says the session is dead, but the
            // profile's own keys are equally dead and the ENGAGED strip is
            // where the user is looking.
            note_trouble(alias, format!("the SSO session for '{}' has expired — log in again", entry.org));
            continue;
        };
        match fetch_role_creds(client, token, &org.name, &entry.account_id, &entry.role_name, &entry.region).await {
            Ok(creds) => {
                if let Err(e) = creds_cache::write(alias, &creds) {
                    applog::warn(format!("{alias}: creds cache write failed"), &json!({"alias": alias, "error": e.to_string()}));
                    note_trouble(alias, format!("could not cache fresh credentials: {e}"));
                    continue;
                }
                writes.push(static_cred_writes(alias, &creds));
                clear_trouble(alias);
                rotated += 1;
            }
            Err(e) => {
                applog::warn(
                    format!("{alias}: background credential rotation failed"),
                    &json!({"alias": alias, "error": e}),
                );
                note_trouble(alias, e.to_string());
            }
        }
    }

    if !writes.is_empty() {
        if let Err(e) = aws_config_editor::upsert_profiles(AwsFile::Credentials, &writes) {
            applog::error("rotation: credentials write failed", &json!({"error": e.to_string()}));
            // The creds cache was updated per profile above, so without
            // this every one of them now looks fresh while the file still
            // holds the old keys — the self-concealing case. Flagging them
            // is what keeps that visible.
            for w in &writes {
                note_trouble(&w.profile, format!("writing ~/.aws/credentials failed: {e}"));
            }
            return 0;
        }
        applog::info(
            format!("rotated static credentials for {rotated} profile(s)"),
            &json!({"count": rotated}),
        );
    }
    rotated
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

    fn engaged_profile(holders: &[&str]) -> EngagedProfile {
        EngagedProfile {
            org: "t".into(),
            env: Env::Dev,
            mode: Mode::ReadOnly,
            account_id: "111122223333".into(),
            role_name: "ReadOnlyAccess".into(),
            region: "us-east-2".into(),
            project: holders.first().map(|h| h.to_string()),
            held_by_projects: holders.iter().map(|h| h.to_string()).collect(),
            held_adhoc: false,
            engaged_at_unix_ms: 0,
        }
    }

    /// Engage reads state, then spends seconds fetching role credentials.
    /// Anything that committed in that window is in the file but not in
    /// engage's copy, so writing that copy back would roll it away. The
    /// holder is the case that bites: losing one turns a shared profile
    /// into an unshared one, and the next disengage then strips keys that
    /// another project is still using.
    #[test]
    fn a_holder_committed_while_an_engage_was_in_flight_survives_the_merge() {
        let mut fresh = state::AppState::default();
        fresh.engaged.insert("svc".to_string(), engaged_profile(&["beta"]));

        // engage's own view, read before beta existed. `project` names the
        // holder this engage is adding; the holder *set* is stale and gets
        // rebuilt from `fresh`.
        let deltas = vec![StateDelta::Engage { alias: "svc".into(), entry: engaged_profile(&["alpha"]) }];
        apply_deltas(&mut fresh, deltas);

        let merged = &fresh.engaged["svc"];
        assert!(merged.held_by_projects.iter().any(|h| h == "beta"), "concurrent holder was dropped");
        assert!(merged.held_by_projects.iter().any(|h| h == "alpha"), "this engage's holder is missing");
    }

    /// The merge keeps the *fresh* holder set but this engage's env/mode —
    /// those are what the user just asked for and what the keys on disk
    /// actually grant.
    #[test]
    fn the_merge_takes_env_and_mode_from_the_engage_not_the_stale_entry() {
        let mut fresh = state::AppState::default();
        fresh.engaged.insert("svc".to_string(), engaged_profile(&["beta"]));

        let mut entry = engaged_profile(&[]);
        entry.env = Env::Prd;
        entry.mode = Mode::PowerUser;
        apply_deltas(
            &mut fresh,
            vec![StateDelta::Engage { alias: "svc".into(), entry }],
        );

        let merged = &fresh.engaged["svc"];
        assert_eq!(merged.env, Env::Prd);
        assert_eq!(merged.mode, Mode::PowerUser);
        assert!(merged.held_adhoc, "a direct engage must register as a holder");
        assert!(merged.held_by_projects.iter().any(|h| h == "beta"));
    }

    #[test]
    fn a_release_delta_removes_only_its_own_alias() {
        let mut fresh = state::AppState::default();
        fresh.engaged.insert("svc".to_string(), engaged_profile(&["alpha"]));
        fresh.engaged.insert("other".to_string(), engaged_profile(&["alpha"]));
        apply_deltas(&mut fresh, vec![StateDelta::Release { alias: "svc".into() }]);
        assert!(!fresh.engaged.contains_key("svc"));
        assert!(fresh.engaged.contains_key("other"));
    }
}

/// One change `engage` makes to `state.json`, recorded instead of applied.
///
/// Engage reads state, then spends seconds on the network fetching role
/// credentials, then writes. The copy it started from is stale by the time
/// it finishes, so saving that copy wholesale would silently roll back an
/// engage or disengage that completed in the meantime. Replaying deltas
/// onto a freshly-loaded state under the state lock merges with concurrent
/// work instead of overwriting it.
enum StateDelta {
    /// Holder carry-forward is redone at apply time against the *fresh*
    /// entry, so a project that became a holder while this engage was in
    /// flight is not dropped. The new holder is `entry.project`.
    Engage { alias: String, entry: EngagedProfile },
    Release { alias: String },
    LastEngage { key: String, value: state::LastEngage },
}

fn apply_deltas(st: &mut state::AppState, deltas: Vec<StateDelta>) {
    for delta in deltas {
        match delta {
            StateDelta::Engage { alias, mut entry } => {
                let existing = st.engaged.get(&alias);
                entry.held_by_projects = existing.map(|e| e.held_by_projects.clone()).unwrap_or_default();
                entry.held_adhoc = existing.is_some_and(|e| e.held_adhoc);
                let holder = entry.project.clone();
                entry.add_holder(holder.as_deref());
                st.engaged.insert(alias, entry);
            }
            StateDelta::Release { alias } => {
                st.engaged.remove(&alias);
            }
            StateDelta::LastEngage { key, value } => {
                st.last_engage.insert(key, value);
            }
        }
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
    // Read-only: this drives the collision gate below and nothing else.
    // Every mutation is recorded as a delta and replayed onto a fresh read
    // at the end, so this copy going stale during the network work costs
    // nothing.
    let app_state = state::load();
    let mut deltas: Vec<StateDelta> = Vec::new();

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
                match fetch_role_creds(client, access_token, org_name, &target.account_id, &target.role_name, &target.region).await {
                    Ok(creds) => Ok((target, creds)),
                    Err(msg) => {
                        applog::error(
                            format!("{}: GetRoleCredentials failed", target.alias),
                            &json!({"alias": target.alias, "accountId": target.account_id, "roleName": target.role_name, "error": msg}),
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
    let mut config_writes: Vec<ProfileKeys> = Vec::new();
    let mut credential_writes: Vec<ProfileKeys> = Vec::new();
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
                // Static-key delivery: the keys land in ~/.aws/credentials
                // so ANY consumer works — including sandboxed apps that
                // cannot exec a credential_process helper. The config
                // stanza carries region and gets competing credential
                // sources (incl. retired credential_process lines)
                // commented out, since several outrank static keys.
                config_writes.push(ProfileKeys {
                    profile: target.alias.clone(),
                    keys: vec![("region".to_string(), target.region.clone())],
                });
                credential_writes.push(static_cred_writes(&target.alias, &creds));
                let entry = EngagedProfile {
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
                    // Overwritten at apply time against the fresh entry —
                    // see `StateDelta::Engage`.
                    held_by_projects: Vec::new(),
                    held_adhoc: false,
                    engaged_at_unix_ms: now,
                };
                deltas.push(StateDelta::Engage { alias: target.alias.clone(), entry });
                deltas.push(StateDelta::LastEngage {
                    key: format!("service:{}", target.alias),
                    value: state::LastEngage { env: req.env, mode: req.mode, at_unix_ms: now },
                });
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

    // One atomic write per file for everything that succeeded — vpb lines
    // and unmanaged stanzas preserved byte-for-byte by the editor.
    if !succeeded.is_empty() {
        let result = aws_config_editor::upsert_profiles(AwsFile::Config, &config_writes)
            .and_then(|_| aws_config_editor::upsert_profiles(AwsFile::Credentials, &credential_writes));
        if let Err(e) = result {
            // The creds are fetched but files unwritten — fail everything
            // loudly rather than pretend the terminals will work.
            let msg = format!("writing AWS config/credentials failed: {e}");
            applog::error("engage: aws file write failed", &json!({"error": e.to_string()}));
            for row in &succeeded {
                on_progress(&row.alias, "failed", Some(&msg));
                failed.push(FailedRow { alias: row.alias.clone(), message: msg.clone() });
                deltas.push(StateDelta::Release { alias: row.alias.clone() });
            }
            succeeded.clear();
        }
    }

    for row in &succeeded {
        // Fresh keys are on disk, so whatever the last rotation complained
        // about is answered. Without this a profile that failed to rotate
        // keeps its STALE badge after a successful re-engage, until the
        // next sweep happens to clear it.
        clear_trouble(&row.alias);
        on_progress(&row.alias, "done", None);
    }

    if let Some(project) = &req.project {
        if !succeeded.is_empty() {
            deltas.push(StateDelta::LastEngage {
                key: format!("project:{project}"),
                value: state::LastEngage { env: req.env, mode: req.mode, at_unix_ms: now },
            });
        }
    }
    // Merge rather than overwrite, and report the merged state: the UI
    // should see everything engaged right now, not just this run's view.
    let saved_state = match state::update(|fresh| apply_deltas(fresh, deltas)) {
        Ok((_, merged)) => merged,
        Err(e) => {
            applog::error("engage: state.json write failed", &json!({"error": e.to_string()}));
            state::load()
        }
    };

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

    Ok(EngageOutcome { collisions: Vec::new(), succeeded, failed, state: saved_state })
}
