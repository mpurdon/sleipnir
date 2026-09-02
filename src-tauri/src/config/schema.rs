use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// An "Org" is a single SSO session/organization (start URL + region) —
/// see the plan doc's Data Model section.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrgConfig {
    pub name: String,
    pub start_url: String,
    pub region: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Env {
    Sbx,
    Dev,
    Stg,
    Prd,
    /// Standalone accounts with no environment dimension (e.g. "Backups",
    /// "Security Tooling") import as a single `global` env-target; the UI
    /// hides the env selector when only `global` exists.
    Global,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    ReadOnly,
    PowerUser,
    Admin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvTarget {
    pub account_id: String,
    /// AWS account display name, for recognition in the UI.
    #[serde(default)]
    pub account_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// SSO permission-set names actually assigned on this account — role
    /// availability differs per env (admin may exist on dev but not prd),
    /// so it's stored per env-target. The service-level `roles` map stays
    /// the *preference*; engage resolves per-env against this list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_roles: Vec<String>,
    /// Explicit per-env role picks (mode → role name), set from the
    /// discovery review when one env's right role differs from the
    /// service-wide preference. Takes precedence over `Account::roles`
    /// at engage time.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub role_overrides: HashMap<Mode, String>,
}

/// An sleipnir "Account" is really a *service* that exists as a separate
/// AWS account per environment (the `SAFE_PPE`/`SAFE_PPE_DEV`/
/// `SAFE_PPE_STAGE` pattern) — see the plan doc's Data Model section.
/// `roles` maps sleipnir's 3 canonical Modes onto this account's actual SSO
/// permission-set names, which are NOT consistent across accounts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Machine slug — doubles as the AWS profile name (`r-d`,
    /// `core-services`). Stable, terminal-facing.
    pub alias: String,
    /// Human name for the UI ("R&D", "Core Services") — recognition over
    /// recall; the slug alone reads as noise in lists.
    #[serde(default)]
    pub display_name: String,
    pub org: String,
    #[serde(default)]
    pub environments: HashMap<Env, EnvTarget>,
    #[serde(default)]
    pub roles: HashMap<Mode, String>,
}

/// A named, ordered list of Account aliases to Engage together. Deliberately
/// just a reference list — an account is never owned by one project, see
/// the plan's "Making grouping easy" section.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub org: String,
    #[serde(default)]
    pub members: Vec<String>,
}

/// A project that was deleted, kept so the deletion can be undone.
///
/// Fields are flattened rather than nesting a `Project`, because TOML renders
/// a nested struct as `[deleted_projects.project]` — legible enough, but this
/// file is meant to be hand-editable and a flat table reads better.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedProject {
    pub name: String,
    pub org: String,
    #[serde(default)]
    pub members: Vec<String>,
    pub deleted_at_unix_ms: u64,
}

impl DeletedProject {
    pub fn from_project(p: Project, at: u64) -> Self {
        Self { name: p.name, org: p.org, members: p.members, deleted_at_unix_ms: at }
    }

    pub fn into_project(self) -> Project {
        Project { name: self.name, org: self.org, members: self.members }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SleipnirConfig {
    #[serde(default)]
    pub orgs: Vec<OrgConfig>,
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub projects: Vec<Project>,
    /// Deleted projects, newest first. Deleting is reversible on purpose:
    /// a project is a bundle someone assembled by hand, and losing one to a
    /// misclick costs real work to rebuild. Nothing prunes this — an entry
    /// leaves only when the user purges it.
    #[serde(default)]
    pub deleted_projects: Vec<DeletedProject>,
}
