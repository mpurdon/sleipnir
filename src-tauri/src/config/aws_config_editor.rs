//! Line-preserving editor for `~/.aws/config` AND `~/.aws/credentials`.
//!
//! Hard requirement: this machine's AWS files are co-managed by the
//! user's `vpb` tool (`# vpb — managed` markers, `ca_bundle` lines) and by
//! hand edits. sleipnir therefore NEVER rewrites a file wholesale — it
//! edits individual key lines inside its target stanzas and leaves every
//! other byte exactly as found (comments, blank lines, unknown keys, other
//! stanzas). Writes are atomic (temp + rename).
//!
//! The two files differ only in section-header style: `[profile x]` in
//! config, bare `[x]` in credentials — expressed as `HeaderStyle`.
//!
//! No inline `# sleipnir` tags on key lines: the AWS CLI does not strip
//! trailing comments, so a tag would corrupt the value. Stanzas sleipnir
//! creates get a standalone `# managed by sleipnir` comment line instead.

use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeaderStyle {
    /// `[profile name]` — ~/.aws/config
    ConfigProfile,
    /// `[name]` — ~/.aws/credentials
    Credentials,
}

/// The two AWS files sleipnir edits, each fused with its header style so
/// a caller can never pair the credentials path with `[profile x]`
/// headers (or vice versa) — that mismatch is unrepresentable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AwsFile {
    Config,
    Credentials,
}

impl AwsFile {
    pub fn path(self) -> PathBuf {
        let aws = dirs::home_dir().expect("home directory").join(".aws");
        match self {
            AwsFile::Config => aws.join("config"),
            AwsFile::Credentials => aws.join("credentials"),
        }
    }

    fn style(self) -> HeaderStyle {
        match self {
            AwsFile::Config => HeaderStyle::ConfigProfile,
            AwsFile::Credentials => HeaderStyle::Credentials,
        }
    }
}

/// One profile stanza's sleipnir-owned keys. Any other keys already in the
/// stanza (vpb's `ca_bundle`, hand-added settings) are preserved untouched.
/// Config-file writes are always takeovers: competing credential-source
/// keys in the stanza get commented out so sleipnir's delivery wins.
#[derive(Debug, Clone)]
pub struct ProfileKeys {
    pub profile: String,
    pub keys: Vec<(String, String)>,
}

fn is_section_header(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('[') && t.ends_with(']')
}

fn header_for(style: HeaderStyle, profile: &str) -> String {
    match style {
        HeaderStyle::ConfigProfile => format!("[profile {profile}]"),
        HeaderStyle::Credentials => format!("[{profile}]"),
    }
}

fn section_matches(style: HeaderStyle, line: &str, profile: &str) -> bool {
    line.trim() == header_for(style, profile)
}

/// True when the line sets `key` (ignoring leading whitespace, not a
/// comment).
fn line_sets_key(line: &str, key: &str) -> bool {
    let t = line.trim_start();
    if t.starts_with('#') || t.starts_with(';') {
        return false;
    }
    match t.split_once('=') {
        Some((k, _)) => k.trim() == key,
        None => false,
    }
}

fn read_lines(path: &Path) -> io::Result<(Vec<String>, bool)> {
    let original = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let had_trailing_newline = original.is_empty() || original.ends_with('\n');
    Ok((original.lines().map(str::to_string).collect(), had_trailing_newline))
}

fn write_lines(path: &Path, lines: Vec<String>, had_trailing_newline: bool) -> io::Result<()> {
    let mut out = lines.join("\n");
    if had_trailing_newline && !out.is_empty() {
        out.push('\n');
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("sleipnir-tmp");
    std::fs::write(&tmp, out)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path)
}

/// Finds a stanza's [start, end) line range, end exclusive.
fn find_section(lines: &[String], style: HeaderStyle, profile: &str) -> Option<(usize, usize)> {
    let start = lines.iter().position(|l| section_matches(style, l, profile))?;
    let end = lines[start + 1..]
        .iter()
        .position(|l| is_section_header(l))
        .map(|off| start + 1 + off)
        .unwrap_or(lines.len());
    Some((start, end))
}

