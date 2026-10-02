# lib/agent - the per-request orchestration layer

Loads only when you work in this directory. Root `CLAUDE.md` has the project-wide rules.

This file states the **live contract**. For why a decision was made, read the module's own
header comment - most files here carry one, and it is the authority.

## Orchestrators

Four entry points, each owning one lifecycle. They share stages but not policy.

| file | trigger | sends? |
| --- | --- | --- |
| `handle-inbound.ts` | a guest message | yes, or queues a card |
| `handle-followup.ts` | cron engine or the Command Center button | yes, or queues |
| `handle-operator-decline.ts` | operator swipe-left on a heads-up card | **never** - persist only |
| `handle-holding-message.ts` | the knowledge-gap timer | yes, ungated |

`handleInbound` is a thin wrapper over `runInboundTurn`: the wrapper records the
`AgentResult` at one exit, which is what makes "no path's decision changed" a property of
the diff rather than a review claim. See `record-inbound-turn-outcome.ts`.

**`handle-operator-decline.ts` must never import `scheduleAndSend` or `sendMessage`.** An
import-set check in its test file enforces it. It also skips the approval gate entirely
(the operator's swipe IS the approval) and narrows `ctx.activeCommitments` to the declined
id **before** `generateStage` sees it.

## Stage pipeline

Inbound: `context_build` -> `classify` -> `retrieve` -> `retrieve_knowledge` ->
`generate` -> gate -> `send` -> post-generation checks (post-send, decision 0003).
Followups keep the checks between `generate` and the gate.

`retrieveKnowledgeStage(ctx, category, query)` takes its query **explicitly**. There is no
fallback and none may be added: a derived query is the defect that made every proactive
path retrieve four arbitrary chunks. `''` is the legitimate "do not retrieve" answer.

### Knowledge retrieval reads the conversation (TAC-547)

`retrieveKnowledgeWithContextStage` runs **two arms** under `Promise.allSettled` - the bare
message, and a contextual query from `buildContextQuery` - and merges them. Each arm goes
through the untouched `retrieveKnowledgeStage`, so each keeps its own tag-preference fallback
and graceful degrade, and arm B failing leaves arm A alone. **No prior turn runs one arm**, so
a first message behaves exactly as before.

`retrieval-context.ts` owns the pieces: `CONTEXT_TURNS` (2), `MAX_CONTEXT_BODY_CHARS` (200),
`reachedGuest`, `contextTurns`, `buildContextQuery`, `mergeKnowledgeMatches`, and
`KNOWLEDGE_MERGE_RULE`.

**The merge rule is INTERLEAVE BY RANK, and that is a fact about cosine rather than about
this corpus.** The two arms' scores are not on one scale - the contextual query is three
messages long and embeds systematically higher (top-1 median 0.7812 against 0.5001, ranges
barely overlapping). So "best score per entry" is really "keep the contextual arm": measured,
it displaced 83 of 120 control entries and cost 7 of 15 standalone targets. Interleaving by
rank is scale-free and guarantees the control arm's top two survive (A0, B0, A1, B1 at a limit
of 4). It still drops the control's ranks 2-3, so the measured zero regressions is that
guarantee plus where targets happened to sit, not a claim that nothing is displaced.

**Dedupe by the embedding chunk `id`, never `knowledgeCorpusId`** - the TAC-500 trap, since
one corpus entry split across chunks would collapse and lose a chunk's text. 1:1 on today's
data, so moot in practice and still required to be right.

**The context window** is the last `CONTEXT_TURNS` entries of `ctx.recentMessages` that
**reached the guest** (a held draft is text the guest never read, and the most likely to be
off-topic) and fall inside `ctx.conversationWindowMs` - hoisted onto `RuntimeContext` rather
than re-derived, because TAC-380 ruling 1 made that the one definition of "the same
conversation".

**Voice is a static per-venue pack, not a retrieval** (decision 0008).
`retrieveCorpusStage` loads the same pack for every message via `lib/rag/voice-pack.ts` -
no query, no embedding, no similarity. Fails CLOSED on inbound (empty pack or load
failure throws); followups proceed with whatever loaded.

`lib/voices/regenerate-with-critique.ts` now **calls this stage** rather than reimplementing
retrieval, which deletes a duplication that had already drifted once. Its contextual arm works
only because the window is measured from `ctx.currentMessage.receivedAt`: that path pins
history with `historyEndIso` while `buildRuntimeContext` stamps `computedAt = new Date()`, so
against wall-clock now every replay older than the window would have an empty context and the
arm would be silently dead. That is the re-dating trap reaching a second consumer.

