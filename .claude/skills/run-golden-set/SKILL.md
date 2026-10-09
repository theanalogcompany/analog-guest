---
name: run-golden-set
description: Run the golden set - the 66 scenarios a guest actually sends - through the v1 and v2 agent engines side by side, and read the two answers next to each other at /admin/tests/golden. Use when someone asks "what does v2 say to these", wants a before/after on a prompt change, or wants the two engines compared on real guest messages.
---

# Run the golden set

Two commands and a URL:

```bash
npm run measure-golden-set          # a few minutes at the default concurrency
open https://admin.theanalog.company/admin/tests/golden
```

The page shows `question | v1 answer | v2 answer`, grouped by the commit the run was made at,
with an **Export CSV** button per run.

## Nothing is scored, and that is the design

There is no expected answer, no grader and no pass/fail (owner-ruled 2026-10-08). The output
exists to be **read**: you decide what passing means. A green number would be the worst thing
this surface could grow, because the question it answers - "does v2 sound right yet" - is not
a rate.

So: do not add a judge, do not add an `expected` field, and do not report "v2 won 40/58". If
you want a number, name the specific property you are counting and count it by hand off the
export.

## What you are allowed to conclude, and what you are not

| you can read | you cannot read |
| --- | --- |
| what each engine said, verbatim | which engine is better, as a score |
| v1's category and recognition state | whether v1 would have **sent** or queued |
| v2's state key and gate verdict | the same for v1 - it has no gate in this path |
| that a reply split into bubbles | that one engine uses **more** bubbles than the other |
| two runs taken in the same open/closed state | two runs taken either side of close |

Three of those are load-bearing enough to restate:

**Bubble counts are not comparable.** Both columns show real boundaries - a line break is a
real bubble - but the v1 test path pins the probabilistic sentence split off
(`TEST_RUN_SPLIT_RNG = 0.99` against `SPLIT_PROBABILITY = 0.5`), so a v1 reply splits only
where a tail earns one structurally: the further-help offer, the getting-to-know-you question.
v2 emits `messages[]` directly. Part of any gap you see is this harness.

**v1 has no route to report.** `draftInboundReply` stops before the 20 approval triggers and
the four post-generation checks, so a v1 answer on this page is a *draft*, not a prediction of
what a guest would have received. `v2_gate` is recorded for v2 alone and is never a comparison.

**An empty v1 column is not always silence.** `v1_substitute` carries the four cases where v1
would have sent something other than a generation - `crisis_safety`, `media_only_card`,
`opt_out_confirmation`, and `no_reply_needed` (a bare "ok"/"thanks" at a venue whose own team
mostly left those alone gets no reply at all, by design). The page labels each. `v1_error` is
the different thing: the arm broke. Check which one you are looking at before reporting a gap.

## Run it during the venue's open hours

The prompt carries an open/closed line, so a run after close hedges through every scenario and
is **not comparable** with one taken mid-morning. The harness warns and keeps going; the state
is stamped on the run row and shown on the page, so a mismatched pair is detectable after the
fact - but you have still spent the run.

It also **writes to production `messages`**: the v1 arm materializes each scenario's history
and inbound against a per-venue, per-slot `is_test_synthetic` guest and deletes them on the
next call. A full run churns a couple of hundred rows across up to 10 synthetic guests.

## Flags

```bash
npm run measure-golden-set -- --questions=hours,oat-milk   # iterate cheap; stored as partial
npm run measure-golden-set -- --concurrency=4              # default 8, capped at SANDBOX_SLOTS=10
```

Concurrency is capped by sandbox slots, not by rate limits: each in-flight v1 arm needs its own
synthetic guest, and a worker holds its slot for the whole run so two scenarios can never write
to the same one.

A filtered run is stored with `full_run = false` and the page says so. Do not compare a
filtered run against a full one as if the missing scenarios had passed.

## 58 of 66 run, deliberately

Eight scenarios have a `driver` other than `inbound`: four proactive follow-ups, two sticker
taps, a media-only turn, a held-draft expiry. Each is a real production path whose **only entry
point sends**, so there is no reply to read without new test-mode plumbing in `lib/agent/` -
runtime work, not a harness change. Only `runInboundTurn` has a test sink.

They stay in the set, and both the harness and the page name them. A run that quietly covered
58 and said "58 scenarios" would read as complete coverage to anyone who did not go counting.

## Reading the output

Three places, in order of how much you will use them:

1. **`/admin/tests/golden`** - the surface. Commit-grouped, linked to the sha, Export CSV per
   run. This is what you send a colleague.
2. **The CSV** - 17 columns, Excel-safe UTF-8 (the BOM is why a curly apostrophe does not come
   out as mojibake). Good for sorting by group or diffing two runs in a spreadsheet. `history`
   and `inbound` sit left of the two replies, because that is what the engines were given.
3. **The JSONL run log** - the actual record, path printed at the start of the run. If the DB
   write fails, this still has everything; the harness says so rather than losing the run.

A run is stamped with both prompt versions, the git sha and subject, whether the tree was
dirty, and the open state. **A dirty-tree run is flagged on the page** - it is not reproducible
from the sha, so treat it as a sighting rather than a baseline.

## Adding or rewording a scenario

Edit `GOLDEN_QUESTIONS` in `lib/eval/golden-set.ts`. **No SQL, no apply** - the code array is
the set, so a scenario added in code cannot be silently inert (the direction decision 0011
established for regression scenarios). Fields:

```ts
{
  key: 'kebab-case-unique',
  group: 'logistics',              // display only, nothing branches on it
  question: 'What are your hours?',
  messages: ['two', 'in a row'],   // optional: a burst. replaces `question` as the turn
  history: [                       // optional: omit for a cold open
    { role: 'user', text: 'just got the pink panther on your rec' },
    { role: 'assistant', text: 'that one surprises people' },
  ],
}
```

**History is authored, never seeded.** A scenario that needs a past order carries it as
something the guest actually *said*, so both arms read the same facts off the same transcript.
No visit count, profile or memory is declared to either arm - declaring visits to v2 while v1
reads an empty `transactions` would have the two engines answering about different guests, and
the asymmetry would flatter whichever arm was told more.

Two authoring rules the validator enforces, both of which have already caught real mistakes:

- **History must end on an `assistant` turn.** A trailing user turn merges into the test
  message and you are no longer testing what you wrote.
- **Roles must alternate.** Two user turns in a row is a burst, which is `messages`, not
  `history`.

Keep the wording to what a guest would really type - lowercase, unpunctuated, mid-thought. A
tidied-up transcript is a different input than the one production sees.

`npm run measure-golden-set` validates the whole array **before any model call** and exits 1
with the list of problems. That boundary fails closed on purpose: an hour of model calls lost
to a typo in the array is the failure being prevented.

## Before you report anything

- Was the venue **open**? If not, say so in the same sentence as the finding.
- Was the tree **dirty**? Then the sha does not reproduce it.
- Was it a **partial** run? Then say which scenarios ran.
- Did any arm **error**? A failed arm is not a result (`scripts/CLAUDE.md`, rule 5). Count it
  as a failure, never as a short answer.
- Are you comparing bubble counts, or route? Neither is comparable. Go back and read the table
  above.