/// Credential-source keys ranked ABOVE static credentials-file keys (or
/// each other) in the AWS CLI's resolution chain — SSO config, assume-role,
/// in-stanza statics, and sleipnir's own retired credential_process lines.
/// Left in place they silently override sleipnir's engagement: the rail
/// would say READONLY while terminals resolve something else entirely.
/// Takeover writes comment them out (reversibly, with a marker).
const CONFLICTING_KEYS: &[&str] = &[
    "sso_start_url",
    "sso_region",
    "sso_account_id",
    "sso_role_name",
    "sso_session",
    "role_arn",
    "source_profile",
    "credential_source",
    "credential_process",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
    "web_identity_token_file",
];

const DISABLED_MARKER: &str = "# sleipnir-disabled: ";

/// Upserts every given profile's keys in one atomic write. Creates missing
/// stanzas at EOF; within existing stanzas replaces only the named keys in
/// place (or appends them at the stanza's end), preserving everything else
/// byte-for-byte.
pub fn upsert_profiles(file: AwsFile, profiles: &[ProfileKeys]) -> io::Result<()> {
    upsert_profiles_at(&file.path(), file.style(), profiles)
}

fn upsert_profiles_at(path: &Path, style: HeaderStyle, profiles: &[ProfileKeys]) -> io::Result<()> {
    let (mut lines, had_trailing_newline) = read_lines(path)?;
    for spec in profiles {
        upsert_one(&mut lines, style, spec);
    }
    write_lines(path, lines, had_trailing_newline)
}

fn upsert_one(lines: &mut Vec<String>, style: HeaderStyle, spec: &ProfileKeys) {
    let Some((start, end)) = find_section(lines, style, &spec.profile) else {
        // New stanza at EOF, separated by a blank line.
        if !lines.is_empty() && !lines.last().unwrap().trim().is_empty() {
            lines.push(String::new());
        }
        lines.push(header_for(style, &spec.profile));
        lines.push("# managed by sleipnir".to_string());
        for (k, v) in &spec.keys {
            lines.push(format!("{k} = {v}"));
        }
        return;
    };

    // Neutralize higher-precedence credential sources already in the
    // stanza (config file only) — but never a key we're about to (re)write
    // ourselves.
    if style == HeaderStyle::ConfigProfile {
        for line in &mut lines[start + 1..end] {
            let conflicted = CONFLICTING_KEYS
                .iter()
                .any(|k| line_sets_key(line, k) && !spec.keys.iter().any(|(wk, _)| wk == k));
            if conflicted {
                *line = format!("{DISABLED_MARKER}{line}");
            }
        }
    }

    for (k, v) in &spec.keys {
        let new_line = format!("{k} = {v}");
        if let Some(idx) = (start + 1..end).find(|&i| line_sets_key(&lines[i], k)) {
            lines[idx] = new_line;
        } else {
            // Insert before any trailing blank lines that visually separate
            // this stanza from the next.
            let mut insert_at = end;
            while insert_at > start + 1 && lines[insert_at - 1].trim().is_empty() {
                insert_at -= 1;
            }
            lines.insert(insert_at, new_line);
        }
    }
}

/// Deletes the given key lines from each named profile's stanza in ONE
/// read+write (disengage removing static credentials for a whole project).
/// Missing file/stanzas/keys are no-ops.
pub fn remove_profiles_keys(file: AwsFile, profiles: &[&str], keys: &[&str]) -> io::Result<()> {
    remove_profiles_keys_at(&file.path(), file.style(), profiles, keys)
}

fn remove_profiles_keys_at(path: &Path, style: HeaderStyle, profiles: &[&str], keys: &[&str]) -> io::Result<()> {
    let (mut lines, had_trailing_newline) = read_lines(path)?;
    for profile in profiles {
        let Some((start, end)) = find_section(&lines, style, profile) else {
            continue;
        };
        let mut i = start + 1;
        let mut end = end;
        while i < end {
            if keys.iter().any(|k| line_sets_key(&lines[i], k)) {
                lines.remove(i);
                end -= 1;
            } else {
                i += 1;
            }
        }
    }
    write_lines(path, lines, had_trailing_newline)
}

