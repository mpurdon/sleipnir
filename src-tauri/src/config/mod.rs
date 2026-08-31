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

pub fn delete_project(name: &str) -> std::io::Result<SleipnirConfig> {
    let mut cfg = load_or_seed();
    cfg.projects.retain(|p| p.name != name);
    save(&cfg)?;
    Ok(cfg)
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

    SleipnirConfig { orgs, accounts: Vec::new(), projects: Vec::new() }
}
