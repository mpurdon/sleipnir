//! Auto-discovery: turn a raw `ListAccounts`/`ListAccountRoles` dump into
//! fully-formed, pre-checked import candidates by exploiting the org's
//! naming convention — `<Service Name> <Environment>` (or dash-separated
//! `platform-tools-dev` style). The heuristic was validated against a
//! real 166-account org (40 multi-env services + 8 single-env + 17
//! standalone, zero mis-groupings); the checked-in fixture is a
//! structure-preserving synthetic org with the same split and edge cases.

use crate::config::{Account, Env, EnvTarget, Mode};
use serde::Serialize;
use std::collections::BTreeMap;

/// One raw account as discovery sees it (id, display name, its roles).
#[derive(Debug, Clone)]
pub struct RawAccount {
    pub account_id: String,
    pub account_name: String,
    pub email_address: Option<String>,
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedDiscovery {
    /// Multi-env and single-env services, alias-sorted.
    pub services: Vec<ProposedService>,
    /// Env-less standalone accounts (imported as single `global`-env services).
    pub standalone: Vec<ProposedService>,
    /// Total raw accounts that went in, for the "166 accounts → …" headline.
    pub total_accounts: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedService {
    pub account: Account,
    /// Human display name ("Core Services"), distinct from the slug alias.
    pub display_name: String,
    /// Modes where multiple SSO roles classify the same (PowerUserAccess +
    /// SSTPowerUserAccess) — the review UI renders each as an inline
    /// one-of pick instead of a vague warning.
    pub role_choices: Vec<RoleChoice>,
    /// Non-blocking informational note (e.g. the single-env explanation).
    /// Nothing to act on — never rendered as a warning.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// One ambiguous mode→role mapping with its candidates and the default
/// pick (most-envs, then shortest-name).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleChoice {
    pub mode: Mode,
    pub candidates: Vec<String>,
    pub picked: String,
}

/// Env-token table. Checked against the LAST whitespace/dash/underscore-
/// separated word of the account name, case-insensitively.
fn env_token(word: &str) -> Option<Env> {
    match word.to_ascii_lowercase().as_str() {
        "development" | "dev" => Some(Env::Dev),
        "staging" | "stage" | "stg" => Some(Env::Stg),
        "production" | "prod" | "prd" => Some(Env::Prd),
        "sandbox" | "sbx" => Some(Env::Sbx),
        _ => None,
    }
}

fn split_trailing_env(name: &str) -> Option<(String, Env)> {
    let trimmed = name.trim();
    let split_at = trimmed.rfind([' ', '-', '_'])?;
    let (base, last) = trimmed.split_at(split_at);
    let last = &last[1..];
    let env = env_token(last)?;
    let base = base.trim_end_matches([' ', '-', '_']).to_string();
    if base.is_empty() {
        return None;
    }
    Some((base, env))
}

pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = true; // suppress leading dash
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// AWS service names that, as a prefix before the mode keyword, mark a
/// role as service-scoped rather than a general mode candidate:
/// `CognitoReadOnly` is dedicated Cognito access, not an account-wide
/// readonly. Org-specific variants (`SSTPowerUserAccess`) are NOT listed,
/// so they still classify.
const AWS_SERVICE_PREFIXES: &[&str] = &[
    "cognito", "iam", "s3", "ec2", "rds", "vpc", "lambda", "dynamodb", "cloudwatch", "cloudfront",
    "secretsmanager", "secrets", "bedrock", "sagemaker", "glue", "athena", "kinesis", "sns", "sqs",
    "route53", "eks", "ecs", "ecr", "billing", "cloudtrail", "kms", "ses",
];

/// Classify an SSO permission-set name into one of sleipnir's three modes.
/// A role whose mode keyword is prefixed by an AWS service name is a
/// dedicated special role (shown under OTHER), never a mode candidate.
pub fn classify_role(role: &str) -> Option<Mode> {
    let lower = role.to_ascii_lowercase();
    let (mode, pos) = if let Some(p) = lower.find("admin") {
        (Mode::Admin, p)
    } else if let Some(p) = lower.find("power") {
        (Mode::PowerUser, p)
    } else if let Some(p) = lower
        .find("readonly")
        .or_else(|| lower.find("viewonly"))
        .or_else(|| lower.find("view_only"))
    {
        (Mode::ReadOnly, p)
    } else {
        return None;
    };

    let prefix: String = lower[..pos].chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if AWS_SERVICE_PREFIXES.contains(&prefix.as_str()) {
        return None;
    }
    Some(mode)
}

/// Pick the preferred role per mode from a set of available roles across
/// the service's env-targets. When two roles classify to the same mode
/// (e.g. PowerUserAccess + SSTPowerUserAccess), prefer the one available on
/// the MOST envs, tie-broken by shortest name (the less-specialized one),
/// and flag the service for review.
fn roles_by_mode(targets: &BTreeMap<Env, EnvTarget>) -> (std::collections::HashMap<Mode, String>, Vec<RoleChoice>) {
    use std::collections::HashMap;
    let mut counts: HashMap<(Mode, String), usize> = HashMap::new();
    for t in targets.values() {
        for role in &t.available_roles {
            if let Some(mode) = classify_role(role) {
                *counts.entry((mode, role.clone())).or_insert(0) += 1;
            }
        }
    }

    let mut by_mode: HashMap<Mode, Vec<(String, usize)>> = HashMap::new();
    for ((mode, role), count) in counts {
        by_mode.entry(mode).or_default().push((role, count));
    }

    let mut chosen = HashMap::new();
    let mut choices = Vec::new();
    for (mode, mut candidates) in by_mode {
        candidates.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.len().cmp(&b.0.len())).then(a.0.cmp(&b.0)));
        if candidates.len() > 1 {
            choices.push(RoleChoice {
                mode,
                candidates: candidates.iter().map(|(r, _)| r.clone()).collect(),
                picked: candidates[0].0.clone(),
            });
        }
        chosen.insert(mode, candidates[0].0.clone());
    }
    choices.sort_by_key(|c| match c.mode {
        Mode::ReadOnly => 0,
        Mode::PowerUser => 1,
        Mode::Admin => 2,
    });
    (chosen, choices)
}

