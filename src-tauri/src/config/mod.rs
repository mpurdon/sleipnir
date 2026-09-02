pub mod aws_config_editor;
mod schema;

pub use schema::*;

use std::path::PathBuf;

fn config_dir() -> PathBuf {
    crate::paths::data_dir()
}

fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

pub fn path() -> PathBuf {
    config_path()
}

pub fn load_or_seed() -> SleipnirConfig {
    if let Ok(contents) = std::fs::read_to_string(config_path()) {
        if let Ok(cfg) = toml::from_str::<SleipnirConfig>(&contents) {
            return cfg;
        }
        log::warn!("~/.sleipnir/config.toml exists but failed to parse — falling back to a fresh seed");
    }
    let seeded = seed_from_aws_config();
    log::info!("seeded sleipnir config with {} org(s) found in ~/.aws/config", seeded.orgs.len());
    let _ = save(&seeded);
    seeded
}

pub fn save(cfg: &SleipnirConfig) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir())?;
    let toml_str = toml::to_string_pretty(cfg).expect("serialize sleipnir config");
    std::fs::write(config_path(), toml_str)
}

/// Insert or replace (by `name`) one Org, then persist.
pub fn upsert_org(org: OrgConfig) -> std::io::Result<SleipnirConfig> {
    let mut cfg = load_or_seed();
    match cfg.orgs.iter_mut().find(|o| o.name == org.name) {
        Some(existing) => *existing = org,
        None => cfg.orgs.push(org),
    }
    save(&cfg)?;
    Ok(cfg)
}

pub fn delete_org(name: &str) -> std::io::Result<SleipnirConfig> {
    let mut cfg = load_or_seed();
    cfg.orgs.retain(|o| o.name != name);
    cfg.accounts.retain(|a| a.org != name);
    for project in &mut cfg.projects {
        project.members.retain(|alias| cfg.accounts.iter().any(|a| a.alias == *alias));
    }
    cfg.projects.retain(|p| p.org != name);
    save(&cfg)?;
    Ok(cfg)
}

/// Insert or replace (by `alias`) one Account, then persist.
pub fn upsert_account(account: Account) -> std::io::Result<SleipnirConfig> {
    let mut cfg = load_or_seed();
    match cfg.accounts.iter_mut().find(|a| a.alias == account.alias) {
        Some(existing) => *existing = account,
        None => cfg.accounts.push(account),
    }
    save(&cfg)?;
    Ok(cfg)
}

pub fn delete_account(alias: &str) -> std::io::Result<SleipnirConfig> {
    let mut cfg = load_or_seed();
    cfg.accounts.retain(|a| a.alias != alias);
    // An account that no longer exists can't stay a member of any project.
    for project in &mut cfg.projects {
        project.members.retain(|m| m != alias);
    }
    save(&cfg)?;
    Ok(cfg)
}

/// Insert or replace (by `name`) one Project, then persist.
pub fn upsert_project(project: Project) -> std::io::Result<SleipnirConfig> {
    let mut cfg = load_or_seed();
    match cfg.projects.iter_mut().find(|p| p.name == project.name) {
        Some(existing) => *existing = project,
        None => cfg.projects.push(project),
    }
    save(&cfg)?;
    Ok(cfg)
}

/// Soft-deletes: the project moves to `deleted_projects` rather than being
/// dropped. A project is a bundle someone assembled by hand, so a misclick
/// that vaporised one would cost real work to rebuild.
///
/// Split from the IO so the semantics can be tested without a config file on
/// disk — these operate on the user's real `~/.sleipnir/config.toml`, which
/// is not something a test suite should be reaching into.
pub fn archive_project_in(cfg: &mut SleipnirConfig, name: &str, at: u64) {
    if let Some(i) = cfg.projects.iter().position(|p| p.name == name) {
        let removed = cfg.projects.remove(i);
        // Newest first, and never two archive entries under one name — a
        // second delete of a recreated project supersedes the older record
        // rather than making `restore` ambiguous.
        cfg.deleted_projects.retain(|d| d.name != name);
        cfg.deleted_projects.insert(0, DeletedProject::from_project(removed, at));
    }
}

