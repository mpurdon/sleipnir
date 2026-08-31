//! Thin wrapper over the `keyring` crate (macOS Keychain / Windows
//! Credential Manager). Holds only the OIDC client registration and any SSO
//! refresh token — the access token itself stays in the plaintext
//! AWS-CLI-compatible cache (see `aws::token_cache`), deliberately matching
//! AWS CLI's own security model since sleipnir must read/write that exact
//! file for interop anyway.
//!
//! Everything lives in ONE keychain item per org (a JSON blob) — macOS
//! shows an access prompt per item, so the earlier four-items-per-org
//! layout meant four password prompts in a row. Legacy four-item entries
//! are migrated into the blob on first read, then deleted.

use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::paths::keychain_service as service;
const LEGACY_KINDS: [&str; 4] = ["client_id", "client_secret", "client_reg_expires_at", "refresh_token"];

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretBlob {
    client_id: Option<String>,
    client_secret: Option<String>,
    client_reg_expires_at: Option<i64>,
    refresh_token: Option<String>,
}

fn blob_entry(org: &str) -> Result<Entry, keyring::Error> {
    Entry::new(service(), &format!("secrets:{org}"))
}

fn load_blob(org: &str) -> SecretBlob {
    if let Ok(entry) = blob_entry(org) {
        if let Ok(json) = entry.get_password() {
            if let Ok(blob) = serde_json::from_str(&json) {
                return blob;
            }
        }
    }
    migrate_legacy(org)
}

fn save_blob(org: &str, blob: &SecretBlob) -> Result<(), keyring::Error> {
    blob_entry(org)?.set_password(&serde_json::to_string(blob).expect("serialize secret blob"))
}

/// One-time migration from the old four-items-per-org layout. Reading the
/// legacy items may prompt once more; after this they're gone and only the
/// single blob item remains.
fn migrate_legacy(org: &str) -> SecretBlob {
    let get = |kind: &str| {
        Entry::new(service(), &format!("{kind}:{org}"))
            .ok()
            .and_then(|e| e.get_password().ok())
    };
    let blob = SecretBlob {
        client_id: get("client_id"),
        client_secret: get("client_secret"),
        client_reg_expires_at: get("client_reg_expires_at").and_then(|s| s.parse().ok()),
        refresh_token: get("refresh_token"),
    };
    if blob.client_id.is_some() || blob.refresh_token.is_some() {
        let _ = save_blob(org, &blob);
        for kind in LEGACY_KINDS {
            let _ = Entry::new(service(), &format!("{kind}:{org}")).and_then(|e| e.delete_credential());
        }
    }
    blob
}

pub struct ClientRegistration {
    pub client_id: String,
    pub client_secret: String,
    /// Unix seconds. Registrations last ~90 days — cached so login doesn't
    /// re-register every time.
    pub expires_at: i64,
}

pub fn store_client_registration(org: &str, reg: &ClientRegistration) -> Result<(), keyring::Error> {
    let mut blob = load_blob(org);
    blob.client_id = Some(reg.client_id.clone());
    blob.client_secret = Some(reg.client_secret.clone());
    blob.client_reg_expires_at = Some(reg.expires_at);
    save_blob(org, &blob)
}

/// Returns `None` if nothing is cached, or if it's within 5 minutes of
/// expiring (safety margin rather than racing a registration that just
/// expired).
pub fn load_client_registration(org: &str) -> Option<ClientRegistration> {
    let blob = load_blob(org);
    let expires_at = blob.client_reg_expires_at?;
    if expires_at - 300 < now_unix() {
        return None;
    }
    Some(ClientRegistration {
        client_id: blob.client_id?,
        client_secret: blob.client_secret?,
        expires_at,
    })
}

pub fn store_refresh_token(org: &str, token: &str) -> Result<(), keyring::Error> {
    let mut blob = load_blob(org);
    blob.refresh_token = Some(token.to_string());
    save_blob(org, &blob)
}

pub fn load_refresh_token(org: &str) -> Option<String> {
    load_blob(org).refresh_token
}

/// Removes every keyring entry for an Org — the blob plus any legacy
/// items. Used by sign-out. Missing entries are not an error.
pub fn clear_org(org: &str) {
    let _ = blob_entry(org).and_then(|e| e.delete_credential());
    for kind in LEGACY_KINDS {
        let _ = Entry::new(service(), &format!("{kind}:{org}")).and_then(|e| e.delete_credential());
    }
}