pub fn group_accounts(org: &str, raw: Vec<RawAccount>) -> GroupedDiscovery {
    let total_accounts = raw.len();

    // Group by parsed base name (BTreeMap for stable, sorted output).
    let mut grouped: BTreeMap<String, (String, BTreeMap<Env, EnvTarget>)> = BTreeMap::new();
    let mut standalone_raw: Vec<RawAccount> = Vec::new();

    for account in raw {
        match split_trailing_env(&account.account_name) {
            Some((base, env)) => {
                let entry = grouped.entry(slugify(&base)).or_insert_with(|| (base.clone(), BTreeMap::new()));
                entry.1.insert(
                    env,
                    EnvTarget {
                        account_id: account.account_id,
                        account_name: account.account_name,
                        region: None,
                        available_roles: account.roles,
                        role_overrides: Default::default(),
                    },
                );
            }
            None => standalone_raw.push(account),
        }
    }

    let mut services = Vec::new();
    for (alias, (display_name, targets)) in grouped {
        let (roles, role_choices) = roles_by_mode(&targets);
        let note = (targets.len() == 1).then(|| {
            let env = *targets.keys().next().unwrap();
            let full_name = &targets.values().next().unwrap().account_name;
            format!("Single environment — the only account found is \"{full_name}\" ({env:?}).")
        });
        services.push(ProposedService {
            account: Account {
                alias,
                display_name: display_name.clone(),
                org: org.to_string(),
                environments: targets.into_iter().collect(),
                roles,
            },
            display_name,
            role_choices,
            note,
        });
    }

    let mut standalone = Vec::new();
    standalone_raw.sort_by(|a, b| a.account_name.cmp(&b.account_name));
    for account in standalone_raw {
        let mut targets = BTreeMap::new();
        targets.insert(
            Env::Global,
            EnvTarget {
                account_id: account.account_id,
                account_name: account.account_name.clone(),
                region: None,
                available_roles: account.roles,
                role_overrides: Default::default(),
            },
        );
        let (roles, role_choices) = roles_by_mode(&targets);
        standalone.push(ProposedService {
            account: Account {
                alias: slugify(&account.account_name),
                display_name: account.account_name.clone(),
                org: org.to_string(),
                environments: targets.into_iter().collect(),
                roles,
            },
            display_name: account.account_name,
            role_choices,
            note: None,
        });
    }

    GroupedDiscovery { services, standalone, total_accounts }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic 166-account org mirroring the structure of the real
    /// org the heuristic was validated against (same naming convention,
    /// same edge cases, same split). If the split drifts from 40
    /// multi-env + 8 single-env + 17 standalone, the heuristic broke.
    const FIXTURE: &str = include_str!("discovery_fixture.txt");

    fn fixture_accounts() -> Vec<RawAccount> {
        FIXTURE
            .lines()
            .filter(|l| !l.trim().is_empty())
            .enumerate()
            .map(|(i, name)| RawAccount {
                account_id: format!("{i:012}"),
                account_name: name.to_string(),
                email_address: None,
                roles: vec!["AdministratorAccess".into(), "PowerUserAccess".into(), "ReadOnlyAccess".into()],
            })
            .collect()
    }

    #[test]
    fn real_org_grouping_split_holds() {
        let grouped = group_accounts("test-org", fixture_accounts());
        assert_eq!(grouped.total_accounts, 166);

        let multi: Vec<_> = grouped.services.iter().filter(|s| s.account.environments.len() >= 2).collect();
        let single: Vec<_> = grouped.services.iter().filter(|s| s.account.environments.len() == 1).collect();
        assert_eq!(multi.len(), 40, "multi-env services");
        assert_eq!(single.len(), 8, "single-env services");
        assert_eq!(grouped.standalone.len(), 17, "standalone accounts");
    }

    #[test]
    fn known_groupings() {
        let grouped = group_accounts("test-org", fixture_accounts());
        let find = |alias: &str| grouped.services.iter().find(|s| s.account.alias == alias).unwrap();

        let core = find("core-services");
        assert_eq!(core.account.environments.len(), 4);
        assert_eq!(core.display_name, "Core Services");

        // Related-prefix variants stay distinct services.
        assert!(grouped.services.iter().any(|s| s.account.alias == "atlas"));
        assert!(grouped.services.iter().any(|s| s.account.alias == "atlas-disability"));
        assert!(grouped.services.iter().any(|s| s.account.alias == "atlas-medical"));

        // Dash-separated variant groups too.
        let dashy = find("platform-tools");
        assert_eq!(dashy.account.environments.len(), 4);

        // Abbreviated env tokens (Dev/Prod) group as well.
        let acme = find("acme-cloud");
        assert_eq!(acme.account.environments.len(), 3);

        // "Widgets Team Dev & QA" ends in "QA", not an env token → standalone.
        assert!(grouped.standalone.iter().any(|s| s.display_name == "Widgets Team Dev & QA"));
    }

    #[test]
    fn single_env_gets_info_note() {
        let grouped = group_accounts("test-org", fixture_accounts());
        let rd = grouped.services.iter().find(|s| s.account.alias == "r-d").unwrap();
        assert_eq!(rd.account.environments.len(), 1);
        assert!(rd.note.as_deref().unwrap().contains("R&D Production"));
        // Informational only — never an actionable role choice.
        assert!(rd.role_choices.is_empty());
    }

    #[test]
    fn role_classification() {
        assert_eq!(classify_role("AdministratorAccess"), Some(Mode::Admin));
        assert_eq!(classify_role("OrganizationAdmin"), Some(Mode::Admin));
        assert_eq!(classify_role("PowerUserAccess"), Some(Mode::PowerUser));
        assert_eq!(classify_role("SSTPowerUserAccess"), Some(Mode::PowerUser));
        assert_eq!(classify_role("ReadOnlyAccess"), Some(Mode::ReadOnly));
        assert_eq!(classify_role("ViewOnlyAccess"), Some(Mode::ReadOnly));
        assert_eq!(classify_role("ClaudeCodeBedrockAccess"), None);
        // AWS-service-scoped roles are dedicated special roles, not
        // general mode candidates.
        assert_eq!(classify_role("CognitoReadOnly"), None);
        assert_eq!(classify_role("IAMPowerUserAccess"), None);
        assert_eq!(classify_role("SecretsManagerListSecrets"), None);
    }

    #[test]
    fn ambiguous_mode_roles_flagged() {
        let raw = vec![RawAccount {
            account_id: "1".into(),
            account_name: "Foo Development".into(),
            email_address: None,
            roles: vec!["PowerUserAccess".into(), "SSTPowerUserAccess".into()],
        }];
        let grouped = group_accounts("t", raw);
        let svc = &grouped.services[0];
        let choice = svc.role_choices.iter().find(|c| c.mode == Mode::PowerUser).unwrap();
        assert_eq!(choice.candidates, vec!["PowerUserAccess", "SSTPowerUserAccess"]);
        assert_eq!(choice.picked, "PowerUserAccess");
        assert_eq!(svc.account.roles.get(&Mode::PowerUser).unwrap(), "PowerUserAccess");
    }

    #[test]
    fn slugify_cases() {
        assert_eq!(slugify("Core Services"), "core-services");
        assert_eq!(slugify("R&D"), "r-d");
        assert_eq!(slugify("3rd Party Data Export"), "3rd-party-data-export");
        assert_eq!(slugify("Widgets Team Dev & QA"), "widgets-team-dev-qa");
    }
}