**Recorded divergence:** `scripts/onboarding/run-test-scenarios.ts` and the
`scripts/measurement/*` harnesses still call the single-arm stage, so they no longer match
production. For the scenario harness that is equivalent only by coincidence - its synthetic
guests carry history 30+ days old, so `buildContextQuery` returns `''` anyway.

## Floors and constants

All in `stages.ts` unless noted. These are the live values; treat a number quoted anywhere
else as stale.

| constant | value | meaning |
| --- | --- | --- |
| `SEND_FIDELITY_FLOOR` | 0.4 | below this the draft is refused outright, red alert, nothing persisted |
| `AUTO_SEND_FIDELITY_FLOOR` | 0.6 | 0.4 to 0.6 queues for review |
| `KNOWLEDGE_RELEVANCE_FLOOR` | 0.3 | knowledge retrieval degrades **gracefully** |
| `KNOWLEDGE_RETRIEVE_LIMIT` | 4 | |
| `VOICE_PACK_MAX_ENTRIES` / `VOICE_PACK_CHAR_BUDGET` (`lib/rag/voice-pack.ts`) | 80 / 12,000 | growth ceilings; every live corpus fits whole today |
| `KNOWLEDGE_GAP_WINDOW_MS` | 5 min | the only clock any trigger arms |
| `COALESCE_SETTLE_MS` (`coalesce-turn.ts`) | 0 | settle before claiming; zero since the 2026-09 coalesce-window run, kept as the rollback lever |
| `CLAIM_LEASE_MS` / `MAX_TURN_EXTENSIONS` / `MAX_TURN_RETRIES` | 120 s / 2 / 1 | |
| `MAX_BUBBLES_PER_RESPONSE` / `INTER_BUBBLE_GAP_MS` (`split-message.ts`) | 3 / 1500 ms | |
| `SPLIT_PROBABILITY` (`sentence-split.ts`) | 0.5 | the one splitting knob |

The failure asymmetry is deliberate: voice failure (an unloadable or empty pack) breaks the
thing we sell, so it fails closed on inbound; knowledge failure just means a less specific
reply.

## Approval gates

`applyApprovalPolicyStage(ctx, generation, mechanicOffer?, prosePromise?, ...)`
returns `send`, `queue`, `drop`, or `silence`. **Twenty triggers compose; any one
queues.** The set is `APPROVAL_TRIGGERS`; check it against the constant, never against a
list in prose.

`primaryTrigger` is **not** `triggers[0]` - it is picked by `PRIMARY_TRIGGER_PRIORITY` and
lands on `messages.review_reason`, which is what the operator card shows first. Order,
most severe first:

```
commitment_type_gated > commitment_cancellation_gated > mechanic_offer_backstop >
prose_promise_backstop > prose_cancellation_backstop > unresolved_cancellation_id >
knowledge_gap > comp_regex_backstop > model_flagged >
closed_venue_arrival_emitted > closed_venue_arrival_backstop > unverified_url >
self_talk_detected > complaint_commitment_floor > previous_pending_held >
fidelity_below_auto_send_floor >
prose_promise_check_failed > prose_cancellation_check_failed >
category_requires_approval > hold_all_outbound
```

The shape of that order: a claim about **this draft** beats an **absence** of information
about it, which beats **venue-wide policy**.

**A priority test needs a co-firing trigger.** `pickPrimaryTrigger` falls through to
`triggers[0]`, so a single-trigger assertion passes against a ranking that does not exist.
Co-fire something the trigger under test must beat.

### Post-generation checks: post-send on inbound, fail CLOSED on the pre-send paths

`verify_mechanic_offer`, `verify_prose_promise`, `verify_cancellation_claim`,
`verify_closed_venue_arrival`. Decision 0003 (rewritten 2026-09-29) split the posture by
path:

- **Inbound**: the four run AFTER dispatch in `post-send-checks.ts` (waitUntil, never
  throws, `disposition: 'sent'` on every capture so Slack says the reply already went out).
  The gate receives the neutral values; only the deterministic triggers hold a draft. A
  queued/dropped/silenced turn runs no checks.
- **Followups and the holding message**: unchanged - pre-send, one immediate retry on a
  transient fault, then hold. Truncation is never retried; the fix is the cap.

**Treat a posture change to any one of them as a change to all four.** Both batches run
under `Promise.allSettled` so one fault cannot discard another's finding.