pub fn restore_project_in(cfg: &mut SleipnirConfig, name: &str) -> Result<(), RestoreError> {
    // Refuse rather than overwrite when the name is live again: the user
    // recreated something under that name, and silently replacing their
    // current work with an older copy is the one outcome an undo must never
    // produce.
    if cfg.projects.iter().any(|p| p.name == name) {
        return Err(RestoreError::NameTaken(name.to_string()));
    }
    let Some(i) = cfg.deleted_projects.iter().position(|d| d.name == name) else {
        return Err(RestoreError::NotFound(name.to_string()));
    };
    let restored = cfg.deleted_projects.remove(i);
    cfg.projects.push(restored.into_project());
    Ok(())
}

pub fn delete_project(name: &str) -> std::io::Result<SleipnirConfig> {
    let mut cfg = load_or_seed();
    archive_project_in(&mut cfg, name, crate::state::now_unix_ms());
    save(&cfg)?;
    Ok(cfg)
}

pub fn restore_project(name: &str) -> Result<SleipnirConfig, RestoreError> {
    let mut cfg = load_or_seed();
    restore_project_in(&mut cfg, name)?;
    save(&cfg).map_err(RestoreError::Io)?;
    Ok(cfg)
}

/// Permanently drops an archived project. The only path that actually loses
/// data, and it is never reached except by explicit request.
pub fn purge_project(name: &str) -> std::io::Result<SleipnirConfig> {
    let mut cfg = load_or_seed();
    cfg.deleted_projects.retain(|d| d.name != name);
    save(&cfg)?;
    Ok(cfg)
}

