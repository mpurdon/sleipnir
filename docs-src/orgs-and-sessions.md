---
title: Orgs & sessions
order: 20
summary: How Sleipnir handles AWS SSO logins, token refresh, and the session countdown — and why you only ever see one login.
---

# Orgs & sessions

An **org** is one AWS IAM Identity Center instance. Most people have one.
If you work across several AWS organizations — a client's and your own, say
— add each as its own org and switch between them in the rail.

## Adding an org

Click **+ ADD ORG** in the rail and provide:

| Field | What it is |
| --- | --- |
| Name | A label of your choosing. Used only in the UI. |
| Start URL | Your Identity Center start URL, e.g. `https://acme.awsapps.com/start` |
| Region | Where Identity Center itself is hosted — *not* where your workloads run |

The region trips people up. It is the region your administrator created
Identity Center in, commonly `us-east-1`. If logins fail with a region
error, that is the field to check first.

## What a login actually does

Pressing log in starts the standard AWS **device authorization** flow:

1. Sleipnir registers itself as an OIDC client (once per org, cached).
2. Your browser opens AWS's approval page.
3. You approve, and AWS issues an access token and a refresh token.

The access token is written to `~/.aws/sso/cache/` in exactly the format the
AWS CLI and botocore use, so a token from `aws sso login` works in Sleipnir
and a token from Sleipnir works in the CLI. The refresh token and the client
registration go into the macOS Keychain.

> [!NOTE]
> The access token deliberately lives in the same plaintext cache the AWS
> CLI uses. Sleipnir has to read and write that exact file for interop, so
> storing it anywhere stricter would be security theatre — the file would
> still be there, written by the CLI. The long-lived secret, the refresh
> token, is the one in the Keychain.

## The session countdown

The lamp beside each org tells you where the session stands:

| Lamp | Label | Meaning |
| --- | --- | --- |
| Green | `4H 12M` | Healthy, counting down |
| Gold | `24M` | Under 30 minutes left |
| Red | `LOG IN ▸` | Expired — clicking the row starts a login |

The countdown is the **real** SSO session boundary set by your
administrator, not an app-level timer. When it runs out, you genuinely have
to authenticate with AWS again.

## Why you only see one login

Between those boundaries, Sleipnir keeps things alive without bothering you:

- The **hourly access token** rotates silently in the background using the
  Keychain refresh token. No browser, no prompt.
- **Engaged profiles' keys** are refreshed before they expire, so a terminal
  you left open yesterday still works this morning.
- If you press ENGAGE while the session happens to be dead, the login runs
  first and **the same engage continues automatically afterwards**. Your one
  click survives the detour.

A dead session never silently opens a browser on its own — background
refresh gives up quietly and waits for you.

## Switching orgs

Clicking an org row makes it active; the PROJECTS and SERVICES drawers then
show that org's contents. If the session is dead, the click *is* the
reconnect — the login starts immediately rather than making you find a
button.

## Signing out and removing

Open an org's settings with the ⚙ beside its name.

- **Sign out** clears the cached credentials — token cache file and Keychain
  entries — but keeps the org, its services and its projects. The next login
  starts a fresh browser approval.
- **Delete** removes the org along with every service and project that
  references it, plus its cached credentials.

> [!WARNING]
> Deleting an org removes its services and projects from
> `~/.sleipnir/config.toml`. Profiles that are currently engaged should be
> disengaged first, so their keys are stripped from `~/.aws/credentials`
> rather than left behind.

## Multiple orgs at once

Nothing stops you engaging services from two different orgs simultaneously
— the engaged list in the rail simply shows both. Each org's session is
tracked independently, so one expiring does not disturb the other.

The only real constraint is profile names: two orgs with a service that
resolves to the same alias would collide in `~/.aws/credentials`. Rename one
of them — see [Services](services.md#renaming-a-service).
