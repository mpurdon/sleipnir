---
title: Services
order: 40
summary: Browse, rename, and engage individual services; how environment and mode selection works.
---

# Services

A **service** is one logical system together with its environments. The
SERVICES drawer is the catalogue of everything Sleipnir discovered for the
active org.

## Finding a service

The filter box at the top matches on both the display name and the alias,
so `core` finds *Core Services* and `gitf` finds whatever you renamed
`ghostinthefactory` to. It focuses automatically when the drawer opens —
just start typing.

## Engaging one service

Click a service to expand it, then:

1. Pick an **environment** — SBX, DEV, STG, PRD.
2. Pick a **mode** — READONLY, POWERUSER, ADMIN.
3. Press **ENGAGE**.

The button always names exactly what it is about to do
(`ENGAGE PRD/ADMIN`), and it is coloured by the mode — with production in
red regardless of mode, because production is the thing worth noticing.

Your last environment and mode for each service are remembered, so the
common case is one click.

> [!WARNING]
> Engaging ADMIN on PRD requires a press-and-hold, not a click. See
> [Safety](safety.md#press-and-hold-on-production).

Standalone services — the ones with no environment dimension — show no
environment selector, only modes.

## Renaming a service

The alias *is* the AWS profile name. `ghostinthefactory` is a lot to type
in every command, so shorten it.

Expand the service and edit the **PROFILE** field, then press **RENAME**.
Aliases must be lowercase letters, digits and dashes.

The rename is thorough. It updates:

- the service in `~/.sleipnir/config.toml`
- every project that lists it as a member
- the engaged map and last-used memory in `state.json`
- the cached credentials file for that profile
- the `[profile <alias>]` stanza in `~/.aws/config`

So renaming an engaged profile keeps it engaged, under the new name.

> [!NOTE]
> Renaming does not update anything *outside* Sleipnir. Scripts, IDE
> settings, `AWS_PROFILE` exports and CI configuration that referenced the
> old name need updating by hand.

## Mode fallback

If you ask for a mode the account does not offer you, Sleipnir degrades
rather than failing:

```
ADMIN → POWERUSER → READONLY
```

Requesting ADMIN on an account where you only have poweruser engages
poweruser, and the UI says so — the label shows the access you actually
got, not the access you asked for.

**The chain never runs upward.** Asking for READONLY never gets you
poweruser or admin, no matter what roles exist. Degradation is always
toward less access.

## Role resolution

When a mode maps to more than one role, the effective one is picked in this
order:

1. An explicit per-environment pick you made in the review table
2. The service-wide preference, if that role exists on this environment
3. The shortest classified candidate — the least specialised one

That is the same resolution used at engage time and in the review table's
preview, so what the table shows you is what you get.

## What is engaged

An engaged service shows a coloured dot and its current
environment/mode in the catalogue row, and appears in the rail's engaged
list. Engaging the same service again with a different environment or mode
repoints it — the old keys are replaced, not added to.

## Removing a service

Services you no longer want can be deleted from **⚙ SETTINGS**. Disengage
first if it is currently engaged, so its keys are removed from
`~/.aws/credentials` rather than orphaned.

A deleted service reappears as a candidate on the next re-scan, since
discovery reads your organization rather than your history.
