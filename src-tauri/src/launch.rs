//! How `sleipnir` behaves when a person types it in a terminal.
//!
//! A bare invocation should leave a window behind and give the shell back,
//! the way `open -a` does — not tie the app's life to the terminal it was
//! started from. That matters here more than for most GUI apps: engaged
//! profiles are only refreshed while the process runs, so an app that dies
//! with its terminal quietly stops keeping credentials fresh, and the
//! symptom (expired keys, much later) points nowhere near the cause.

use std::path::{Path, PathBuf};

/// The `.app` bundle containing `exe`, if there is one.
///
/// A bundle executable lives at `Foo.app/Contents/MacOS/foo`, so the bundle
/// is three levels up. Returns `None` for a bare binary — notably
/// `target/debug/sleipnir` under `tauri dev`, which has no bundle to hand
/// off to and must keep running attached so its log stays on the terminal.
pub fn app_bundle_of(exe: &Path) -> Option<PathBuf> {
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// Hands off to a detached instance, returning `true` if this process has
/// done its job and should exit.
///
/// Two conditions keep this from recursing or firing when it should not:
///
/// - stdout must be a terminal. LaunchServices starts an app with no TTY,
///   so the instance `open` spawns falls through and actually runs the GUI.
///   It also means a redirected `sleipnir > log` stays attached, which is
///   what someone capturing output is asking for.
/// - there must be an enclosing `.app`. A dev build has none, so
///   `tauri dev` is unaffected.
#[cfg(target_os = "macos")]
pub fn relaunch_detached() -> bool {
    use std::io::IsTerminal;

    if !std::io::stdout().is_terminal() {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(bundle) = app_bundle_of(&exe) else {
        return false;
    };
    // `open` on an already-running app just activates it, which is the right
    // behaviour for a second `sleipnir` in another terminal.
    match std::process::Command::new("/usr/bin/open").arg(&bundle).status() {
        Ok(status) if status.success() => true,
        // Better to run attached than not at all.
        _ => false,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn relaunch_detached() -> bool {
    false
}

pub const USAGE: &str = "\
usage:
  sleipnir                        launch the app (detached from the terminal)
  sleipnir --foreground           launch attached, with the log on stdout
  sleipnir creds --profile <name> credential_process resolver (JSON on stdout)";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_bundle_around_an_installed_binary() {
        let exe = Path::new("/Applications/sleipnir.app/Contents/MacOS/sleipnir");
        assert_eq!(
            app_bundle_of(exe),
            Some(PathBuf::from("/Applications/sleipnir.app"))
        );
    }

    /// The case that must not detach: `tauri dev` runs this binary straight
    /// out of target/, from a terminal, with no bundle anywhere above it.
    /// Handing off would launch the *installed* app instead — a dev build
    /// silently starting production.
    #[test]
    fn a_dev_binary_has_no_bundle() {
        assert_eq!(app_bundle_of(Path::new("/repo/src-tauri/target/debug/sleipnir")), None);
        assert_eq!(app_bundle_of(Path::new("/usr/local/bin/sleipnir")), None);
    }

    /// A Homebrew symlink is resolved by current_exe() before it reaches
    /// here, so what this sees is the real path inside the bundle.
    #[test]
    fn shallow_paths_do_not_panic() {
        assert_eq!(app_bundle_of(Path::new("sleipnir")), None);
        assert_eq!(app_bundle_of(Path::new("/sleipnir")), None);
        assert_eq!(app_bundle_of(Path::new("/a/b/sleipnir")), None);
    }

    /// Only `.app` counts — a binary three levels under any other directory
    /// must not be mistaken for a bundle.
    #[test]
    fn only_dot_app_counts_as_a_bundle() {
        assert_eq!(app_bundle_of(Path::new("/opt/sleipnir/Contents/MacOS/sleipnir")), None);
        assert_eq!(app_bundle_of(Path::new("/opt/x.zip/Contents/MacOS/sleipnir")), None);
    }
}
