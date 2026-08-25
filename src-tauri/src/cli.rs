//! Headless `sleipnir creds --profile <name>` resolver, invoked by AWS
//! CLI/SDKs via `credential_process`. Prints the standard v1 JSON contract
//! to stdout and nothing else on success; on any failure it prints a
//! human-actionable message to stderr and exits non-zero.
//!
//! The `engaged` map in `~/.sleipnir/state.json` is the authority: a
//! profile that isn't currently engaged refuses to resolve even though its
//! `~/.aws/config` stanza remains — DISENGAGE in the app is a real
//! stand-down, not cosmetics. Fresh STS credentials are re-fetched
//! silently via the cached SSO token when the cached ones expire; only an
//! expired SSO session itself needs the user to open the app.

use crate::aws::creds_cache::{self, CachedRoleCreds};
use crate::aws::{sso, sso_oidc};
use crate::state;

/// Refresh when the cached STS creds have less than this left, so a
/// long-running command started right at the edge doesn't die mid-flight.
const REFRESH_MARGIN_MS: i64 = 120_000;

pub fn run_creds(args: &[String]) {
    let profile = match parse_profile(args) {
        Some(p) => p,
        None => {
            eprintln!("usage: sleipnir creds --profile <name>");
            std::process::exit(2);
        }
    };

    match resolve(&profile) {
        Ok(json) => println!("{json}"),
        Err(message) => {
            eprintln!("sleipnir creds: {message}");
            std::process::exit(1);
        }
    }
}

fn parse_profile(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--profile" {
            return iter.next().cloned();
        }
        if let Some(v) = arg.strip_prefix("--profile=") {
            return Some(v.to_string());
        }
    }
    None
}

/// The credential_process v1 output contract.
fn render(creds: &CachedRoleCreds) -> String {
    serde_json::json!({
        "Version": 1,
        "AccessKeyId": creds.access_key_id,
        "SecretAccessKey": creds.secret_access_key,
        "SessionToken": creds.session_token,
        "Expiration": sso_oidc::chrono_free_rfc3339(creds.expiration_unix_ms / 1000),
    })
    .to_string()
}

fn resolve(profile: &str) -> Result<String, String> {
    let app_state = state::load();
    let Some(entry) = app_state.engaged.get(profile) else {
        return Err(format!(
            "profile '{profile}' is not engaged — open sleipnir and engage it (its config stanza stays; engagement is the on-switch)"
        ));
    };

    let now_ms = state::now_unix_ms() as i64;
    if let Some(cached) = creds_cache::read(profile) {
        if cached.expiration_unix_ms > now_ms + REFRESH_MARGIN_MS {
            return Ok(render(&cached));
        }
    }

    // Cached STS creds are stale — silently re-fetch with the SSO token,
    // itself silently refreshed via the keyring refresh token when the
    // 1-hour access token has lapsed. Only a dead SSO session (refresh
    // token expired/revoked) needs the user to open the app.
    let org_cfg = crate::config::load_or_seed()
        .orgs
        .into_iter()
        .find(|o| o.name == entry.org)
        .ok_or_else(|| format!("org '{}' is no longer configured in sleipnir", entry.org))?;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("starting async runtime: {e}"))?;

    let token = rt
        .block_on(sso_oidc::ensure_fresh_token(&org_cfg))
        .ok_or_else(|| format!("the SSO session for org '{}' has expired — open sleipnir and log in", entry.org))?;

    let client = sso::sso_client(&token.region);
    let result = rt.block_on(async {
        client
            .get_role_credentials()
            .access_token(&token.access_token)
            .account_id(&entry.account_id)
            .role_name(&entry.role_name)
            .send()
            .await
    });

    let out = result.map_err(|e| format!("refreshing credentials failed — {}", sso::concise_aws_error(&e)))?;
    let c = out.role_credentials().ok_or("refresh response missing credentials")?;
    let fresh = CachedRoleCreds {
        org: entry.org.clone(),
        account_id: entry.account_id.clone(),
        role_name: entry.role_name.clone(),
        region: entry.region.clone(),
        access_key_id: c.access_key_id().unwrap_or_default().to_string(),
        secret_access_key: c.secret_access_key().unwrap_or_default().to_string(),
        session_token: c.session_token().unwrap_or_default().to_string(),
        expiration_unix_ms: c.expiration(),
    };
    // Best-effort cache write — resolution still succeeds if the disk write
    // doesn't.
    let _ = creds_cache::write(profile, &fresh);
    Ok(render(&fresh))
}
