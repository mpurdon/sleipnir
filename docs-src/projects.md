---
title: Projects
order: 50
summary: Bundle the services you work on together and engage them as a single unit.
---

# Projects

A **project** is a named bundle of services. Engaging it fetches
credentials for every member at once, at the same environment and mode.

If your work touches four accounts at a time, this is the difference
between four engages and one.

## Creating a project

In the PROJECTS drawer, press **+ NEW PROJECT**, name it, and tick the
services that belong to it. Projects are scoped to one org.

Name it after the work, not the infrastructure — *checkout-rewrite* or
*incident-4471* beats *core-plus-payments*. The point is to have a button
that matches the thing you are actually doing.

## Engaging a project

Press **ENGAGE** on the project card. Every member is engaged at the chosen
environment and mode, and they appear in the rail grouped under the project
name.

The card's button carries the same rules as a single service: it names the
environment and mode, it is red for production, and ADMIN on PRD requires a
[press-and-hold](safety.md#press-and-hold-on-production).

### Partial failure is normal

One member failing never blocks the rest. If a service in the bundle has no
role you can assume on that environment, the others still engage and the
failure is reported per row. You get the working subset rather than an
all-or-nothing error.

This matters more than it sounds: a project spanning six accounts where one
has a permissions gap is still a project you can work in.

## Changing environment or mode

**CHANGE ENV/MODE** on the card reveals the selectors. The available
choices are the union of what the members support, so a project containing
a standalone account and a four-environment service offers everything both
can do.

Your last choice per project is remembered, and the card shows it —
`4 SERVICES · LAST PRD/READONLY` — so you can see what a click will do
before you make it.

## Editing membership

**✎ EDIT SERVICES** opens the project so you can add or remove members.
Changes take effect on the next engage; services already engaged from a
previous run stay engaged until you disengage them.

## Pinning

The ★ pins a project to the top of the list. Unpinned projects sort by how
recently you engaged them, so the list stays roughly in the order you
actually work — and the pin overrides that for the two or three you always
want first.

## Disengaging a project

The disconnect icon on the project's group in the rail disengages every
member in one action. **DISENGAGE ALL** clears everything, across all
projects and ad-hoc engages.

Individual members can be disengaged on their own from inside the group,
if you want to drop production access but keep the rest.

## Projects versus ad-hoc engages

A service engaged directly from the SERVICES drawer is an **ad-hoc**
engage. It stands alone in the rail rather than joining a project group.

Both deliver identical credentials — the grouping is bookkeeping, so you
can disengage a whole piece of work at once and see at a glance what is on.

> [!TIP]
> Engaging the same service from two projects at different environments is
> a conflict, not a merge: one AWS profile can only hold one set of keys.
> Sleipnir warns before repointing a profile another project is using, so
> you do not silently pull the ground out from under a terminal you had
> open. Re-engaging a service from its own row skips that warning, since
> the only thing it can collide with is itself.
