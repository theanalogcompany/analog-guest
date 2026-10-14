# lib/relationship - the v2 relationship engine

Loads only when you work in this directory.
Root `CLAUDE.md` has the project-wide rules; `docs/decisions/0009-relationship-engine-v2.md` is the short record of why v2 exists.
Ruled 2026-10-03, full redesign conversation with the owner; nothing here ships to a venue until the per-venue flag flips (phase 6).

## The one-paragraph version

The agent's behaviour is defined by **three versioned data artifacts**, not code: the **relationship graph** (states a guest moves through, each with a prompt-facing mission, plus moves - parallel active aims, open from their home state onward until a profile field closes them), the **prompt template** (the maitre d' frame), and the **judge rubric** (seven axes every response is scored on).
Code shrinks to: assemble facts, render the prompt, generate, run the policy gate, dispatch, then assess and judge post-turn.
Etiquette is the model's job, informed by facts; quality is measured by the judge; only compliance is enforced in code.

## What v2 replaces, and with what

| v1 (retiring) | v2 replacement |
| --- | --- |
| `lib/recognition/` state bands + `state_thresholds` | graph states with `requires` predicates; strength signals become predicate inputs |
| `lib/agent/intentions/` (definitions, derive, gates, windows, brake, prompted-once, re-arm) | state-scoped moves + **interaction memory** rendered as facts; the model judges when to ask; the judge catches nagging |
| R1-R39 universal rules + category prompt files | the three-section template (identity, knowledge, hard lines) + persona; style is judged, not legislated |
| four LLM verifiers + 19 hardcoded approval triggers | structural actions lane + one Jev request (per-policy Nouls) + policy registry rows |
| crisis/category classifier selecting prompt content | slim Jev nouls on the inbound for routing only (opt-out, complaint); crisis flags ride the post-turn assessor |
| code-side sentence splitting, emoji coin, question-tail dispatch | the model emits `messages: string[]` directly; bubble quality is judged per-response |

**Kept, untouched** (the test is "outside a single model call's reach"): coalescing, proactive spacing, the opt-out TCPA rail, the operator approval queue, Langfuse.

**Bubble CADENCE is code, even though bubble CONTENT is the model's.**
Every message in `messages: string[]` is ready at the same instant, so with no pacing a three-bubble reply arrives as one block.
`bubble-pacing.ts` is the one rule: the delay before each bubble after the first is its own character count times `MS_PER_CHAR`, floored and capped.
It is pure and import-free so the playground's `'use client'` bubbles can read it and phase 6's dispatch can read the same copy - two copies of a cadence rule is the drift `lib/agent/CLAUDE.md` pays for on the intention-question gate.
`MS_PER_CHAR` is calibrated so that at 43 characters, a typical bubble, it reproduces v1's flat `INTER_BUBBLE_GAP_MS`; the floor and the cap are choices and say so at the constant.
The playground reveal is **presentation only** - `replyBubblesOf` stays the one definition of a turn's reply, and nothing paced reaches the transcript, a save, or the inspector.

## The prompt: volatility ascending, one cache breakpoint

The cache is prefix-keyed, so **one volatile section poisons everything in front of it**.

| block | content | volatility | cached |
| --- | --- | --- | --- |
| system 1 ROLE | who you are, how you answer, texting style, intention, rules | static | no, see below |
| system 2 THE HOUSE | the venue's knowledge; plus the voice pack **only for a venue with no brief** | per venue | **yes, breakpoint** |
| system 3 HOUSE NOTES | the venue's clock, state mission, guest profile, interaction memory, open moves | per turn | no |
| turns | the transcript, then the guest's message(s), verbatim, never wrapped | per turn | no |

**The transcript is not cached, and that is the price of block 3's position** (owner-ruled
2026-10-09). System blocks always precede messages, so a volatile system block sits in front
of the transcript and no breakpoint after it can hit. For part of 2026-10-09 HOUSE NOTES was
a user turn behind the transcript, which did cache - measured reading 6,016 on turn 3. Worth
p50 241 tokens, max 555, at Le Mil's. Moving HOUSE NOTES back behind the transcript is what
reopens it, and `V2_GUEST_STATE`'s header carries the behavioural side of the same trade.

**v2 does not retrieve** (v2.18.0, owner-ruled 2026-10-12).
`# What you know` is one authored artifact per venue, `venue_configs.knowledge_brief`
(migration 082), and it **replaces `renderVenueProfile` outright** for a venue that has one -
the two are never concatenated, which they were for one afternoon, rendering the whole menu
twice in two voices that disagreed about which items are vegan.
So the brief owes everything that renderer supplied, hours and the dated `currentContext`
notes included, and `renderRightNow`'s clock filtering is the one thing it cannot reproduce -
a date in the brief outlives itself until someone edits it.
A venue whose brief is NULL renders `V2_HOUSE_SECTIONS` byte-identically to before, which is
what makes the bump a no-op everywhere else.
v1 still retrieves through `lib/agent/stages.ts`; the table, the rows and the `/admin` corpus
editor are untouched.

