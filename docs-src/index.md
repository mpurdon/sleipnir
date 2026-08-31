---
title: Overview
order: 0
summary: Sleipnir is a Norse-themed AWS SSO credential manager for macOS — one login, auto-discovered services, one-click project engagement.
---

# Sleipnir

Sleipnir turns your AWS organization into a short list of **services** and
**projects** you can switch on and off, and it delivers real credentials to
every tool on your machine — terminals, SDKs, IDE plugins, and sandboxed
apps alike.

One login. One scan. Then a click to work, and a click to stand down.

<ul class="cards">
  <li><a href="getting-started.html"><span class="c-title">Getting started →</span><span class="c-desc">Install, connect your org, and engage your first service in about five minutes.</span></a></li>
  <li><a href="discovery.html"><span class="c-title">Discovery →</span><span class="c-desc">How one scan turns 166 raw accounts into services with environments.</span></a></li>
  <li><a href="engaging.html"><span class="c-title">Engaging →</span><span class="c-desc">What actually lands in your AWS files when you press ENGAGE.</span></a></li>
  <li><a href="safety.html"><span class="c-title">Safety →</span><span class="c-desc">Press-and-hold on production, mode fallback, and why disengage is real.</span></a></li>
</ul>

## The idea

Most credential managers make you describe your organization to them: name
every account, paste every role ARN, keep it all in sync by hand forever.

Sleipnir reads it instead. AWS organizations almost always name accounts
along a convention — `Core Services Development`, `Core Services Staging`,
`Core Services Production` — and that convention already encodes everything
needed to group four accounts into one service with four environments.
Sleipnir applies that grouping in one scan, shows you the result in a review
table, and lets you correct anything before a single line is written.

## The three things to understand

**A service** is one logical system, spanning its environments. `Core
Services` is a service; its SBX, DEV, STG and PRD accounts are its
environments. The service's short name — its **alias** — is what becomes
the AWS profile name you type in a terminal.

**A project** is a bundle of services you work on together. Engaging a
project fetches credentials for every member at once, so the four terminals
you were about to open all work without four separate logins.

**Engaging** is the act of putting live credentials on your machine.
Sleipnir writes real static keys into `~/.aws/credentials`, which means
every consumer works — including sandboxed apps that cannot execute a
credential helper. **Disengaging removes those keys from the file.** It is a
real off-switch, not a flag that asks tools nicely to stop.

> [!NOTE]
> Sleipnir never rewrites your AWS files wholesale. It edits the specific
> key lines inside the stanzas it owns and leaves every other byte exactly
> as it found it — your comments, your hand edits, and other tools'
> stanzas all survive. See [Your AWS files](aws-files.md).

## Where things live

| Path | What it holds |
| --- | --- |
| `~/.sleipnir/config.toml` | Your orgs, services, and projects |
| `~/.sleipnir/state.json` | What is engaged right now, pins, last-used env/mode |
| `~/.sleipnir/cache/` | Per-profile role credentials |
| `~/.aws/config` | A `[profile <alias>]` stanza per engaged service (region) |
| `~/.aws/credentials` | The live static keys, removed on disengage |
| `~/.aws/sso/cache/` | Your SSO access token, in the AWS CLI's own format |
| macOS Keychain | The SSO refresh token and OIDC client registration |

## Requirements

- Apple Silicon Mac, macOS Monterey or newer
- An AWS IAM Identity Center (SSO) start URL for your organization
- The AWS CLI, if you want to use the ⚡ connection test

Sleipnir is signed and notarized, so it installs and launches with no
Gatekeeper workarounds.

```sh
brew install --cask mpurdon/tap/sleipnir-aws
```

Ready? [Get started →](getting-started.md)
