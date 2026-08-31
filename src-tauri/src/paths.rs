//! Where sleipnir's own data lives — and the single definition of the
//! dev/production split.
//!
//! A `tauri dev` run shares the machine with the installed app: the same
//! `~/.aws/credentials`, the same Keychain, the same background credential
//! rotation tick, and nothing stopping both from running at once. Pointed at
//! the same `~/.sleipnir`, a dev build adopts the real engaged map — so
//! DISENGAGE ALL in a dev window strips keys the production app put in
//! `~/.aws/credentials`, and two rotation loops race for the same file.
//!
//! Splitting the data directory keeps a half-finished branch from reaching
//! into the credentials real terminals are using. It does mean a dev build
//! starts empty and needs its own org and login, which is the intended
//! trade.

use std::path::PathBuf;

/// True in a `tauri dev` run, false in a bundled release build.
///
/// Deliberately **not** `tauri::is_dev()`. That is `!cfg!(feature =
/// "custom-protocol")`, the Tauri v1 mechanism; Tauri 2 ignores the feature
/// (see the CLI changelog for #8937) and this crate never defines it, so
/// `tauri::is_dev()` answers `true` inside the shipped app — exactly the
/// wrong way round for something that picks which credentials to touch.
/// `tauri-build` emits no `dev` cfg either.
///
/// `debug_assertions` tracks the cargo profile, which is precisely what
/// `tauri dev` (debug) and `tauri build` (release) differ on, and is what
/// `main.rs` already keys its `windows_subsystem` attribute off.
pub const fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// `~/.sleipnir`, or `~/.sleipnir-dev` under `tauri dev`.
///
/// The one place the directory name is written; config, runtime state and
/// the per-profile credential cache all hang off it, so they can never
/// disagree about which environment they are in.
pub fn data_dir() -> PathBuf {
    let name = if is_dev() { ".sleipnir-dev" } else { ".sleipnir" };
    dirs::home_dir().expect("home directory").join(name)
}

/// Keychain service name, suffixed in dev.
///
/// Entries are keyed by org name, so without this a dev login to an org
/// named like a real one overwrites the production refresh token and
/// silently signs you out of the app you were actually using — the data
/// directory split alone would not prevent that.
pub const fn keychain_service() -> &'static str {
    if is_dev() {
        "dev.purdonmoi.sleipnir.dev"
    } else {
        "dev.purdonmoi.sleipnir"
    }
}

/// Log file stem: `sleipnir.log`, or `sleipnir-dev.log` under `tauri dev`.
///
/// Both builds resolve the same `app_log_dir()` from the bundle identifier,
/// so without this a dev run interleaves its lines into the production log —
/// the one the troubleshooting docs tell people to paste into an issue.
pub const fn log_file_stem() -> &'static str {
    if is_dev() {
        "sleipnir-dev"
    } else {
        "sleipnir"
    }
}

/// Whether a log file in the shared log directory belongs to this build.
///
/// Exact stem, or the stem plus the rotation separator. A plain
/// `starts_with` would be wrong in one direction only, which is the easy
/// bug to ship here: "sleipnir-dev" starts with "sleipnir", so a production
/// build would happily adopt the dev log.
pub fn owns_log_file(stem: &str) -> bool {
    let want = log_file_stem();
    stem == want || stem.starts_with(&format!("{want}_"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the wiring rather than the value: whichever profile the suite
    /// runs under, the directory and the keychain service must agree about
    /// it. A future refactor that flips one and not the other fails here.
    #[test]
    fn dev_split_is_consistent() {
        let dir = data_dir();
        let dir_is_dev = dir.file_name().unwrap().to_str().unwrap() == ".sleipnir-dev";
        let service_is_dev = keychain_service().ends_with(".dev");
        assert_eq!(dir_is_dev, is_dev(), "data_dir disagrees with is_dev()");
        assert_eq!(service_is_dev, is_dev(), "keychain_service disagrees with is_dev()");
    }

    #[test]
    fn log_ownership_does_not_leak_across_builds() {
        // Whichever build this is, it must never claim the other's file.
        let other = if is_dev() { "sleipnir" } else { "sleipnir-dev" };
        assert!(owns_log_file(log_file_stem()), "must own its own log");
        assert!(owns_log_file(&format!("{}_2026-08-31", log_file_stem())), "must own its rotations");
        assert!(!owns_log_file(other), "must not adopt the other build's log");
        assert!(!owns_log_file(&format!("{other}_2026-08-31")), "must not adopt the other build's rotations");
        assert!(!owns_log_file("unrelated"));
    }

    /// The production names are the ones already on disk and in the
    /// Keychain for existing installs; renaming either would orphan every
    /// user's config and log them out.
    #[test]
    fn production_names_are_unchanged() {
        let dir = data_dir();
        let name = dir.file_name().unwrap().to_str().unwrap();
        let (expected_dir, expected_service) = if is_dev() {
            (".sleipnir-dev", "dev.purdonmoi.sleipnir.dev")
        } else {
            (".sleipnir", "dev.purdonmoi.sleipnir")
        };
        assert_eq!(name, expected_dir);
        assert_eq!(keychain_service(), expected_service);
        // Whatever the profile, the dev names must be the production ones
        // plus a suffix — never a different word that would orphan an
        // existing install's config or Keychain entries.
        assert_eq!(".sleipnir-dev".strip_suffix("-dev").unwrap(), ".sleipnir");
        assert_eq!("dev.purdonmoi.sleipnir.dev".strip_suffix(".dev").unwrap(), "dev.purdonmoi.sleipnir");
    }
}
