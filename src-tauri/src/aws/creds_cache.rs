//! Per-profile role-credential cache — `~/.sleipnir/cache/creds-<alias>.json`,
//! written 0600. Shared between the engage flow (which seeds it) and the
//! headless `sleipnir creds` resolver (which reads it and silently
//! re-fetches when the STS credentials expire).

use serde::{Deserialize, Serialize};
use std::io;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedRoleCreds {
    pub org: String,
    pub account_id: String,
    pub role_name: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: String,
    /// Milliseconds since epoch, straight from `GetRoleCredentials`.
    pub expiration_unix_ms: i64,
}

impl CachedRoleCreds {
    /// The one place the SDK response maps into the cache shape — engage,
    /// background rotation, and the CLI resolver all build through here.
    pub fn from_sdk(
        org: &str,
        account_id: &str,
        role_name: &str,
        region: &str,
        c: &aws_sdk_sso::types::RoleCredentials,
    ) -> Self {
        Self {
            org: org.to_string(),
            account_id: account_id.to_string(),
            role_name: role_name.to_string(),
            region: region.to_string(),
            access_key_id: c.access_key_id().unwrap_or_default().to_string(),
            secret_access_key: c.secret_access_key().unwrap_or_default().to_string(),
            session_token: c.session_token().unwrap_or_default().to_string(),
            expiration_unix_ms: c.expiration(),
        }
    }
}

/// Just the expiry, without materialising the secret material around it.
///
/// Both hot paths — the rotation sweep's staleness check and the UI's
/// health poll — want one integer, and `read` would allocate seven
/// `String`s to hand it over, the largest being a ~1KB session token.
/// Serde skips every other field without allocating.
pub fn expiry_unix_ms(alias: &str) -> Option<i64> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExpiryOnly {
        expiration_unix_ms: i64,
    }
    let contents = std::fs::read_to_string(path(alias)).ok()?;
    let parsed: ExpiryOnly = serde_json::from_str(&contents).ok()?;
    Some(parsed.expiration_unix_ms)
}

/// True when the cached creds exist and won't expire within `margin_ms`.
/// Missing/unreadable cache counts as NOT fresh.
pub fn fresh_within(alias: &str, margin_ms: i64) -> bool {
    expiry_unix_ms(alias)
        .map(|at| at > crate::state::now_unix_ms() as i64 + margin_ms)
        .unwrap_or(false)
}

fn cache_dir() -> PathBuf {
    crate::paths::data_dir().join("cache")
}

fn path(alias: &str) -> PathBuf {
    cache_dir().join(format!("creds-{alias}.json"))
}

pub fn read(alias: &str) -> Option<CachedRoleCreds> {
    let contents = std::fs::read_to_string(path(alias)).ok()?;
    serde_json::from_str(&contents).ok()
}

pub fn write(alias: &str, creds: &CachedRoleCreds) -> io::Result<()> {
    let json = serde_json::to_string_pretty(creds).expect("serialize cached role creds");
    crate::atomic_file::write_private(&path(alias), &json)
}

/// Carries the cached creds along with a profile rename. Missing source is
/// fine (nothing cached yet).
pub fn rename(old_alias: &str, new_alias: &str) -> io::Result<()> {
    match std::fs::rename(path(old_alias), path(new_alias)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Missing file is fine — disengaging something already gone is a no-op.
pub fn delete(alias: &str) -> io::Result<()> {
    match std::fs::remove_file(path(alias)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
