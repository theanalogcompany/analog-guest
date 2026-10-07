# Question pacing harness

Behavioural checks for **when** a getting-to-know-you question may be asked (ruled
2026-10-07): one open question at a time, only on a relaxed turn, at most two per
conversation and three for an engaged guest. The rules are in
`lib/agent/intentions/pacing.ts`.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`lib/agent/intentions/pacing.ts`, `lib/agent/intentions/derive.ts`, the `pacing` field in
`lib/agent/intentions/definitions.ts`, or `lib/ai/task-draft.ts`.

## Run it

From the repo root, on Node 24:

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/harness/question-pacing/harness.ts
```

It prints one `ok` or `FAIL` line per check and exits non-zero if any failed.

## What it can and cannot show

It drives the real `deriveOpenIntentions`, `renderableIntentions` and `isTaskDraft` with
constructed inputs, so it shows which questions a turn may render. The first block is the
2026-10-07 phone test, constructed: the real rows were deleted with the guest.

It does **not** show what the model writes, and it does not exercise these, which are
covered by reading and by the replay below:

- `build-runtime-context.ts` handing the guest's messages to the derivation;
- the drop itself inside `generateMessage` (the harness checks the predicate it calls and
  the flag that switches it on, not the call);
- a question the model invents in the reply with no intentions block rendered. No code
  stops that on a turn outside a first conversation.

`npm run measure-question-pacing` (`scripts/measurement/question-pacing-replay.ts`) is the
live half: the same phone-test thread through the real classifier and generation, in three
arms.

## Checks confirmed to fail when their rule is removed

Each was mutated in the source, the harness run, and the source restored (2026-10-07):

| rule removed | check that failed |
| --- | --- |
| the open-question hold in `derivePacing` | phone test, rule 1 alone (both); the answering turn; the ignored question inside the window; no stored answer; writes at length with the last unanswered |
| reading the answer from the fact on file (replaced with `true`) | the same six |
| the relaxed-category filter in `renderableIntentions` | phone test, rule 2 alone; answered but asking for something; a turn nobody classified |
| `reply` in the relaxed set | a relaxed turn later may ask the next one; the relaxed list |
| a null category failing closed | a turn nobody classified |
| the cap of two | not engaged: no third; the hold is the cap |
| the hard cap of three | three asked and answered, engaged: no fourth |
| the pessimistic skip | a pessimistic closure holds nothing |
| the conversation-window bound | an ignored question from an earlier conversation |
| one ask per sent message (keyed per intention instead) | one message that raised two questions counts once |
| engaged: asks us something | asks us something: a third may render; the reported verdict |
| engaged: writes at length | writes at length: a third may render |
| engaged: every question answered (replaced with `true`) | an earlier question never answered |
| the hold limited to paced intentions (made to hold everything) | the visit question still renders |
| the category filter limited to paced intentions (made to drop everything) | the visit question still renders |
| the link half of `isTaskDraft` | a draft carrying a link |
| the commitment half of `isTaskDraft` | a draft making a recommendation |
| the all-paced condition in `rendersOnlyConversationPaced` | not when a visit question is among them |

A check not in that table has not been shown able to fail.