`checkDidNotComplete` (not `isGapTurn`) is what exempts an incomplete check from the
protected-card drop. The two are separate expressions and a new check must be added to
both, or a guest already holding a card gets silence. Both matter only where the checks
still run pre-send.

### Two pending slots per guest

Migration 041 plus 054. **Obligation slot**: pending rows whose `pending_commitment.type`
is comp, hold or discount. **Conversation slot**: everything else, keyed per inbound since
054, so a guest's second question gets its own card.

`pending-slots.ts` owns the whole rule. `decideSlotAction` is the one decision table,
shared by the gate, 23505 recovery, the crash card and the decline. Never read a pending
draft with a bare `.limit(1)` or `.maybeSingle()` - a source-level guard in
`pending-slots.test.ts` enforces it, because an unordered single-row read returns an
arbitrary one of the two slots.

The knowledge-gap clock is decided **per guest**, not per slot.

### An opt-out confirmation can never be held

`POLICY_EXEMPT_CATEGORIES` (`lib/schemas/approval-policy.ts`) holds `opt_out`, and it beats
everything: a stored per-category policy, a venue-wide default, the `hold_all_outbound`
blanket hold, and anything hand-written in Studio.

**TCPA and carrier compliance.** A guest who asks to stop must get the confirmation, so no
configuration may route it to a human who might not be looking.

Enforced in the **resolver**, not the UI. Hand-editing `venue_configs` is a normal workflow
here, so an exclusion guarded only by a rendering decision is not guarded. The admin surface
reads the same constant to omit the control, and the write route refuses it independently.

### Demo guest bypass

`guests.is_demo` - read as `ctx.guest.isDemo === true` - evaluates every trigger and then
sends anyway. The bypass is **total**, including the comp regex, so a demo guest's comp
auto-sends with no operator review. Only the literal `true` bypasses; `undefined`, `null` or
a missing column flow through the normal policy.

Acceptable only because demo guests are teammates' own phones. The visibility guarantee is
the `demo_bypassed_approval_gate` event, which relays to Slack only when
`comp_regex_backstop` is among the would-have-queued triggers - the irreversible case.

## Coalescing a burst into one turn

`coalesce-turn.ts`. Settle, then claim on `(venue_id, guest_id)` against
`inbound_turn_claims`, then re-check before dispatch and adopt anything newer.

- The claim INSERT has **no** `ON CONFLICT` - a race must surface as 23505 so exactly one
  run wins. An upsert would hand both runs a success.
- Everything fails **open**: an unreadable claim table proceeds unclaimed.
- `closeCoalescedTurn` releases and then hands off to a newer inbound, or retries once if
  the turn failed with nothing newer. That handoff is dead code on the happy path and is
  the only thing keeping the claim from being a robustness regression - do not delete it
  as unreachable.
- `findUncoveredInbound` is **three-state**. `unreadable` is not `none`: collapsing them
  silences a folded message permanently.

## Venue status

`isVenueProcessingHalted` from `lib/venues/status.ts` is the only behavioural reader of
`venues.status`. It is a **deny-list** (`paused`, `archived` halt; everything else,
`pending` included, processes) because production is inverted relative to any natural
reading - the live pilot venue is `pending`. An allow-list on `active` would switch it off.

`handleInbound` gates before `buildRuntimeContext`, which is before `openCoalescedTurn`,
so a halted venue never accumulates recognition state or takes a claim.

## Intentions

`intentions/`. Eight keys in `definitions.ts`, priority-ordered, arming on
`visit_confirmed` / `first_recorded_order` / `open_recommendation` / `recorded_order` /
`first_contact`.

`first_recorded_order` and `recorded_order` are one word apart and opposite:
`recorded_order` takes the NEWEST order and HOLDS it until the order has left the
conversation it happened in ("did you try it?" a minute later is absurd), while
`first_recorded_order` takes the EARLIEST and holds nothing, because the question it arms
(`are_they_new_here`) is about the guest rather than the order and the counter session is
the only moment it fits.

`are_they_new_here` and `understand_order` can never be open on one turn: the first arms
only once a transaction exists, and a transaction satisfies the second. That is why its
priority is 15 rather than 5 - a test asserting it wins that race could never fail.

Two predicates must move together: `shouldRenderOpenIntentions` (render side) and
`renderableIntentions` (record side). Suppressing on one only means the post-send
classifier is offered intentions the prompt never showed, which closes goals the guest
never saw. A cross-module test iterates every category for exactly this.

### A first conversation asks three things only (TAC-567)