**Nothing per-turn may move into system blocks 1 or 2.** `# What you know` sat at the end of
block 2 until 2026-10-08, where ~150 volatile tokens invalidated ~6,100 static ones every
turn while `generate.ts` asserted "both system blocks are stable per venue". Measured cold on
Le Mil's, two turns of one conversation: write 6,326 then write 6,267, reuse **0**. After the
split: write 6,133 then reuse **6,133**. The split is byte-identical to the model, so it
carries no `V2_PROMPT_VERSION` bump.

**Block 1 carries no breakpoint**, and **not for the reason this file gave until v2.20.0**.
At ~590 tokens the block was under Anthropic's 1024-token minimum cacheable prefix, so the
breakpoint it used to carry could never have produced an entry.
The owner's hand-written frame is 4,677 chars and at or past that floor, so that argument is
gone.
What holds instead: the breakpoint after block 2 already makes blocks 1 and 2 a single cached
prefix, and a second breakpoint between them would only pay off if block 2 changed often,
which it cannot.
`lib/ai/v2/compose.ts`'s header is the long version.

**Retrieval sits after the venue sections**, where proximity ranks it above them - the
v2.12.0 off-channel-redirect failure mode, which `off-channel-redirect` in the regression
harness is the tell for. It leads block 3 so it is at least the furthest thing in that block
from the guest's message.

**A briefed venue no longer sees its voice pack** (v2.20.0, owner-ruled 2026-10-13).
`V2_HOUSE_SECTIONS_BRIEFED` is `# What you know` and nothing else, so `# How you sound` and
its 65 approved `voice_corpus` rows reach only a venue whose brief is NULL.
That settles the contradiction every emoji and dash entry in the template changelog flags -
the pack sat later in the prompt than the frame and out-ranked it - and it costs the one
measured account of how the venue's own team writes, leaving `{length_clause}` as the only
measured input in a briefed prompt.
`ComposeInput.voicePack` is still loaded and still rendered on the unbriefed path; it is not
dead, do not tidy it away.

**The venue's clock is in HOUSE NOTES, and that is the only block it may reach** (v2.20.0).
`{now_line}` is `venueNowLine` over `venues.timezone` (`lib/ai/v2/now-line.ts`), because the
frame tells the model to use the time when it matters and until v2.20.0 no v2 prompt carried
one.
It fails to `''`, which renders an explicit "unavailable" line rather than server time or a
guess.

**`renderVenueProfile` takes `now`, and that is safe for block 2**: the only reader is
`renderRightNow`, which filters dated `currentContext` notes. No live open/closed line, so
the block changes when a note's window opens or closes and not otherwise. Adding any
clock-derived line to the venue profile would silently break the cache.

`composePrompt` returns the rendered brief as `guestState`. **Never recover it by indexing
`turns`** - `turns[history.length]` was how two callers found it, and that expression
silently returns the guest's own message the moment the layout moves.

## The guest's media (v2.19.0)

`turn-media.ts`. A guest's photo, video, GIF, voice note, story reply or share reaches the
prompt as **one bracketed line per attachment**, and the reply is **held for an operator**.

**None of the wording or the rules are v2's.** Every sentence comes from
`lib/ai/prompts/attachment-lines.ts` (owner-approved verbatim, TAC-582 and TAC-584) and every
decision from v1's own pure modules: `turnMediaPromptLines` for which lines a turn produces,
`mediaAlongsideText` / `mediaMessageIdsForTurn` / `repliesToStory` for which messages a turn is
answering, `decideMediaContextHold` for the hold, `loadTurnMediaHistory` for the window,
`nameableItems` / `usableDescription` for what a reply may name.
If a rule reads wrong here it reads wrong in v1 too, which is the point.
Do not write a v2 phrasing of "a photo arrived and you cannot see it" - v1 paid for that
sentence twice.

| | |
| --- | --- |
| the line's position | its **own user turn**, after the guest's words. The composer never wraps the guest's message, and the rules for replying to a picture belong last (later beats earlier) |
| the hold | `guest_media_requires_approval` in `lib/policy/default-policies.ts`, scoped on the `guest_media` situation - v1's `media_context` trigger in policy-row form |
| `guest_media` | **not** a `SITUATION_KEYS` member. Jev is never asked about it; the gate takes `situations: string[]`, which is what lets a code-set fact scope a row like a detected one |
| a described photo | still held. Both owner rulings say so (2026-10-11) |
| an opt-out turn | never carries the situation, because `POLICY_EXEMPT_SITUATIONS` only stops a row *matching* on opt-out and TCPA says that confirmation goes out |
| the describe step | **not called from here.** It makes a vision call and writes rows; v2 reads what it recorded. Running it on the live path is phase 6, where v1 has it |

**A media-only turn is where the engines genuinely differ.** v1 writes an operator card and
never builds an ordinary prompt; v2 has no card path, so it drafts and the gate holds it.
`inbound: []` is therefore legal, the media lines stand for the guest's message, and a turn
with neither fails as a value rather than generating against nothing.

