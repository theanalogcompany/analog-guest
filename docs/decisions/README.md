# Decision records

Short records for decisions that span more than one directory and that someone will
otherwise re-litigate. **Not** auto-loaded; read one when the root `CLAUDE.md` points you at
it.

## What belongs here

A decision qualifies on all three:

1. It is **cross-cutting** - no single source file or directory owns it.
2. It is **re-litigable** - the tidy, obvious-looking alternative is wrong, and someone will
   reach for it.
3. It is **not already in a source header**. Where a module explains itself, that header is
   the authority and a copy here would go stale.

## What does not

- Incident narratives and mutation results. Those go in the PR description or the commit
  body.
- Per-ticket measurement runs. Git holds them.
- Anything one directory owns. That is a nested `CLAUDE.md` or a source header.

## Format

Title, date, status, then: **Decision**, **Why**, **What breaks if reversed**, **Where it
lives**. Keep it under a screen. A record that needs scrolling is documentation, not a
decision.

## Index

| # | decision |
| --- | --- |
| [0001](0001-claude-md-is-an-index.md) | `CLAUDE.md` is an index; detail is nested and history is in git |
| [0002](0002-deny-list-not-allow-list.md) | A set keyed on a closed vocabulary is a deny-list |
| [0003](0003-post-generation-checks-fail-closed.md) | The five post-generation checks: fail closed pre-send, run post-send on inbound |
| [0004](0004-ticket-branch-owner-is-any-username.md) | a ticket branch is `<username>/<ticket>-...`, any username |
| [0005](0005-inbound-coalescing-settle-window.md) | The settle window is zero; the claim and the extension carry coalescing |
| [0006](0006-two-pending-slots-per-guest.md) | A guest holds two pending cards, one per slot |
| [0007](0007-voice-is-a-static-pack.md) | Voice is a static per-venue pack, not a similarity retrieval |
