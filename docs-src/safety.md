---
title: Safety
order: 70
summary: Press-and-hold on production, mode fallback that never escalates, and why disengage is a real off-switch.
---

# Safety

Sleipnir makes it easy to hold production admin credentials. That is
genuinely useful and genuinely dangerous, so several of its behaviours
exist specifically to keep the dangerous case deliberate.

The design principle throughout: **safety by construction, not by
dialog.** A confirmation box you dismiss reflexively protects nobody.

## Press-and-hold on production

Engaging **ADMIN** on **PRD** requires holding the button for about a
second and a quarter. Not clicking it — holding it.

A dismissable dialog is defeated by reflex; anyone who has clicked
"Are you sure?" without reading it knows this. A sustained press is a
different motor action. You cannot perform it by accident, and you cannot
perform it while your attention is elsewhere.

While you hold, the button fills to show progress and names exactly what is
about to happen:

```
HOLD — ADMIN → PRD
```

Releasing early cancels. Nothing is fetched, nothing is written.

Every other combination — readonly on production, admin on sandbox — is an
ordinary click. The friction is aimed precisely at the one combination that
earns it.

## Production is always visible

Production is red everywhere it appears, regardless of mode:

- the engage button on service rows and project cards
- the environment chip on engaged profiles in the rail
- the tint of any project group containing a production engage

You never have to read carefully to notice that production is on. It is the
loudest thing on screen.

## Mode fallback never escalates

If you request a mode the account does not grant you, Sleipnir falls back:

```
ADMIN → POWERUSER → READONLY
```

and the UI shows the access you actually received, not the access you
asked for.

**The chain only ever runs downward.** Requesting READONLY never gets you
poweruser or admin, however many roles the account offers. There is no path
through Sleipnir where asking for less gets you more.

This matters because the fallback is otherwise a plausible place for a
privilege bug to hide: a naive "find the best matching role" implementation
would happily hand you admin when you asked for readonly and readonly did
not exist.

## Disengage is a real off-switch

Because credentials are delivered as static keys in `~/.aws/credentials`,
disengaging can — and does — physically remove them.

This is a stronger guarantee than a credential-helper design can offer.
With a helper, disengaging means the helper starts refusing; the profile
still exists and the machinery is still wired up. With static keys,
disengaging means the secret is no longer in the file. A script that runs
afterwards finds nothing to find.

Sleipnir's own `credential_process` resolver honours the same rule: a
profile that is not currently engaged refuses to resolve, even though its
`~/.aws/config` stanza remains.

## Competing credentials are neutralised

If `~/.aws/config` already has keys in a stanza Sleipnir is taking over —
inline static credentials, a `credential_process` line from another tool, a
retired Sleipnir one — those would silently outrank what Sleipnir writes,
and you would be authenticated as something other than what the app says.

Rather than delete them, Sleipnir comments them out:

```ini
# sleipnir-disabled: credential_process = "/old/tool" creds --profile gitf
```

Visible, reversible, and never silently destructive. If you later stop
using Sleipnir for that profile, the original line is right there to
uncomment.

## Where secrets live

| Secret | Where | Why |
| --- | --- | --- |
| SSO refresh token | macOS Keychain | Long-lived; the one worth protecting |
| OIDC client registration | macOS Keychain | Long-lived |
| SSO access token | `~/.aws/sso/cache/` | AWS CLI's own format, for interop |
| Role credentials | `~/.sleipnir/cache/`, `~/.aws/credentials` | Short-lived; removed on disengage |

The access token sits in the same plaintext cache the AWS CLI uses. That is
deliberate: Sleipnir must read and write that exact file so a token from
`aws sso login` works here and vice versa. Storing it somewhere stricter
would not make the file go away — the CLI would still write it.

Everything in the Keychain lives in a single item per org, because macOS
prompts once per item and four items meant four prompts in a row.

## Good habits

- **Engage the least you need.** Readonly for reading. The mode selector is
  right there.
- **Disengage production when you are done**, rather than at the end of the
  day. `DISENGAGE ALL` is one click.
- **Use projects** so standing down is a single action instead of four you
  might do three of.
- **Test after engaging production**, so you find out you have the wrong
  role before you run something instead of after.
