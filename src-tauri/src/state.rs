//! Runtime state — `~/.sleipnir/state.json`. Deliberately separate from
//! `config.toml`: config is declarative and shareable, state is this
//! machine's session memory (what's engaged right now, what was engaged
//! last, which projects are pinned).
//!
//! The `engaged` map is the authority for the headless `sleipnir creds`
//! resolver: a profile not present here refuses to resolve even though its
//! `~/.aws/config` stanza remains — that's what makes DISENGAGE a real
//! stand-down action instead of cosmetic UI.

use crate::config::{Env, Mode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    /// Pinned project names — pinned cards sort first with stable positions
    /// (pure recency churns muscle memory).
    #[serde(default)]
    pub pins: Vec<String>,
    /// Keyed `"project:<name>"` or `"service:<alias>"` — remembers the last
    /// env/mode used so re-engage is one click.
    #[serde(default)]
    pub last_engage: HashMap<String, LastEngage>,
    /// Profile alias → live engagement. Authority for `sleipnir creds`.
    #[serde(default)]
    pub engaged: HashMap<String, EngagedProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastEngage {
    pub env: Env,
    pub mode: Mode,
    pub at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngagedProfile {
    pub org: String,
    pub env: Env,
    pub mode: Mode,
    pub account_id: String,
    pub role_name: String,
    pub region: String,
    /// Which project drove this engage, when it wasn't ad-hoc — used by the
    /// cross-project collision warning ("currently STG via Project X").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub engaged_at_unix_ms: u64,
}

fn state_path() -> PathBuf {
    dirs::home_dir().expect("home directory").join(".sleipnir").join("state.json")
}

pub fn now_unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

pub fn load() -> AppState {
    let Ok(contents) = std::fs::read_to_string(state_path()) else {
        return AppState::default();
    };
    serde_json::from_str(&contents).unwrap_or_else(|e| {
        log::warn!("state.json failed to parse ({e}) — starting fresh");
        AppState::default()
    })
}

pub fn save(state: &AppState) -> std::io::Result<()> {
    let path = state_path();
    std::fs::create_dir_all(path.parent().unwrap())?;
    let json = serde_json::to_string_pretty(state).expect("serialize app state");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, path)
}
