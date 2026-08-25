//! Thin wrapper over the `keyring` crate (macOS Keychain / Windows
//! Credential Manager). Holds only the OIDC client registration and any SSO
//! refresh token — the access token itself stays in the plaintext
//! AWS-CLI-compatible cache (see `aws::token_cache`), deliberately matching
//! AWS CLI's own security model since sleipnir must read/write that exact
//! file for interop anyway.

use keyring::Entry;
use std::time::{SystemTime, UNIX_EPOCH};

const SERVICE: &str = "dev.purdonmoi.sleipnir";

fn entry(kind: &str, org: &str) -> Result<Entry, keyring::Error> {
    Entry::new(SERVICE, &format!("{kind}:{org}"))
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

pub struct ClientRegistration {
    pub client_id: String,
    pub client_secret: String,
    /// Unix seconds. Registrations last ~90 days — cached so login doesn't
    /// re-register every time.
    pub expires_at: i64,
}

pub fn store_client_registration(org: &str, reg: &ClientRegistration) -> Result<(), keyring::Error> {
    entry("client_id", org)?.set_password(&reg.client_id)?;
    entry("client_secret", org)?.set_password(&reg.client_secret)?;
    entry("client_reg_expires_at", org)?.set_password(&reg.expires_at.to_string())?;
    Ok(())
}

/// Returns `None` if nothing is cached, or if it's within 5 minutes of
/// expiring (safety margin rather than racing a registration that just
/// expired).
///
/// Verified quirk (keyring-rs 3.6.3, macOS `apple-native` backend, which
/// uses the legacy `SecKeychain` API rather than `SecItem`): a `get_password`
/// on a freshly constructed `Entry` can miss an item that a *different*
/// `Entry` instance wrote moments earlier in the same process, even past a
/// several-hundred-ms delay — read-your-writes only reliably holds when the
/// same `Entry` instance is reused. That does not affect correctness here
/// (`get_or_register_client` uses the freshly registered value directly
/// rather than reading it back), only the "skip re-registration" optimation:
/// it may occasionally miss within one long-running process and re-register
/// with AWS, which is harmless — SSO OIDC client registration has no
/// meaningful rate limit for normal interactive use.
pub fn load_client_registration(org: &str) -> Option<ClientRegistration> {
    let client_id = entry("client_id", org).ok()?.get_password().ok()?;
    let client_secret = entry("client_secret", org).ok()?.get_password().ok()?;
    let expires_at: i64 = entry("client_reg_expires_at", org).ok()?.get_password().ok()?.parse().ok()?;
    if expires_at - 300 < now_unix() {
        return None;
    }
    Some(ClientRegistration { client_id, client_secret, expires_at })
}

pub fn store_refresh_token(org: &str, token: &str) -> Result<(), keyring::Error> {
    entry("refresh_token", org)?.set_password(token)
}

pub fn load_refresh_token(org: &str) -> Option<String> {
    entry("refresh_token", org).ok()?.get_password().ok()
}

/// Removes every keyring entry for an Org — client registration and any
/// refresh token. Used by sign-out. Missing entries are not an error.
pub fn clear_org(org: &str) {
    for kind in ["client_id", "client_secret", "client_reg_expires_at", "refresh_token"] {
        let _ = entry(kind, org).and_then(|e| e.delete_credential());
    }
}