On a guest's FIRST conversation only `understand_order`, `learn_name` and
`are_they_new_here` may be raised. The other five are suppressed. Ruled 2026-09-30 after a
fresh scan asked four questions across three messages.

`allowedOnFirstConversation` on the definition is the one declaration, so a new intention must
answer it or fail `tsc`; nothing in `derive.ts` branches on a key. "First conversation" is
TAC-560's `isFirstConversation` (`warm-close.ts`), resolved once in `build-runtime-context`
against the same `conversationWindowMs` the brake reads, anchored on
`first_contacted_at ?? created_at`, and carried on `RuntimeContext.firstConversation`.

**`deriveOpenIntentions` applies it TWICE and neither is redundant.** The arming loop skips a
suppressed intention, so no `eligible_at` row is written and its window does not start ticking
on a question nobody may ask. The open-set filter is the actual guarantee: first-contact
eligibility is STICKY, so a row already on file is never re-gated and only the filter can stop
it rendering. `derive.test.ts` kills each half with its own test.

The prompt half is a restraint paragraph the serializer renders into the intentions block when
`firstConversation` is true. It rides that block, so it does not render on a first-conversation
turn where nothing is open - stated at the constant, not discovered.

`understand_order` must not arm off `guests.last_visit_at` - every writer of that column
runs downstream of a transaction, and a transaction satisfies the intention. There is a
source-level guard matching both the snake_case column and the camelCase field.

### A raised question is always its own last message (TAC-554)

The model emits it in `intentionQuestion`, separately from the reply.
`composeReplyWithIntention` (`lib/ai/generate-message.ts`) then JOINS the two, so
`generation.body` is still the complete reply and every backstop that reads the body still
reads the question. The field rides along as the exact TAIL of the body - true by
construction, because we did the joining - and `resolveDispatchBubbles(body, rng, tail)`
peels it off as the final bubble.

`intentionTailFor(question, renderedCount)` is the ONE gate ON THE DISPATCH SIDE, called by
both dispatch arms. A question only bubbles when the intentions block actually rendered, which
is `renderableIntentions` above. Two copies of that decision is the drift this directory
already pays for.

**TAC-567 added a SECOND gate, upstream of it**: `composeReplyWithIntention` drops the
question when the reply already asks one, so no turn ever sends two questions. It normalizes
`intentionQuestion` to `''`, which is why `intentionTailFor` still needs no knowledge of it.
The veto writes nothing and closes nothing, so the intention comes back open next turn; its
firing rate rides on `intentionQuestionDroppedForBodyQuestion` because a guard nobody can
count is how `comp_regex_backstop` became an illusion. Detector is a bare `?` in the answer:
this reads our own outbound, where the copy always punctuates.

**`''` is byte-identical to the pre-TAC-554 path**, asserted as an equivalence rather than
by restating expected bubbles. The answer's own cap drops to `MAX_BUBBLES_PER_RESPONSE - 1`
so the total still honours the cap.

**`fitBubblesToInstagramCap` takes the tail too, and must.** Its repack throws the bubble
structure away and re-packs the whole reply greedily, which merges the question back into
the message in front of it - and only when a bubble is over 1000 bytes, so it is the kind of
conditional regression nothing notices.

Prompt wording cannot reach any of this: see `docs/decisions/0007-intention-question-is-its-own-bubble.md`.

## Proactive sends (TAC-386)

Three paths reach a guest with no inbound behind them: the scan greeting (TAC-536), the warm
close (TAC-560), the inquiry follow-up (TAC-386, `lib/followups/`). **No two within 60
minutes**, via `proactive-spacing.ts` and `guests.last_proactive_send_at`. A follow-up is NOT
a warm-close anchor, excluded inside `loadWarmCloseCandidates`. Reasons in those headers.

## Other rules that bite

- **A mock's recorded argument is a live reference.** These orchestrators mutate the `ctx`
  they pass on, so asserting on `mock.calls[0][0]` describes the end state, not what the
  stage saw. Snapshot inside the mock.
- `./stages` mocks here are explicit allow-lists. A helper added to `stages.ts` and not to
  the mock arrives `undefined` and throws the whole turn into `failed`, with the file still
  reporting green.
- A bare `vi.fn()` resolves `undefined`, which `Promise.allSettled` reports as fulfilled -
  so the orchestrator reads `undefined.status`. Default every check mock explicitly.
- `dispatch-reply.ts` is the one place a reply picks its transport. Nothing routes on a
  null channel.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
