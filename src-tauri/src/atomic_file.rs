//! Publishing a file by writing a temp file beside it and renaming over
//! the target — the one definition of how sleipnir replaces a file it owns.
//!
//! Two details are easy to get wrong separately, and were, in five places:
//!
//! The temp name carries the pid. A fixed name is shared by every
//! concurrent writer, and `sleipnir creds` runs as a *separate process*
//! against the same home on every `aws` command, so two writers can
//! interleave inside one `fs::write` and leave a half-and-half file for
//! `rename` to publish over the real one.
//!
//! Permissions are set on the temp file *before* the rename, so the file
//! is never briefly readable at the default umask.

use std::io;
use std::path::Path;

/// For a file whose contents are not sensitive — `config.toml`,
/// `state.json`. Permissions are left to the umask.
pub fn write(path: &Path, contents: &str) -> io::Result<()> {
    publish(path, contents, None)
}

/// For anything holding credentials or a token: owner-only, from the
/// moment it exists.
pub fn write_private(path: &Path, contents: &str) -> io::Result<()> {
    publish(path, contents, Some(0o600))
}

fn publish(path: &Path, contents: &str, mode: Option<u32>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("sleipnir-tmp-{}", std::process::id()));
    std::fs::write(&tmp, contents)?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        // Best-effort: a filesystem without Unix permissions is not a
        // reason to fail the write.
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode));
    }
    std::fs::rename(&tmp, path)
}
