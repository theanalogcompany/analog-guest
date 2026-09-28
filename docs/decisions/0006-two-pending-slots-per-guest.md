# 0006 - A guest holds two pending cards, one per slot

**Date:** 2026-09-14, extended 2026-09-21
**Status:** accepted

## Decision

At most one pending draft per guest **per slot**, not per guest.

**Obligation slot:** a pending row whose `pending_commitment.type` is `comp`, `hold` or
`discount`. **Conversation slot:** everything else - no carrier, a recommendation, a blank
knowledge-gap card. Since migration 054 the conversation slot is keyed per **inbound**, so a
guest's second question gets its own card.

`lib/agent/pending-slots.ts` owns the rule, and `decideSlotAction` is the single decision
table shared by the gate, 23505 recovery, the crash card and the operator decline.

## Why

One pending row per guest plus regenerate-in-place meant **a reply to the guest's next question
overwrote a pending comp.** Observed live: a comp draft was replaced by an answer about opening
hours, and the comp was gone with the card looking untouched, because regeneration preserves
`created_at` to keep queue position.

The precondition the regeneration path depended on was never built - nothing told the model the
pending draft was unsent, because history rendered it like a sent message. Marking it helped and
did **not** fix the overwrite; only the second slot did.

**The alternative was measured and rejected.** "Refuse the overwrite, then send beside the card
or drop the reply" would have **dropped 29 of 60 replies** on the incident's own turn shape: the
guest asking about opening hours would get no reply about half the time. Two slots drop none -
a held reply with no structured obligation takes the conversation slot beside the comp card.

Three things about the migration are load-bearing, and all three are easy to get wrong:

- **`coalesce(pending_commitment->>'type', '')`** in both index predicates. Without it a NULL
  carrier evaluates `not in (...)` to NULL and the row matches **neither** index.
- **Create the new index before dropping the old**, in one transaction, so `messages` is never
  without a uniqueness constraint on pending rows.
- **`coalesce(reply_to_message_id, '<sentinel uuid>')`** in the conversation key. NULLs are
  distinct in a unique index, so a bare column gives every proactive card - manual followups,
  the decline, the crash card - no uniqueness at all.

## What breaks if reversed

Going back to one slot restores the overwrite: an operator loses a comp draft they were about to
approve, silently, with the card's timestamp unchanged.

Going the other way and letting anything overwrite anything loses the operator's outstanding
question. The obligation slot is never overwritten by a *different* obligation, whatever the
caller's policy - one send, one card.

**New code must not run against migration 041 alone.** It cannot overwrite a card there, but
every second conversation card fails: the INSERT hits the per-guest index, recovery finds the
slot empty, retries, exhausts the attempt budget and red-alerts with no reply to the guest.
There is a deploy-window test pinning exactly that.

## Where it lives

`lib/agent/pending-slots.ts` · migrations 041, 042, 054 · `lib/agent/two-pending-slots.test.ts`,
which runs the real gate and persist layer against an in-memory `messages` table that enforces
the index.

The SQL type list and `OBLIGATION_TYPES` move together, and a test reads the migration file to
enforce it. The in-memory fake writes the list out longhand rather than importing it, because a
fake that reused the code under test would agree with it by construction.

Never read a pending draft with a bare `.limit(1)` or `.maybeSingle()` - an unordered
single-row read returns an arbitrary one of the two slots. A source-level guard enforces it.
