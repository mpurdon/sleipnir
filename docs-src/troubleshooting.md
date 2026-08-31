---
title: Troubleshooting
order: 90
summary: Fixes for login failures, missing accounts, credentials that will not take effect, and where to find the logs.
---

# Troubleshooting

## Start here: the logs

**⚙ SETTINGS → DEVELOPER** shows the application log live, with a filter for
warnings and errors only. Entries that carry structured data expand to show
the request and response shape, which is usually the fastest way to see what
AWS actually said.

The same log is on disk at
`~/Library/Logs/dev.purdonmoi.sleipnir/`.

## Login problems

### Login fails immediately, or with a region error

The **region** field is the region your IAM Identity Center is hosted in,
not the region your workloads run in. These are frequently different. Ask
your administrator which region Identity Center lives in — `us-east-1` is
the most common answer.

### The browser opens but approval does nothing

Check that you approved in a browser session logged into the right AWS
identity. If you are signed into a personal AWS account in that browser, the
approval can succeed against the wrong identity. An incognito window is a
quick way to test.

### Login keeps being required

If every launch demands a fresh login, the refresh token is not surviving in
the Keychain. Open Keychain Access and look for an item named
`dev.purdonmoi.sleipnir`. If macOS is denying access, deleting the item and
logging in once more re-creates it cleanly.

You will get one Keychain prompt per org when Sleipnir first reads its
secrets — that is expected. Choosing **Always Allow** stops it recurring.

## Discovery problems

### The scan finds no accounts

The scan can only see accounts your SSO assignment grants you. If it returns
nothing, the session is valid but the assignment is empty — an
administrator question, not an app one.

### A service I expected is missing

Same cause, usually. Confirm you can see the account in the AWS access
portal in a browser; if it is not there either, it is not assigned to you.

### Accounts grouped into the wrong services

The grouping relies on your organization's naming convention. If your
account names do not encode the environment consistently, uncheck the bad
rows and import the rest — they will import as standalone services, which
work fine, just without the environment switcher. See
[Discovery](discovery.md#when-the-convention-does-not-fit).

## Credential problems

### `aws` says the profile does not exist

Check the profile name matches the alias exactly:

```sh
grep -A1 '^\[' ~/.aws/credentials | head -40
```

If the stanza is absent, the service is not currently engaged. Engage it.

### Commands use the wrong identity even after engaging

**Environment variables win over `~/.aws/credentials`.** This is the single
most common cause. If any of these are set in your shell, they override
everything Sleipnir writes:

```sh
env | grep -E 'AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)'
```

Unset them:

```sh
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
```

A shell that had them exported before you engaged keeps them until you unset
them or open a new terminal.

### Credentials expired mid-task

Engaged profiles refresh in the background, but a machine that was asleep
can wake with stale keys. Run the ⚡ connection test — it rotates stale keys
before probing, so the test itself repairs the common case.

If the org's SSO session has expired, no background refresh can help. Log in
again; the lamp in the rail tells you.

### A sandboxed app cannot see the credentials

It should — static keys in `~/.aws/credentials` are exactly what sandboxed
apps can read, and that is why Sleipnir delivers them that way. Confirm the
app has been granted access to your home directory, and that it is reading
`~/.aws/credentials` rather than expecting environment variables.

### Another tool keeps overwriting the profile

If a profile name is owned by both Sleipnir and another tool, the last
writer wins. Rename the Sleipnir alias so the two stop colliding — see
[Services](services.md#renaming-a-service).

## Connection test problems

### The test fails but the CLI works

Both use the same path, so this generally means they are not using the same
CLI. The test shells out to whatever `aws` resolves to for the app, which
may differ from your shell's if the CLI was installed into a shell-specific
path.

### "command not found" style failures

The connection test needs the AWS CLI installed:

```sh
brew install awscli
```

Everything else in Sleipnir works without it.

## Install problems

### "sleipnir is damaged and can't be opened"

This affected early builds that were not notarized. Update to the current
release, which is signed and notarized:

```sh
brew update && brew upgrade --cask sleipnir-aws
```

### `SHA256 mismatch` during install

A stale download in the Homebrew cache. Clear it and retry:

```sh
brew cleanup -s sleipnir-aws
brew update
brew install --cask mpurdon/tap/sleipnir-aws
```

### The cask cannot be found

Make sure you are using the fully qualified name — there is an unrelated
`sleipnir` in Homebrew core (a web browser):

```sh
brew install --cask mpurdon/tap/sleipnir-aws
```

## Still stuck

Open an issue at
[github.com/mpurdon/sleipnir/issues](https://github.com/mpurdon/sleipnir/issues)
with the relevant lines from **SETTINGS → DEVELOPER**.

> [!WARNING]
> Log entries can contain account IDs, role names and ARNs. Review what you
> paste. Access keys and tokens are not logged, but account structure is
> worth redacting if the repository is not yours.
