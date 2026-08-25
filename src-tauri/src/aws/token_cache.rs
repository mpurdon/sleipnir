//! Reads/writes the exact `~/.aws/sso/cache/<sha1>.json` format the AWS
//! CLI/botocore use, for interop — a token from `aws sso login` should just
//! work in sleipnir and vice versa.
//!
//! The sha1-of-session-name derivation is verified, not guessed: it was
//! checked against a real machine's cache, where `sha1(<session name>)`
//! equals the filename of the entry written by `aws sso login` for the
//! matching `[sso-session <name>]` profile. sleipnir always writes the
//! modern `sso-session`-keyed form, never the legacy per-profile
//! `sha1(start_url)` form.

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedToken {
    #[serde(rename = "startUrl")]
    pub start_url: String,
    pub region: String,
    #[serde(rename = "accessToken")]
    pub access_token: String,
    /// RFC3339, matching botocore's own formatting.
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    #[serde(rename = "refreshToken", skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

fn cache_dir() -> PathBuf {
    dirs::home_dir()
        .expect("home directory")
        .join(".aws")
        .join("sso")
        .join("cache")
}

fn cache_path(org_name: &str) -> PathBuf {
    let mut hasher = Sha1::new();
    hasher.update(org_name.as_bytes());
    let hash = hex::encode(hasher.finalize());
    cache_dir().join(format!("{hash}.json"))
}

pub fn read(org_name: &str) -> Option<CachedToken> {
    let contents = std::fs::read_to_string(cache_path(org_name)).ok()?;
    serde_json::from_str(&contents).ok()
}

/// Removes the cached token file, if present. Used by sign-out — a missing
/// file is not an error, it's just already signed out.
pub fn delete(org_name: &str) -> std::io::Result<()> {
    match std::fs::remove_file(cache_path(org_name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// sleipnir deliberately does NOT persist the refresh token in this file
/// (unlike botocore) — it lives in the keyring instead. This means a token
/// this app minted can't be silently refreshed by a bare `aws` CLI call
/// past expiry; the tradeoff is intentional (see the plan's §5).
pub fn write(org_name: &str, token: &CachedToken) -> std::io::Result<()> {
    let mut token = token.clone();
    token.refresh_token = None;

    let dir = cache_dir();
    std::fs::create_dir_all(&dir)?;
    let path = cache_path(org_name);
    let json = serde_json::to_string_pretty(&token).expect("serialize cached token");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}
