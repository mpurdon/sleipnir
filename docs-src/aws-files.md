---
title: Your AWS files
order: 80
summary: Exactly what Sleipnir writes to ~/.aws/config and ~/.aws/credentials, and how it coexists with your hand edits and other tools.
---

# Your AWS files

Sleipnir edits two files you probably already care about. This page is the
full account of what it does to them.

## The guarantee

**Sleipnir never rewrites either file wholesale.** It edits individual key
lines inside the stanzas it owns and leaves every other byte exactly as it
found it — your comments, your blank lines, your unknown keys, and other
tools' stanzas.

Writes are atomic: a temporary file is written and renamed into place, so
an interrupted write cannot leave you with half a config.

This is a hard requirement, not an aspiration. These files are commonly
co-managed by other tooling and by hand, and a credential manager that
reformats them on every engage would be unusable.

## What lands in `~/.aws/config`

One stanza per engaged service, carrying the region:

```ini
[profile core-services]
# managed by sleipnir
region = us-east-2
```

That is all. No secret is written to `config`, and the stanza survives
disengaging — it holds nothing sensitive, and keeping it means your profile
names stay stable across engage cycles.

## What lands in `~/.aws/credentials`

The live credentials, under a bare header:

```ini
[core-services]
aws_access_key_id = ASIA...
aws_secret_access_key = ...
aws_session_token = ...
```

These three keys are the entire payload, and they are what disengage
removes.

> [!NOTE]
> The two files use different header styles — `[profile name]` in `config`,
> bare `[name]` in `credentials`. Sleipnir tracks which style belongs to
> which file in a way that makes the wrong pairing impossible to express,
> because that mismatch is a classic and silent source of broken profiles.

## No inline comment tags

Stanzas Sleipnir creates get a standalone marker line:

```ini
# managed by sleipnir
```

Never a trailing tag on a key line. The AWS CLI does not strip trailing
comments from values, so `region = us-east-2 # sleipnir` would give you a
region of `us-east-2 # sleipnir` and a confusing failure.

## Taking over an existing profile

If a stanza Sleipnir is about to manage already contains credentials — a
`credential_process` line, inline static keys, a `source_profile` — those
would outrank or conflict with what Sleipnir writes. You would end up
authenticated as something other than what the app reports.

Sleipnir neutralises them by commenting them out, prefixed so the origin is
obvious:

```ini
# sleipnir-disabled: credential_process = "/old/tool" creds --profile gitf
```

Nothing is deleted. If you stop using Sleipnir for that profile, uncomment
the line and you are back where you were.

## Coexisting with other tools

Other stanzas are untouched. If another tool manages `[profile legacy-thing]`
with its own markers and its own keys, Sleipnir reads past it and writes
nothing there.

The overlap to watch for is a **name collision**: if another tool owns a
profile with the same name as one of your Sleipnir aliases, both will write
to the same stanza and the last writer wins. Rename the Sleipnir alias —
see [Services](services.md#renaming-a-service).

## SSO token interop

Sleipnir reads and writes `~/.aws/sso/cache/` in exactly the format the AWS
CLI and botocore use, keyed by session name the same way. In practice:

- `aws sso login` produces a token Sleipnir can use.
- Logging in through Sleipnir produces a token the AWS CLI can use.

Sleipnir always writes the modern `sso-session`-keyed form, never the
legacy per-profile variant.

## Reverting everything

To take Sleipnir back out of your AWS files:

1. **DISENGAGE ALL** in the app. This removes every static key it wrote
   from `~/.aws/credentials`.
2. Delete the `[profile <alias>]` stanzas from `~/.aws/config` for services
   you no longer want. They contain only a region and a comment.
3. Uncomment any `# sleipnir-disabled:` lines you want back.

To remove Sleipnir's own data as well:

```sh
brew uninstall --cask --zap sleipnir-aws
```

The `--zap` also removes `~/.sleipnir` and the app's logs. Keychain entries
are removed when you delete an org in the app, so do that first if you want
a clean sweep.
