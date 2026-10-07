# Playground save/restore harness

Behavioural checks for the save -> restore round trip of a playground sandbox conversation
(migration 074): that the transcript the next prompt sees is unchanged by a reload, that each
turn keeps the session it RAN with rather than the one after it, and that a restored
conversation re-saves byte-identically.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`app/admin/(authed)/playground/_lib/history.ts`, `lib/schemas/playground.ts`, or
`PlaygroundTurn` in `app/admin/(authed)/playground/_lib/types.ts`.

## Run it

From the repo root, on Node 24:

```bash
npx tsx scripts/harness/playground-save/harness.ts
```

It prints one `PASS` or `FAIL` line per check and exits non-zero if any failed.
No model calls, no network, no database - it runs in under a second.

## What it is actually guarding

One defect, and it is silent.

A turn restored from a save has reply bubbles and **no trace**. Every other turn in the
playground has a trace. So a reply read written the obvious way - reach into
`turn.response.trace.generation.output.messages` - returns nothing for a restored turn, and
`sessionHistoryFromTurns` then builds a transcript in which the guest speaks and the venue
never answers. Nothing throws. The conversation renders correctly on screen, because the
bubbles come from a different field. The only symptom is that the next reply is generated
against a conversation that did not happen, which reads as the model being inexplicably bad
at continuity.

`replyBubblesOf` is the single definition that closes it, and the chat bubbles and the
transcript builder both go through it on purpose.

Confirmed by ablation (2026-10-06): reverting `replyBubblesOf` to the trace-only read drops
the restored transcript from 7 entries to 1 and fails 4 of the 9 checks. A guard whose
failure mode you have not watched happen is not known to work.

## What it does not cover

The routes and the table. This is the pure half only; nothing here touches Postgres. The DB
half was checked by hand against the live table on 2026-10-06 (insert, read back, parse
through `PlaygroundConversationTurnsSchema` and `parsePlaygroundNextSession`, delete): turns,
sessions, empty replies and verdicts all survive.

**One thing that surprises people there: Postgres JSONB does not preserve object key order.**
A conversation written as `{inbound, reply, verdict}` reads back as `{reply, inbound,
verdict}`. The DATA is identical - array order, values, absent keys all intact - so nothing
in the code notices, because every read goes through Zod into a typed object. The
byte-identity check in this harness is therefore an **in-memory** property of the converters
only, and is not true across a database round trip. Do not "fix" that by adding a stable
stringify somewhere; there is nothing to fix.