#[derive(Debug, thiserror::Error)]
pub enum RestoreError {
    #[error("a project named \"{0}\" already exists — rename or delete it first")]
    NameTaken(String),
    #[error("no deleted project named \"{0}\"")]
    NotFound(String),
    #[error("writing config: {0}")]
    Io(#[from] std::io::Error),
}

/// First-run seed: scan `~/.aws/config` for `[sso-session NAME]` blocks and
/// import them as Orgs. Hand-rolled line scan rather than an INI crate — see
/// the plan's rationale (the file isn't strict INI and a generic parser
/// would fight the "coexist with vpb and hand edits" requirement once the
/// full `~/.aws/config` writer lands in Build phase 4).
fn seed_from_aws_config() -> SleipnirConfig {
    let path = match dirs::home_dir() {
        Some(home) => home.join(".aws").join("config"),
        None => return SleipnirConfig::default(),
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return SleipnirConfig::default();
    };

    let mut orgs = Vec::new();
    let mut current: Option<String> = None;
    let mut start_url: Option<String> = None;
    let mut region: Option<String> = None;

    let flush = |orgs: &mut Vec<OrgConfig>, current: &mut Option<String>, start_url: &mut Option<String>, region: &mut Option<String>| {
        if let (Some(name), Some(su), Some(r)) = (current.take(), start_url.take(), region.take()) {
            orgs.push(OrgConfig { name, start_url: su, region: r });
        }
    };

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if let Some(header) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            flush(&mut orgs, &mut current, &mut start_url, &mut region);
            current = header.trim().strip_prefix("sso-session ").map(|s| s.trim().to_string());
            continue;
        }
        if current.is_none() {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            match key.trim() {
                "sso_start_url" => start_url = Some(value.trim().to_string()),
                "sso_region" => region = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    flush(&mut orgs, &mut current, &mut start_url, &mut region);

    SleipnirConfig { orgs, accounts: Vec::new(), projects: Vec::new(), deleted_projects: Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, members: &[&str]) -> Project {
        Project {
            name: name.into(),
            org: "acme".into(),
            members: members.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn cfg_with(projects: Vec<Project>) -> SleipnirConfig {
        SleipnirConfig { projects, ..Default::default() }
    }

    #[test]
    fn deleting_archives_rather_than_drops() {
        let mut cfg = cfg_with(vec![project("alpha", &["a", "b"]), project("beta", &[])]);
        archive_project_in(&mut cfg, "alpha", 1_000);

        assert_eq!(cfg.projects.iter().map(|p| &p.name).collect::<Vec<_>>(), ["beta"]);
        assert_eq!(cfg.deleted_projects.len(), 1);
        let d = &cfg.deleted_projects[0];
        assert_eq!(d.name, "alpha");
        assert_eq!(d.members, ["a", "b"], "members must survive so a restore is faithful");
        assert_eq!(d.deleted_at_unix_ms, 1_000);
    }

    #[test]
    fn restoring_brings_the_members_back() {
        let mut cfg = cfg_with(vec![project("alpha", &["a", "b"])]);
        archive_project_in(&mut cfg, "alpha", 1);
        restore_project_in(&mut cfg, "alpha").expect("restore");

        assert!(cfg.deleted_projects.is_empty());
        assert_eq!(cfg.projects.len(), 1);
        assert_eq!(cfg.projects[0].members, ["a", "b"]);
    }

    /// The outcome an undo must never produce: silently replacing work the
    /// user did after the delete with an older copy of the same name.
    #[test]
    fn restoring_refuses_when_the_name_is_live_again() {
        let mut cfg = cfg_with(vec![project("alpha", &["old"])]);
        archive_project_in(&mut cfg, "alpha", 1);
        cfg.projects.push(project("alpha", &["new"]));

        let err = restore_project_in(&mut cfg, "alpha").expect_err("must refuse");
        assert!(matches!(err, RestoreError::NameTaken(_)));
        assert_eq!(cfg.projects.len(), 1);
        assert_eq!(cfg.projects[0].members, ["new"], "the live project is untouched");
        assert_eq!(cfg.deleted_projects.len(), 1, "the archived copy is still there");
    }

    #[test]
    fn restoring_something_that_was_never_deleted_is_an_error() {
        let mut cfg = cfg_with(vec![]);
        assert!(matches!(
            restore_project_in(&mut cfg, "ghost"),
            Err(RestoreError::NotFound(_))
        ));
    }

    /// Deleting a recreated project must supersede the older archive entry,
    /// or `restore` would have two candidates and pick arbitrarily.
    #[test]
    fn a_second_delete_supersedes_the_earlier_archive_entry() {
        let mut cfg = cfg_with(vec![project("alpha", &["first"])]);
        archive_project_in(&mut cfg, "alpha", 100);
        cfg.projects.push(project("alpha", &["second"]));
        archive_project_in(&mut cfg, "alpha", 200);

        assert_eq!(cfg.deleted_projects.len(), 1, "one entry per name");
        assert_eq!(cfg.deleted_projects[0].members, ["second"]);
        assert_eq!(cfg.deleted_projects[0].deleted_at_unix_ms, 200);
    }

    #[test]
    fn newest_deletion_is_listed_first() {
        let mut cfg = cfg_with(vec![project("a", &[]), project("b", &[])]);
        archive_project_in(&mut cfg, "a", 100);
        archive_project_in(&mut cfg, "b", 200);
        assert_eq!(
            cfg.deleted_projects.iter().map(|d| &d.name).collect::<Vec<_>>(),
            ["b", "a"]
        );
    }

    #[test]
    fn deleting_something_absent_is_a_no_op() {
        let mut cfg = cfg_with(vec![project("alpha", &[])]);
        archive_project_in(&mut cfg, "nope", 1);
        assert_eq!(cfg.projects.len(), 1);
        assert!(cfg.deleted_projects.is_empty());
    }

    /// config.toml round-trips through TOML, and an array of tables that
    /// follows another array of tables is the shape most likely to break.
    #[test]
    fn the_archive_survives_a_toml_round_trip() {
        let mut cfg = cfg_with(vec![project("alpha", &["a", "b"])]);
        archive_project_in(&mut cfg, "alpha", 12_345);
        let text = toml::to_string_pretty(&cfg).expect("serialize");
        let back: SleipnirConfig = toml::from_str(&text).expect("deserialize");
        assert_eq!(back.deleted_projects.len(), 1);
        assert_eq!(back.deleted_projects[0].name, "alpha");
        assert_eq!(back.deleted_projects[0].members, ["a", "b"]);
        assert_eq!(back.deleted_projects[0].deleted_at_unix_ms, 12_345);
    }

    /// An older config has no `deleted_projects` key at all.
    #[test]
    fn a_config_predating_the_archive_still_parses() {
        let old = "[[projects]]\nname = \"alpha\"\norg = \"acme\"\nmembers = [\"a\"]\n";
        let cfg: SleipnirConfig = toml::from_str(old).expect("old config must still load");
        assert_eq!(cfg.projects.len(), 1);
        assert!(cfg.deleted_projects.is_empty());
    }
}