/// Renames a stanza in place — header line plus any `credential_process`
/// value referencing `--profile old` — leaving every other byte untouched.
/// A missing stanza is a no-op.
/// Whether the file already contains a stanza with this name.
///
/// Exists for the rename guard. Renaming rewrites a header line in place, so
/// a destination name that is already present leaves two sections with the
/// same name — and that is not a sleipnir-shaped problem: every AWS SDK
/// refuses to parse the *whole file*, so one bad rename takes out every
/// profile the user has, sleipnir's and everyone else's.
pub fn has_profile(file: AwsFile, name: &str) -> io::Result<bool> {
    has_profile_at(&file.path(), file.style(), name)
}

fn has_profile_at(path: &Path, style: HeaderStyle, name: &str) -> io::Result<bool> {
    let (lines, _) = read_lines(path)?;
    Ok(find_section(&lines, style, name).is_some())
}

pub fn rename_profile(file: AwsFile, old: &str, new: &str) -> io::Result<()> {
    rename_profile_at(&file.path(), file.style(), old, new)
}

fn rename_profile_at(path: &Path, style: HeaderStyle, old: &str, new: &str) -> io::Result<()> {
    let (mut lines, had_trailing_newline) = read_lines(path)?;
    let Some((start, end)) = find_section(&lines, style, old) else {
        return Ok(());
    };
    lines[start] = header_for(style, new);
    for line in &mut lines[start + 1..end] {
        if line_sets_key(line, "credential_process") {
            *line = line.replace(&format!("--profile {old}"), &format!("--profile {new}"));
        }
    }
    write_lines(path, lines, had_trailing_newline)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_with(style: HeaderStyle, initial: &str, profiles: &[ProfileKeys]) -> String {
        let dir = std::env::temp_dir().join(format!("sleipnir-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("cfg-{:p}", initial.as_ptr()));
        if !initial.is_empty() {
            std::fs::write(&path, initial).unwrap();
        } else {
            let _ = std::fs::remove_file(&path);
        }
        upsert_profiles_at(&path, style, profiles).unwrap();
        let out = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        out
    }

    fn run(initial: &str, profiles: &[ProfileKeys]) -> String {
        run_with(HeaderStyle::ConfigProfile, initial, profiles)
    }

    fn keys(profile: &str, kv: &[(&str, &str)]) -> ProfileKeys {
        ProfileKeys {
            profile: profile.into(),
            keys: kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    /// A temp file for the rename/exists tests.
    fn with_file(initial: &str, f: impl FnOnce(&Path)) -> String {
        let dir = std::env::temp_dir().join(format!("sleipnir-rn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("cfg-{:p}", initial.as_ptr()));
        std::fs::write(&path, initial).unwrap();
        f(&path);
        let out = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        out
    }

    #[test]
    fn has_profile_sees_stanzas_from_any_tool() {
        let cfg = "[profile mine]\nregion = us-east-1\n\n[profile theirs]\nca_bundle = /x.pem\n";
        with_file(cfg, |p| {
            assert!(has_profile_at(p, HeaderStyle::ConfigProfile, "mine").unwrap());
            // The one that matters: a stanza sleipnir never wrote.
            assert!(has_profile_at(p, HeaderStyle::ConfigProfile, "theirs").unwrap());
            assert!(!has_profile_at(p, HeaderStyle::ConfigProfile, "absent").unwrap());
        });
    }

    #[test]
    fn has_profile_on_a_missing_file_is_false_not_an_error() {
        let missing = std::env::temp_dir().join("sleipnir-definitely-absent.cfg");
        let _ = std::fs::remove_file(&missing);
        assert!(!has_profile_at(&missing, HeaderStyle::ConfigProfile, "any").unwrap());
    }

    /// Demonstrates precisely what the guard in rename_account prevents: the
    /// editor renames a header in place, so renaming onto an existing name
    /// produces two identical sections and every AWS SDK stops parsing the
    /// file. The editor is not the right place to refuse — it has no idea
    /// what the caller intends — so this pins the behaviour the caller must
    /// guard against.
    #[test]
    fn renaming_onto_an_existing_name_would_duplicate_the_section() {
        let cfg = "[profile a]\nregion = us-east-1\n\n[profile b]\nregion = us-west-2\n";
        let out = with_file(cfg, |p| {
            rename_profile_at(p, HeaderStyle::ConfigProfile, "a", "b").unwrap();
        });
        assert_eq!(out.matches("[profile b]").count(), 2, "two sections named b");
    }

    #[test]
    fn creates_stanza_in_empty_file() {
        let out = run("", &[keys("svc", &[("region", "us-east-2")])]);
        assert_eq!(out, "[profile svc]\n# managed by sleipnir\nregion = us-east-2\n");
    }

    #[test]
    fn credentials_style_uses_bare_headers() {
        let out = run_with(
            HeaderStyle::Credentials,
            "[nieto]\naws_access_key_id = AKIAOLD\n",
            &[keys("svc", &[("aws_access_key_id", "ASIANEW"), ("aws_secret_access_key", "s"), ("aws_session_token", "t")])],
        );
        // Other people's stanzas untouched; ours appended bare-header style.
        assert!(out.starts_with("[nieto]\naws_access_key_id = AKIAOLD\n"));
        assert!(out.contains("\n[svc]\n# managed by sleipnir\naws_access_key_id = ASIANEW\naws_secret_access_key = s\naws_session_token = t\n"));
    }

    #[test]
    fn credentials_upsert_replaces_in_place() {
        let initial = "[svc]\n# managed by sleipnir\naws_access_key_id = OLD\naws_secret_access_key = OLDS\naws_session_token = OLDT\n";
        let out = run_with(
            HeaderStyle::Credentials,
            initial,
            &[keys("svc", &[("aws_access_key_id", "NEW"), ("aws_secret_access_key", "NEWS"), ("aws_session_token", "NEWT")])],
        );
        assert_eq!(out, "[svc]\n# managed by sleipnir\naws_access_key_id = NEW\naws_secret_access_key = NEWS\naws_session_token = NEWT\n");
    }

    #[test]
    fn remove_keys_deletes_only_named_lines() {
        let dir = std::env::temp_dir().join(format!("sleipnir-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cfg-remove");
        std::fs::write(
            &path,
            "[svc]\n# managed by sleipnir\naws_access_key_id = A\naws_secret_access_key = B\naws_session_token = C\n\n[other]\naws_access_key_id = KEEP\n",
        )
        .unwrap();
        remove_profiles_keys_at(&path, HeaderStyle::Credentials, &["svc"], &["aws_access_key_id", "aws_secret_access_key", "aws_session_token"]).unwrap();
        let out = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(out, "[svc]\n# managed by sleipnir\n\n[other]\naws_access_key_id = KEEP\n");
    }

    #[test]
    fn preserves_vpb_lines_and_other_stanzas() {
        let initial = "\
# vpb — managed
[profile other]
ca_bundle = /etc/vpb/ca.pem
region = us-east-1

[profile svc]
ca_bundle = /etc/vpb/ca.pem
region = us-west-2
";
        let out = run(initial, &[keys("svc", &[("region", "us-east-2")])]);
        assert!(out.contains("# vpb — managed\n[profile other]\nca_bundle = /etc/vpb/ca.pem\nregion = us-east-1\n"));
        assert!(out.contains("[profile svc]\nca_bundle = /etc/vpb/ca.pem\nregion = us-east-2\n"));
    }

    #[test]
    fn inserts_before_trailing_blank_line_of_stanza() {
        let initial = "[profile svc]\nregion = us-west-2\n\n[profile tail]\nregion = eu-west-1\n";
        let out = run(initial, &[keys("svc", &[("output", "json")])]);
        assert_eq!(
            out,
            "[profile svc]\nregion = us-west-2\noutput = json\n\n[profile tail]\nregion = eu-west-1\n"
        );
    }

    #[test]
    fn appends_new_stanza_after_existing_content() {
        let initial = "[sso-session acme]\nsso_start_url = https://x/start\n";
        let out = run(initial, &[keys("svc", &[("region", "us-east-2")])]);
        assert_eq!(
            out,
            "[sso-session acme]\nsso_start_url = https://x/start\n\n[profile svc]\n# managed by sleipnir\nregion = us-east-2\n"
        );
    }

    /// A pre-existing profile with SSO config (and a retired sleipnir
    /// credential_process line): those keys outrank static credentials in
    /// the CLI chain, so takeover must comment them out or the engagement
    /// is cosmetic.
    #[test]
    fn takeover_disables_conflicting_credential_sources() {
        let initial = "\
[profile gitf]
ca_bundle = /Users/mp/.vpb/ca-bundle.pem
# GhostInTheFactory-Production via IAM Identity Center
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
sso_account_id = 515020252848
sso_role_name = AccountAdmin
credential_process = \"/old/sleipnir\" creds --profile gitf
region = us-east-1
";
        let out = run(initial, &[keys("gitf", &[("region", "us-east-1")])]);
        assert!(out.contains("# sleipnir-disabled: sso_start_url = https://example.awsapps.com/start\n"));
        assert!(out.contains("# sleipnir-disabled: sso_role_name = AccountAdmin\n"));
        assert!(out.contains("# sleipnir-disabled: credential_process = \"/old/sleipnir\" creds --profile gitf\n"));
        // Non-credential keys and comments untouched.
        assert!(out.contains("\nca_bundle = /Users/mp/.vpb/ca-bundle.pem\n"));
        assert!(out.contains("\n# GhostInTheFactory-Production via IAM Identity Center\n"));
        assert!(out.contains("\nregion = us-east-1\n"));
    }

    #[test]
    fn rename_moves_header_and_credential_process_only() {
        let dir = std::env::temp_dir().join(format!("sleipnir-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cfg-rename");
        std::fs::write(
            &path,
            "[profile ghostinthefactory]\n# managed by sleipnir\ncredential_process = \"/x/sleipnir\" creds --profile ghostinthefactory\nregion = us-east-2\n\n[profile other]\nregion = eu-west-1\n",
        )
        .unwrap();
        rename_profile_at(&path, HeaderStyle::ConfigProfile, "ghostinthefactory", "gitf").unwrap();
        let out = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            out,
            "[profile gitf]\n# managed by sleipnir\ncredential_process = \"/x/sleipnir\" creds --profile gitf\nregion = us-east-2\n\n[profile other]\nregion = eu-west-1\n"
        );
    }

    #[test]
    fn does_not_match_key_in_comment_or_other_stanza() {
        let initial = "[profile svc]\n# region = commented\noutput = json\n";
        let out = run(initial, &[keys("svc", &[("region", "us-east-2")])]);
        assert_eq!(out, "[profile svc]\n# region = commented\noutput = json\nregion = us-east-2\n");
    }

    /// Modeled byte-for-byte on this machine's real vpb-managed file:
    /// no-space `key=value` lines, a nested `s3 =` block with indented
    /// sub-keys, and vpb's overwrite-warning comments. Everything outside
    /// the touched stanza must survive identically.
    #[test]
    fn real_vpb_file_shape_survives() {
        let initial = "\
[default]
# vpb — managed, edits below are overwritten
ca_bundle = /Users/mp/.vpb/ca-bundle.pem
azure_tenant_id=c314ce1a
region=us-east-2
output = json
s3 =
    max_concurrent_requests = 50

    multipart_threshold = 64MB
[profile SAFE_PPE]
# vpb — managed, edits below are overwritten
ca_bundle = /Users/mp/.vpb/ca-bundle.pem
source_profile=nieto
region=us-east-1
";
        let out = run(initial, &[keys("core-services", &[("region", "us-east-2")])]);
        assert!(out.starts_with(initial), "existing content must be untouched");
        assert!(out.ends_with("\n[profile core-services]\n# managed by sleipnir\nregion = us-east-2\n"));
    }
}
