---
title: FAQ
order: 100
summary: Short answers about Leapp migration, security, platform support, and how Sleipnir coexists with the AWS CLI.
---

# FAQ

## Is this a Leapp replacement?

That is what it was built to be. The overlap is the core loop: SSO login,
a list of accounts and roles, and a switch to put credentials on your
machine.

The differences that matter day to day:

- **Auto-discovery.** Sleipnir derives services from your organization's
  account naming rather than asking you to describe each one.
- **Projects.** Engage the four accounts a piece of work touches in one
  click, not four.
- **Disengage is physical.** Keys are removed from `~/.aws/credentials`,
  not just marked inactive.

## Do I have to describe my accounts by hand?

No — that is the point of [discovery](discovery.md). One scan groups your
accounts into services and pre-selects roles; you review and import.

There is a manual escape hatch in **SETTINGS → ACCOUNTS** for organizations
whose naming does not fit any convention.

## Where are my secrets stored?

The SSO refresh token and the OIDC client registration are in the macOS
Keychain, in a single item per org.

The SSO access token is in `~/.aws/sso/cache/`, in the AWS CLI's own
plaintext format. That is deliberate — Sleipnir must read and write that
exact file so tokens interoperate with `aws sso login`. Storing it
elsewhere would not remove the file; the CLI writes it too.

Role credentials live in `~/.sleipnir/cache/` and in `~/.aws/credentials`
while engaged, and are removed when you disengage. Full table in
[Safety](safety.md#where-secrets-live).

## Does it work with the AWS CLI?

Yes, in both directions. Sleipnir reads and writes the SSO token cache in
the CLI's format, so `aws sso login` and Sleipnir's login produce tokens
each can use.

Engaged profiles are ordinary AWS profiles:

```sh
aws s3 ls --profile core-services
AWS_PROFILE=core-services terraform plan
```

## Will it break my existing `~/.aws/config`?

No. Sleipnir edits only the key lines inside stanzas it owns and leaves
every other byte alone — comments, blank lines, unknown keys, and other
tools' stanzas all survive. Writes are atomic.

If it takes over a profile that already had credentials, it comments the old
lines out with a `# sleipnir-disabled:` prefix rather than deleting them.
See [Your AWS files](aws-files.md).

## Why static keys instead of `credential_process`?

Coverage. A credential helper requires the consumer to execute a
subprocess, and sandboxed applications cannot. Static keys work everywhere
— terminals, every SDK, IDE plugins, Docker builds that mount `~/.aws`, and
sandboxed GUI apps.

It also makes disengaging meaningful: the secret is removed from disk
rather than a helper starting to refuse.

The `credential_process` resolver still ships for anyone who wires it up by
hand; it is just no longer written into your config automatically.

## How often do I have to log in?

Once per SSO session boundary — typically eight or twelve hours, set by
your administrator.

Inside that window the hourly access token rotates silently and engaged
credentials are refreshed before they expire, so you should not see a
prompt. If you press ENGAGE just as a session dies, the login runs and the
engage resumes automatically afterwards.

## Can I use several AWS organizations?

Yes. Add each as its own org; sessions are tracked independently and you can
have services from several engaged at once.

The one constraint is profile names — two orgs whose services resolve to
the same alias would collide in `~/.aws/credentials`. Rename one.

## Why do I have to hold the button for production admin?

Because a dialog you can dismiss protects nobody. A sustained press is a
different motor action from a click: you cannot do it by reflex, and you
cannot do it while your attention is elsewhere. It applies only to ADMIN on
PRD — every other combination is an ordinary click. See
[Safety](safety.md#press-and-hold-on-production).

## What happens if I ask for a role I do not have?

Sleipnir falls back `ADMIN → POWERUSER → READONLY` and shows the access you
actually got. It never escalates: asking for readonly cannot get you
poweruser or admin.

## Is there a Windows or Intel Mac build?

Not yet. Sleipnir is Apple Silicon, macOS Monterey or newer. Universal
(Intel) builds and Windows packaging are on the roadmap.

Much of the groundwork is portable — the Keychain wrapper already speaks
Windows Credential Manager — but neither is built or tested today.

## How do I uninstall it?

```sh
brew uninstall --cask --zap sleipnir-aws
```

`--zap` also removes `~/.sleipnir` and the app's logs. Disengage everything
first so no keys are left in `~/.aws/credentials`, and delete your orgs in
the app if you want the Keychain entries gone too.

## Where do I report a bug?

[github.com/mpurdon/sleipnir/issues](https://github.com/mpurdon/sleipnir/issues).
Log output from **SETTINGS → DEVELOPER** helps — review it for account IDs
and ARNs before pasting.
