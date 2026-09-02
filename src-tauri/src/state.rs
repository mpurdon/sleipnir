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
    /// Which project drove the most recent engage, when it wasn't ad-hoc.
    /// Drives rail grouping and the collision warning ("currently STG via
    /// Project X"). With several holders this is only the latest of them —
    /// `held_by_projects` is the authority on who still needs the profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Every project currently relying on this profile.
    ///
    /// A profile is one AWS profile with one set of keys, so two projects
    /// sharing a service share the engagement rather than each getting
    /// their own. Without this, disengaging one project stripped keys the
    /// other was still using, with no warning and no way to notice until
    /// something failed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub held_by_projects: Vec<String>,
    /// Whether a direct, non-project engage also holds it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub held_adhoc: bool,
    pub engaged_at_unix_ms: u64,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl EngagedProfile {
    /// Fills in holders for a state file written before they existed.
    ///
    /// Such an entry records only which project engaged last. Treating it
    /// as unheld would be the dangerous reading — the first disengage would
    /// consider the profile free and strip keys that are genuinely in use —
    /// so the recorded project (or ad-hoc) becomes the single holder.
    pub fn backfill_holders(&mut self) {
        if self.held_by_projects.is_empty() && !self.held_adhoc {
            match &self.project {
                Some(p) => self.held_by_projects.push(p.clone()),
                None => self.held_adhoc = true,
            }
        }
    }

    /// Records another reason this profile is engaged. `None` is a direct
    /// engage from the service row.
    pub fn add_holder(&mut self, project: Option<&str>) {
        match project {
            Some(p) => {
                if !self.held_by_projects.iter().any(|h| h == p) {
                    self.held_by_projects.push(p.to_string());
                }
            }
            None => self.held_adhoc = true,
        }
    }

    /// Drops one reason. Returns true when nothing needs the profile any
    /// more and its keys can be stripped.
    pub fn release_holder(&mut self, project: Option<&str>) -> bool {
        match project {
            Some(p) => self.held_by_projects.retain(|h| h != p),
            None => self.held_adhoc = false,
        }
        // Attribution follows the remaining holders, so the rail never
        // groups a profile under a project that has let go of it.
        if self.project.as_deref() == project {
            self.project = self.held_by_projects.last().cloned();
        }
        !self.is_held()
    }

    pub fn is_held(&self) -> bool {
        !self.held_by_projects.is_empty() || self.held_adhoc
    }

    /// Everything still holding it, for messages the user reads.
    pub fn holder_labels(&self) -> Vec<String> {
        let mut out: Vec<String> = self.held_by_projects.clone();
        if self.held_adhoc {
            out.push("a direct engage".to_string());
        }
        out
    }
}

fn state_path() -> PathBuf {
    crate::paths::data_dir().join("state.json")
}

pub fn now_unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

pub fn load() -> AppState {
    let Ok(contents) = std::fs::read_to_string(state_path()) else {
        return AppState::default();
    };
    let mut parsed: AppState = serde_json::from_str(&contents).unwrap_or_else(|e| {
        log::warn!("state.json failed to parse ({e}) — starting fresh");
        AppState::default()
    });
    // Self-migrating: a file written before holder tracking records only the
    // last project to engage. Backfilling on read means the very first
    // disengage after an upgrade cannot mistake a held profile for a free one.
    for entry in parsed.engaged.values_mut() {
        entry.backfill_holders();
    }
    parsed
}

