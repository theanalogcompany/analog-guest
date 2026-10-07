# Held-draft offer harness

Behavioural checks for one rule (ruled 2026-10-07): **a draft held for an operator never
carries the offer-more-help line.** An approved draft is sent as one message, verbatim, so
nothing would send the offer as its own message the way an auto-send does, and behind a link
it reads as a run-on. The rule is in `lib/agent/held-draft-body.ts`.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`lib/agent/held-draft-body.ts`, `lib/ai/further-help-offer.ts`, the tail handling in
`lib/agent/sentence-split.ts`, or where `lib/agent/schedule-and-send.ts` stores a held
draft's text.

## Run it

From the repo root:

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/harness/held-draft-offer/harness.ts
```

It prints one `ok` or `FAIL` line per check and exits non-zero if any failed.

## What it can and cannot show

It drives the real `heldDraftBody`, `appendFurtherHelpOffer`, `resolveDispatchBubbles` and
`resolveOutboundTail` with constructed replies. Each "the offer is gone" check sits beside a
control showing the same reply auto-sent, with the offer as its own last message.

The last two checks read `lib/agent/schedule-and-send.ts` as text and assert that both
places a held draft's body is stored go through `heldDraftBody`. That is a wiring check, not
a behavioural one: it does not run the queue path, which needs a database.

It does **not** show what the model writes, whether a reply is held, or what the operator's
card renders.

## Confirmed to fail

Each of these was applied and the harness re-run before this was committed:

| change | checks that failed |
| --- | --- |
| `heldDraftBody` returns the whole collapsed reply | five: the three answer checks (link, emoji, full stop), the run-on check and the whitespace check |
| one storage site put back to the whole reply | both wiring checks |
