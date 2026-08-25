//! Line-preserving `~/.aws/config` editor.
//!
//! Hard requirement: this machine's `~/.aws/config` is co-managed by the
//! user's `vpb` tool (`# vpb — managed` markers, `ca_bundle` lines) and by
//! hand edits. sleipnir therefore NEVER rewrites the file wholesale — it
//! edits individual key lines inside its target `[profile X]` stanzas and
//! leaves every other byte exactly as found (comments, blank lines,
//! unknown keys, other stanzas). Writes are atomic (temp + rename).
//!
//! No inline `# sleipnir` tags on key lines: the AWS CLI does not strip
//! trailing comments, so a tag would corrupt the value. Stanzas sleipnir
//! creates get a standalone `# managed by sleipnir` comment line instead.

use std::io;
use std::path::{Path, PathBuf};

pub fn default_path() -> PathBuf {
    dirs::home_dir().expect("home directory").join(".aws").join("config")
}

/// One profile stanza's sleipnir-owned keys. Any other keys already in the
/// stanza (vpb's `ca_bundle`, hand-added settings) are preserved untouched.
#[derive(Debug, Clone)]
pub struct ProfileKeys {
    pub profile: String,
    pub keys: Vec<(String, String)>,
}

fn is_section_header(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('[') && t.ends_with(']')
}

fn header_for(profile: &str) -> String {
    format!("[profile {profile}]")
}

