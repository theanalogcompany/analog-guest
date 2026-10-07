# First-visit flow harness

Behavioural checks for which question, if any, a turn of a guest's first visit carries
(TAC-575): nothing about the guest in a first reply, "how is it so far?" right after they name
their order, how their answer is read, and the quiet after a warm close.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`lib/agent/intentions/definitions.ts`, `lib/agent/intentions/derive.ts`,
`lib/agent/visit-checkin.ts`, `lib/agent/visit-checkin-timeout.ts`, `lib/agent/warm-close.ts`, `lib/agent/retrieval-context.ts`, or
the intentions block in `lib/ai/prompts/serializers.ts`.

## Run it

From the repo root, on Node 24:

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/harness/first-visit-flow/harness.ts
```

It prints one `ok` or `FAIL` line per check and exits non-zero if any failed. The empty
environment is a habit, not a requirement here: nothing it calls reads a credential.

## What it can and cannot show

It drives the real `deriveOpenIntentions`, the real check-in rules and the real
`runtimeToProse` with constructed inputs. So it shows which intentions are open and what the
user prompt says on a given turn.

It does **not** show what the model then writes. Whether the reply actually compliments the
order, asks the required question, or varies its wording is not measured anywhere; the gate
for those is the device UAT.

It also does not exercise `build-runtime-context.ts` or `handle-inbound.ts`, which need a
database. So these are covered by reading, not by this harness:

- the `visit_checkins` writes (asked, answered, answered on the order turn);
- the two guards against asking twice in one visit (`promptedThisVisit`, and the filter that
  closes the intention once a check-in exists). The first check marked `EXPECTED` shows why
  they matter: the derivation alone re-arms on a second order event;
- "our last message asked something", which is computed from stored history.
- the timed check-back processor (`visit-checkin-timeout.ts`): its gate order, the claim,
  the release and the sent stamp. Its pure timing rules are covered here; the processor that
  strings them together against a database is not;
- the warm close standing down for a pending or unanswered check-back.

Two checks are marked `EXPECTED`. They record what the derivation does, not what anyone
ruled, so that a change to either is noticed.

## Checks confirmed to fail when their rule is removed

Each was mutated in the source, the harness run, and the source restored (2026-10-06):

| rule removed | check that failed |
| --- | --- |
| `requiredAlone` returns the whole open set | renders alone; a later visit asks again |
| the `venueHasAnsweredBefore` gate | three messages before any reply; the venue override |
| the delivered-reply half of `isQuietAfterWarmClose` | two messages in a burst |
| `bad` final in `nextCheckinAnswer` | bad is final |
| the already-asked guard in `resolveSameVisitOrderAt` | already asked on this visit |
| `checkinHold` in `renderableIntentions` | nothing else renders while waiting |
| the answering-our-question guard in `resolveSameVisitOrderAt` | names a menu item but is not answering |
| the category allow-list in `orderTurnVerdict` | a question that names a menu item; a recommendation ask |
| the claim in `owesCheckback` | not owed: already claimed; not once the timer has claimed it |
| the time bound in `resolveCheckbackDueAt` | not the next morning |
| the visit bound in `lastProactiveWasThisVisit` | a follow-up fifty minutes before the order |
| a required intention surviving the hold in `renderableIntentions` | the check-back itself survives the hold |

A check not in that table has not been shown able to fail.
