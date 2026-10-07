# Offer-more-help harness

Behavioural checks for two rules about the offer-more-help line (both ruled 2026-10-07).

**One offer per conversation.** Once a message of ours in the current conversation has ended
with an offer, no later reply in it carries one. The rule is in `lib/agent/previous-offer.ts`
and `lib/ai/further-help-offer.ts`.

**A draft held for an operator never carries the line.** An approved draft is sent as one message, verbatim, so
nothing would send the offer as its own message the way an auto-send does, and behind a link
it reads as a run-on. The rule is in `lib/agent/held-draft-body.ts`.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`lib/agent/held-draft-body.ts`, `lib/agent/previous-offer.ts`, `lib/ai/further-help-offer.ts`, the tail handling in
`lib/agent/sentence-split.ts`, or where `lib/agent/schedule-and-send.ts` stores a held
draft's text.

## Run it

From the repo root, on Node 24:

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/harness/held-draft-offer/harness.ts
```

It prints one `ok` or `FAIL` line per check and exits non-zero if any failed.

## What it can and cannot show

It drives the real `heldDraftBody`, `withoutOfferBubble`, `offeredThisConversation`,
`previousReplyOffered`, `decideFurtherHelpOffer`, `appendFurtherHelpOffer`,
`resolveDispatchBubbles` and `resolveOutboundTail` with constructed replies and threads. The
link and emoji held-draft checks each sit beside a control showing the same reply auto-sent;
the once-per-conversation checks sit beside controls where the offer is still sent (a first
answer, an offer older than the conversation window, an offer in a draft the guest never
received).

Which earlier messages can count is decided by how they were sent: only a reply to the guest,
by the row's category. A close, a sign-off, a greeting or a follow-up never counts, including
one sent under a category that does not exist yet. Inside those replies the offer is
recognised by its wording, because nothing stored marks a sent message as an offer. The checks use the wording of the 2026-10-07 phone thread; they do
not show that every offer the model can write is recognised.

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
| the once-per-conversation veto removed from `decideFurtherHelpOffer` | both "once: ..." checks |
| `couldCarryOffer` made to accept every category | the five "sent as ..." pairs |
| `previousReplyOffered` put back on the wide wording list | all eight "not an offer" checks |