**A replay must be bounded at the message it answers**, and three reads take that bound
(`asOfIso`, `untilIso`, `historyEndIso`). Unbounded, a replay hands the model the venue's own
answer to the turn it is being asked to write, the four-minute companion window cannot see the
turn's own attachments, and the hold rule walks a thread that now ends in that answer - all
three measured on Le Mil's, 2026-10-13. **Carry `created_at` as the string**: Postgres keeps
microseconds, `Date` keeps milliseconds, and a bound round-tripped through one excludes the row
it came from.

## State derivation

Hard predicates (`lib/relationship/schema.ts`, closed vocabulary) bound the **frontier**; the post-turn assessor chooses within it, with hysteresis, and can never promote past a failed hard predicate.
Transitions persist in `guest_relationship_states` with `decided_by` and `evidence` - a state row without evidence is a bug.
States are not monotonic: regression (lapsed guests) is a graph-data concern, not a code special case.

## The post-turn assessor and the judge

Both run post-send, async, never in the guest's latency path, never blocking a send.

- **Assessor**: one call reading the full exchange; returns state transition judgment, guest profile updates, interaction memory updates, and routing flags (crisis among them).
  Generation's output schema stays `{ messages, actions? }` - no bookkeeping fields in the latency path.
- **Judge**: scores every response (production, playground, harness) on six axes - Recognition, Reading the guest, Economy, Quiet authority, Working the room, Host ownership - each with explanation, evidence quotes, and a required `tested` flag (an axis the turn never exercised reports n/a, never a filler 3), into `eval_judgments` keyed by graph/prompt/judge versions.
  Working the room prices BOTH question-timing failures in one axis - the missed opening and the nag. It began as two opposing axes (tact + initiative); they contradicted each other's facts on a single reply and drew 4/3/2 on one greeting shape, so v1.2.0 merged them. `scripts/measurement/judge-variance.ts` is the variance gate for any judge prompt change.
  The judge is calibrated against a frozen human-scored set before it is trusted, and the calibration set contains the v1 failure transcripts (the interview, the re-ask, "nice" to a regular) so the lessons survive as tests.

## The policy gate (pre-send, blocking)

1. **Structural lane**: `actions?` on the generation output is the only way a commitment exists (comp, hold, discount, cancellation).
   Free, deterministic, and what the ledger executes.
2. **Semantic lane**: one Jev `systemOne` request, one Noul per policy row, probabilities thresholded per-policy (thresholds are registry data, venue-tunable).
   Questions evaluate in parallel, so latency is flat in policy count.
   Evidence extraction for the operator card runs only on flagged drafts (they are already queued; latency there is free).
3. Policies may condition on `{action, state, situation, amount, channel}` - graph-scoped approval rules render on the graph viewer.
   Output-level policies always run; an edge can tighten the gate, nothing can slip past it by not being on an edge.

Jev stays behind `lib/policy/semantic-check.ts` (swappable-provider rule).
Failure direction: a Jev outage with declared actions or tripwire text (digits, currency, URLs) fails CLOSED to queue; a clean no-action draft fails OPEN and fires the degrade event.

## Where things live

| artifact | storage | code |
| --- | --- | --- |
| graph | `relationship_graphs` (one active per venue) | `schema.ts`, seed in `default-graph.ts` |
| prompt template | `prompt_templates` (venue NULL = global default) | phase 2 |
| guest profile + memory | `guest_profiles` (one row per guest per venue) | assessor, phase 3 |
| state history | `guest_relationship_states` (one open row) | `state.ts`, phase 2 |
| judgments | `eval_judgments` | `lib/eval`, phase 4 |

Mission and move text is **prompt-facing copy**: wording changes go through the plan gate verbatim.
`requires` thresholds in the seed are placeholders, labelled as such.

## Phase status

| phase | what | status |
| --- | --- | --- |
| 1 | schemas, migration 067, seed graph, this doc | **built** |
| 2 | state derivation (`state.ts`), policy registry + Jev check + gate (`lib/policy/`), v2 template + tiered composer (`lib/ai/v2/`) | **built** - template copy is draft pending approval |
| 3 | turn runner (`run-turn.ts`, dry-run: writes nothing), v2 generate call, assessor (`assessor.ts`), profile/memory (`profile.ts`) | **built** - hysteresis and situation scoping land with phase 6 (single validated pick adopted today; gate sees no situations anywhere) |
| 4 | judge (`lib/eval/judge.ts`) | **built** - calibration set + harness pending |
| media | the guest's attachments through `turn-media.ts` + the policy row (v2.19.0) | **built** - the lane and the hold; the playground has no surface for it (its replay runs `guestId: null` on purpose, so it loads no rows) |
| 5 | playground (`app/admin/(authed)/playground`): sandbox chat, production replay with v1 comparison, full trace inspector, edit-and-regenerate, inline judge, graph visual (nodes, requirement edges, per-guest frontier and move status) | **built** - standalone owner-facing graph viewer page still pending |
| 6 | production wiring through `runTurn` (persistence + dispatch + waitUntil), promote flow, per-venue flag flip, v1 deletion | not started |

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the cross-cutting decisions.
