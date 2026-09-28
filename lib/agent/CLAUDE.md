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

`context_build` -> `classify` -> `retrieve` -> `retrieve_knowledge` -> `generate` ->
post-generation checks -> `send`.

`retrieveKnowledgeStage(ctx, category, query)` takes its query **explicitly**. There is no
fallback and none may be added: a derived query is the defect that made every proactive
path retrieve four arbitrary chunks. `''` is the legitimate "do not retrieve" answer.

## Floors and constants

All in `stages.ts` unless noted. These are the live values; treat a number quoted anywhere
else as stale.

| constant | value | meaning |
| --- | --- | --- |
| `SEND_FIDELITY_FLOOR` | 0.4 | below this the draft is refused outright, red alert, nothing persisted |
| `AUTO_SEND_FIDELITY_FLOOR` | 0.6 | 0.4 to 0.6 queues for review |
| `STRONG_MATCH_SIMILARITY` / `MIN_STRONG_MATCHES` | 0.3 / 1 | voice retrieval fails **closed** on inbound |
| `KNOWLEDGE_RELEVANCE_FLOOR` | 0.3 | knowledge retrieval degrades **gracefully** |
| `CORPUS_RETRIEVE_LIMIT` / `KNOWLEDGE_RETRIEVE_LIMIT` | 8 / 4 | |
| `KNOWLEDGE_GAP_WINDOW_MS` | 5 min | the only clock any trigger arms |
| `COALESCE_SETTLE_MS` (`coalesce-turn.ts`) | 3 s | burst settle before claiming |
| `CLAIM_LEASE_MS` / `MAX_TURN_EXTENSIONS` / `MAX_TURN_RETRIES` | 120 s / 2 / 1 | |
| `MAX_BUBBLES_PER_RESPONSE` / `INTER_BUBBLE_GAP_MS` (`split-message.ts`) | 3 / 1500 ms | |
| `SPLIT_PROBABILITY` (`sentence-split.ts`) | 0.5 | the one splitting knob |

The failure asymmetry is deliberate: voice failure breaks the thing we sell, so it fails
closed; knowledge failure just means a less specific reply.

## Approval gates

`applyApprovalPolicyStage(ctx, generation, grounding?, mechanicOffer?, prosePromise?, ...)`
returns `send`, `queue`, `drop`, or `silence`. **Twenty-three triggers compose; any one
queues.** The set is `APPROVAL_TRIGGERS`; check it against the constant, never against a
list in prose.

`primaryTrigger` is **not** `triggers[0]` - it is picked by `PRIMARY_TRIGGER_PRIORITY` and
lands on `messages.review_reason`, which is what the operator card shows first. Order,
most severe first:

```
commitment_type_gated > commitment_cancellation_gated > mechanic_offer_backstop >
prose_promise_backstop > prose_cancellation_backstop > unresolved_cancellation_id >
knowledge_gap_backstop > knowledge_gap > comp_regex_backstop > model_flagged >
closed_venue_arrival_emitted > closed_venue_arrival_backstop > unverified_url >
self_talk_detected > complaint_commitment_floor > previous_pending_held >
fidelity_below_auto_send_floor > grounding_check_failed > grounding_check_degraded >
prose_promise_check_failed > prose_cancellation_check_failed >
category_requires_approval > hold_all_outbound
```

The shape of that order: a claim about **this draft** beats an **absence** of information
about it, which beats **venue-wide policy**.

**A priority test needs a co-firing trigger.** `pickPrimaryTrigger` falls through to
`triggers[0]`, so a single-trigger assertion passes against a ranking that does not exist.
Co-fire something the trigger under test must beat.

### Post-generation checks all fail CLOSED

`verify_grounding`, `verify_mechanic_offer`, `verify_prose_promise`,
`verify_cancellation_claim`, `verify_closed_venue_arrival`: one immediate retry on a
transient fault, then hold. Truncation is never retried - the fix is the cap.
**Treat a proposal to loosen any one of them as a change to all five.** They run under
`Promise.allSettled` so one fault cannot discard another's finding.

`checkDidNotComplete` (not `isGapTurn`) is what exempts an incomplete check from the
protected-card drop. The two are separate expressions and a new check must be added to
both, or a guest already holding a card gets silence.

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

`intentions/`. Seven keys in `definitions.ts`, priority-ordered, arming on
`visit_confirmed` / `open_recommendation` / `recorded_order` / `first_contact`.

Two predicates must move together: `shouldRenderOpenIntentions` (render side) and
`renderableIntentions` (record side). Suppressing on one only means the post-send
classifier is offered intentions the prompt never showed, which closes goals the guest
never saw. A cross-module test iterates every category for exactly this.

`understand_order` must not arm off `guests.last_visit_at` - every writer of that column
runs downstream of a transaction, and a transaction satisfies the intention. There is a
source-level guard matching both the snake_case column and the camelCase field.

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