pub fn save(state: &AppState) -> std::io::Result<()> {
    let path = state_path();
    std::fs::create_dir_all(path.parent().unwrap())?;
    let json = serde_json::to_string_pretty(state).expect("serialize app state");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engaged(project: Option<&str>) -> EngagedProfile {
        let mut e = EngagedProfile {
            org: "acme".into(),
            env: Env::Dev,
            mode: Mode::ReadOnly,
            account_id: "1".into(),
            role_name: "ReadOnlyAccess".into(),
            region: "us-east-1".into(),
            project: project.map(str::to_string),
            held_by_projects: Vec::new(),
            held_adhoc: false,
            engaged_at_unix_ms: 0,
        };
        e.add_holder(project);
        e
    }

    /// The whole point: one AWS profile, two projects relying on it. Letting
    /// go of one must not strip credentials the other is still using.
    #[test]
    fn releasing_one_of_two_projects_keeps_the_profile() {
        let mut e = engaged(Some("alpha"));
        e.add_holder(Some("beta"));

        assert_eq!(e.release_holder(Some("alpha")), false, "still held by beta");
        assert!(e.is_held());
        assert_eq!(e.held_by_projects, ["beta"]);
        // Attribution follows the surviving holder, so the rail cannot group
        // it under a project that has let go.
        assert_eq!(e.project.as_deref(), Some("beta"));

        assert_eq!(e.release_holder(Some("beta")), true, "last holder gone");
        assert!(!e.is_held());
    }

    #[test]
    fn a_direct_engage_is_its_own_holder() {
        let mut e = engaged(Some("alpha"));
        e.add_holder(None);

        assert_eq!(e.release_holder(Some("alpha")), false, "the direct engage still holds it");
        assert!(e.held_adhoc);
        assert_eq!(e.release_holder(None), true);
    }

    #[test]
    fn holding_twice_from_one_project_counts_once() {
        let mut e = engaged(Some("alpha"));
        e.add_holder(Some("alpha"));
        assert_eq!(e.held_by_projects, ["alpha"]);
        // Otherwise a re-engage would need two releases to free the profile.
        assert_eq!(e.release_holder(Some("alpha")), true);
    }

    #[test]
    fn releasing_a_holder_that_never_held_it_changes_nothing() {
        let mut e = engaged(Some("alpha"));
        assert_eq!(e.release_holder(Some("ghost")), false);
        assert!(e.is_held());
        assert_eq!(e.held_by_projects, ["alpha"]);
    }

    /// An upgrade must not read existing engagements as unheld — the first
    /// disengage would then strip keys that are genuinely in use.
    #[test]
    fn a_state_file_predating_holders_backfills() {
        let json = r#"{"pins":[],"lastEngage":{},"engaged":{"bus":{
            "org":"acme","env":"dev","mode":"readOnly","accountId":"1",
            "roleName":"ReadOnlyAccess","region":"us-east-1",
            "project":"alpha","engagedAtUnixMs":0}}}"#;
        let mut st: AppState = serde_json::from_str(json).expect("old state must parse");
        for e in st.engaged.values_mut() {
            e.backfill_holders();
        }
        let bus = &st.engaged["bus"];
        assert_eq!(bus.held_by_projects, ["alpha"]);
        assert!(bus.is_held(), "an old entry must never look free");
    }

    #[test]
    fn an_old_adhoc_entry_backfills_to_a_direct_hold() {
        let json = r#"{"pins":[],"lastEngage":{},"engaged":{"bus":{
            "org":"acme","env":"dev","mode":"readOnly","accountId":"1",
            "roleName":"ReadOnlyAccess","region":"us-east-1","engagedAtUnixMs":0}}}"#;
        let mut st: AppState = serde_json::from_str(json).expect("parse");
        for e in st.engaged.values_mut() {
            e.backfill_holders();
        }
        assert!(st.engaged["bus"].held_adhoc);
        assert!(st.engaged["bus"].is_held());
    }

    /// Backfill runs on every load; it must not add a second holder to an
    /// entry that already tracks them.
    #[test]
    fn backfill_is_idempotent() {
        let mut e = engaged(Some("alpha"));
        e.backfill_holders();
        e.backfill_holders();
        assert_eq!(e.held_by_projects, ["alpha"]);
        assert!(!e.held_adhoc);
    }

    #[test]
    fn holder_labels_name_the_direct_engage_readably() {
        let mut e = engaged(Some("alpha"));
        e.add_holder(None);
        assert_eq!(e.holder_labels(), ["alpha", "a direct engage"]);
    }
}
