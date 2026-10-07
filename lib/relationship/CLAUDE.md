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

## The prompt: volatility tiers decide placement

Cache is prefix-based, so **anything that changes per turn sits after everything that does not**.
Never move a volatile section earlier: guest data in the system prompt would invalidate the cached conversation history every turn.

| tier | content | placement |
| --- | --- | --- |
| 0 | template frame, hard lines | system, cache breakpoint |
| 1 | venue profile, voice, knowledge | system, cache breakpoint |
| 2 | conversation history | real alternating chat turns, append-only |
| 3 | situation brief: state mission, guest profile, interaction memory, open moves | one injected context turn, second-to-last |

The guest's own messages are the final user turns, verbatim, never wrapped.
Sections are a registry (key, tier, source, pipeline, render, version); adding one is a registry entry, not template surgery.

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
| 5 | playground (`app/admin/(authed)/playground`): sandbox chat, production replay with v1 comparison, full trace inspector, edit-and-regenerate, inline judge, graph visual (nodes, requirement edges, per-guest frontier and move status) | **built** - standalone owner-facing graph viewer page still pending |
| 6 | production wiring through `runTurn` (persistence + dispatch + waitUntil), promote flow, per-venue flag flip, v1 deletion | not started |

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the cross-cutting decisions.