fn section_matches(line: &str, profile: &str) -> bool {
    line.trim() == header_for(profile)
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

/// Upserts every given profile's keys in one atomic write. Creates missing
/// stanzas at EOF; within existing stanzas replaces only the named keys in
/// place (or appends them at the stanza's end), preserving everything else
/// byte-for-byte.
pub fn upsert_profiles(path: &Path, profiles: &[ProfileKeys]) -> io::Result<()> {
    let original = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let had_trailing_newline = original.is_empty() || original.ends_with('\n');
    let mut lines: Vec<String> = original.lines().map(str::to_string).collect();

    for spec in profiles {
        upsert_one(&mut lines, spec);
    }

    let mut out = lines.join("\n");
    if had_trailing_newline && !out.is_empty() {
        out.push('\n');
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("sleipnir-tmp");
    std::fs::write(&tmp, out)?;
    std::fs::rename(&tmp, path)
}

/// Credential-source keys that OUTRANK `credential_process` in the AWS
/// CLI's resolution chain (SSO config, assume-role, static keys). Left in
/// place they silently override sleipnir's engagement — the stanza would
/// say READONLY in the rail while terminals resolve something else
/// entirely. Engage comments them out (reversibly, with a marker) rather
/// than deleting.
const CONFLICTING_KEYS: &[&str] = &[
    "sso_start_url",
    "sso_region",
    "sso_account_id",
    "sso_role_name",
    "sso_session",
    "role_arn",
    "source_profile",
    "credential_source",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
    "web_identity_token_file",
];

const DISABLED_MARKER: &str = "# sleipnir-disabled: ";

fn upsert_one(lines: &mut Vec<String>, spec: &ProfileKeys) {
    // Locate the stanza: [start, end) where end is the next section header
    // or EOF.
    let start = lines.iter().position(|l| section_matches(l, &spec.profile));

    let Some(start) = start else {
        // New stanza at EOF, separated by a blank line.
        if !lines.is_empty() && !lines.last().unwrap().trim().is_empty() {
            lines.push(String::new());
        }
        lines.push(header_for(&spec.profile));
        lines.push("# managed by sleipnir".to_string());
        for (k, v) in &spec.keys {
            lines.push(format!("{k} = {v}"));
        }
        return;
    };

    let end = lines[start + 1..]
        .iter()
        .position(|l| is_section_header(l))
        .map(|off| start + 1 + off)
        .unwrap_or(lines.len());

    // Neutralize higher-precedence credential sources already in the
    // stanza so credential_process actually takes effect.
    let writes_credential_process = spec.keys.iter().any(|(k, _)| k == "credential_process");
    if writes_credential_process {
        for line in &mut lines[start + 1..end] {
            if CONFLICTING_KEYS.iter().any(|k| line_sets_key(line, k)) {
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

/// Renames a `[profile old]` stanza in place — header line plus any
/// `credential_process` value referencing `--profile old` — leaving every
/// other byte untouched. A missing stanza is a no-op.
pub fn rename_profile(path: &Path, old: &str, new: &str) -> io::Result<()> {
    let original = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let had_trailing_newline = original.is_empty() || original.ends_with('\n');
    let mut lines: Vec<String> = original.lines().map(str::to_string).collect();

    let Some(start) = lines.iter().position(|l| section_matches(l, old)) else {
        return Ok(());
    };
    let end = lines[start + 1..]
        .iter()
        .position(|l| is_section_header(l))
        .map(|off| start + 1 + off)
        .unwrap_or(lines.len());

    lines[start] = header_for(new);
    for line in &mut lines[start + 1..end] {
        if line_sets_key(line, "credential_process") {
            *line = line.replace(&format!("--profile {old}"), &format!("--profile {new}"));
        }
    }

    let mut out = lines.join("\n");
    if had_trailing_newline && !out.is_empty() {
        out.push('\n');
    }
    let tmp = path.with_extension("sleipnir-tmp");
    std::fs::write(&tmp, out)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(initial: &str, profiles: &[ProfileKeys]) -> String {
        let dir = std::env::temp_dir().join(format!("sleipnir-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("cfg-{:p}", initial.as_ptr()));
        if !initial.is_empty() {
            std::fs::write(&path, initial).unwrap();
        } else {
            let _ = std::fs::remove_file(&path);
        }
        upsert_profiles(&path, profiles).unwrap();
        let out = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        out
    }

    fn keys(profile: &str, kv: &[(&str, &str)]) -> ProfileKeys {
        ProfileKeys {
            profile: profile.into(),
            keys: kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    #[test]
    fn creates_stanza_in_empty_file() {
        let out = run("", &[keys("svc", &[("region", "us-east-2"), ("credential_process", "\"/x/sleipnir\" creds --profile svc")])]);
        assert_eq!(
            out,
            "[profile svc]\n# managed by sleipnir\nregion = us-east-2\ncredential_process = \"/x/sleipnir\" creds --profile svc\n"
        );
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
        let out = run(initial, &[keys("svc", &[("region", "us-east-2"), ("credential_process", "X")])]);
        // vpb's comment, the other stanza, and svc's ca_bundle survive
        // byte-for-byte; only svc's region changed + credential_process added.
        assert!(out.contains("# vpb — managed\n[profile other]\nca_bundle = /etc/vpb/ca.pem\nregion = us-east-1\n"));
        assert!(out.contains("[profile svc]\nca_bundle = /etc/vpb/ca.pem\nregion = us-east-2\ncredential_process = X\n"));
    }

    #[test]
    fn inserts_before_trailing_blank_line_of_stanza() {
        let initial = "[profile svc]\nregion = us-west-2\n\n[profile tail]\nregion = eu-west-1\n";
        let out = run(initial, &[keys("svc", &[("credential_process", "X")])]);
        assert_eq!(
            out,
            "[profile svc]\nregion = us-west-2\ncredential_process = X\n\n[profile tail]\nregion = eu-west-1\n"
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
        let out = run(initial, &[keys("core-services", &[("credential_process", "\"/x/sleipnir\" creds --profile core-services"), ("region", "us-east-2")])]);
        // Original content is a byte-identical prefix; new stanza appended.
        assert!(out.starts_with(initial), "existing content must be untouched");
        assert!(out.ends_with(
            "\n[profile core-services]\n# managed by sleipnir\ncredential_process = \"/x/sleipnir\" creds --profile core-services\nregion = us-east-2\n"
        ));
    }

    /// A pre-existing profile with SSO config: those keys outrank
    /// credential_process in the CLI chain, so engage must comment them
    /// out or the engagement is cosmetic (rail says READONLY, terminal
    /// gets whatever the old SSO config grants).
    #[test]
    fn engage_disables_conflicting_credential_sources() {
        let initial = "\
[profile gitf]
ca_bundle = /Users/mp/.vpb/ca-bundle.pem
# GhostInTheFactory-Production via IAM Identity Center
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
sso_account_id = 515020252848
sso_role_name = AccountAdmin
region = us-east-1
";
        let out = run(initial, &[keys("gitf", &[("credential_process", "X creds --profile gitf"), ("region", "us-east-1")])]);
        assert!(out.contains("# sleipnir-disabled: sso_start_url = https://example.awsapps.com/start\n"));
        assert!(out.contains("# sleipnir-disabled: sso_role_name = AccountAdmin\n"));
        // Non-credential keys and comments untouched.
        assert!(out.contains("\nca_bundle = /Users/mp/.vpb/ca-bundle.pem\n"));
        assert!(out.contains("\n# GhostInTheFactory-Production via IAM Identity Center\n"));
        assert!(out.contains("\nregion = us-east-1\n"));
        assert!(out.contains("\ncredential_process = X creds --profile gitf\n"));
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
        rename_profile(&path, "ghostinthefactory", "gitf").unwrap();
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
}
