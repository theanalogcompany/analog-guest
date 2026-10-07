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

**`handle-operator-decline.ts` must never import `scheduleAndSend` or `sendMessage`.** It also skips the approval gate entirely
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
prose_promise_check_failed > prose_cancellation_check_failed >
review_ask > category_requires_approval > hold_all_outbound
```

The shape of that order: a claim about **this draft** beats an **absence** of information
about it, which beats **venue-wide policy**.

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
draft with a bare `.limit(1)` or `.maybeSingle()` - an unordered single-row read returns an
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

### Photos, GIFs and other attachments (TAC-574)

A turn with text is answered normally and told `[guest also sent a photo]`; a turn with no
text at all becomes a blank operator card (`media_only_inbound`), with no classifier call.
The rule, its window and its limits are in `inbound-media.ts`'s header.

## Venue status

`isVenueProcessingHalted` from `lib/venues/status.ts` is the only behavioural reader of
`venues.status`. It is a **deny-list** (`paused`, `archived` halt; everything else,
`pending` included, processes) because production is inverted relative to any natural
reading - the live pilot venue is `pending`. An allow-list on `active` would switch it off.

`handleInbound` gates before `buildRuntimeContext`, which is before `openCoalescedTurn`,
so a halted venue never accumulates recognition state or takes a claim.

## Intentions

`intentions/`. Ten keys in `definitions.ts`, priority-ordered, arming on
`visit_confirmed` / `same_visit_order` / `checkback_due` / `first_recorded_order` /
`open_recommendation` / `recorded_order` / `first_contact`.

### Two intentions are required, and a required one renders alone (TAC-575)

`raise: 'always'` on a definition removes the model's licence to skip it. `hows_it_so_far`
and `check_back_on_order` (below) carry it. For the first: "how is it so far?" comes right after a guest names their order
(ruled 2026-10-06), and the check-back, the sign-off and the complaint follow-up all hang off
the answer, so a one-in-three raise rate would make them a matter of luck.

- It arms on `same_visit_order`: the guest is ANSWERING A QUESTION OF OURS, a counter visit
  is live, and the message names a menu item (`resolveSameVisitOrderAt`, `visit-checkin.ts`).
  The menu-name prefilter, not a transaction - the order extractor runs after the reply is
  sent. The prefilter over-matches by design, so once the turn is classified
  `orderTurnVerdict` decides again: only `casual_chatter` / `acknowledgment` ask; a complaint
  or a message that already praises the item is recorded as the answer with no question; a
  question that merely names a menu item arms nothing and leaves no row.
- While it is open it is the ONLY open intention (`requiredAlone` in `derive.ts`), and the
  serializer swaps the "not a checklist" paragraph for `MUST_ASK_PARAGRAPH`.
- It still goes out through `intentionQuestion` and closes through the post-send classifier.
  A reply that already asks something still drops it in code, and it comes back next turn
  until its two hours run out.

**The answer lives on `visit_checkins` (migration 073), not on the intention.** A row is
written when the question REACHES the guest (auto-send only; from the sent field or from the
post-send classifier, whichever sees it), one per guest per venue-local day.

**"We asked this visit" has two records and both are read**: that row, and the intention's
prompted row. Either can be the only one written (a classifier miss, a failed insert, an
operator-approved send), so arming reads both and a check-in closes the intention outright
(`promptedThisVisit` and the filter after it in `build-runtime-context.ts`). The guest's next replies are read as good / bad / not yet from the classifier's existing
`comp_complaint` category and `praisedExperience` flag (`classifyCheckinAnswer`); "not yet" is
the default, not a detection. Bad is final, good is not.

**Until they say it is good, no OPTIONAL question is asked, for at most two hours from the
question**; a required one still renders, which is how the check-back gets through
(`ctx.visitCheckinHold`, set by `handleInbound` after classification and read by
`renderableIntentions`; `CHECKIN_ANSWER_WINDOW_MS` bounds it, and a `bad` answer holds for the
whole of it). **Interim until TAC-575's PR 4:** praise inside a check-in still raises the
review ask on that turn, as any praise does; the ruled behaviour (saved for the sign-off)
lands with the sign-off, as one condition at the marked line in `deriveReviewAsk`. It is decided
post-classification on purpose: the message saying "it's great" has to lift the hold on the
turn it arrives.

### The check-back: once per visit, by a timer or by a reply (TAC-575)

A visit is owed ONE check-back while the guest has not said good or bad and nobody has claimed
it (`owesCheckback`). Two paths can spend it, and `visit_checkins.checkback_claimed_at` is the
compare-and-set that makes it exactly one:

| the guest | path | when |
| --- | --- | --- |
| went quiet | `visit-checkin-timeout.ts`, every-minute cron at `/api/cron/visit-checkbacks` | 10 to 30 min after the ORDER, and our last message has sat 2 min |
| is still chatting | the `check_back_on_order` intention on a later turn | from 5 min after the order, or after their "not yet" if that is later |

The timer needs OUR message to be the newest in the thread, so the two cannot both fire. It
claims BEFORE sending and releases if nothing reached the guest (`RELEASES_CLAIM`, shared with
the warm close); the reply claims AFTER sending, because by then the question has gone.

- **Never on the turn that answers the question, and never on a goodbye.** "Haven't tried it
  yet" must not get "and how is it?" in the same breath; `handleInbound` drops the intention
  on the turn the row first gets an answer and on a sign-off turn, post-classification.
- **No check-back where staff replied by hand or the visit holds a complaint**
  (`loadWarmCloseBlocker`, the warm close's own check, applied here by the same reasoning
  and not yet ruled for this message specifically).
- **An operator-approved reply that carried the check-back does not claim the row**, so the
  timer also reads the intention's prompt (`wasCheckbackAskedInConversation`) and settles it.
- **Its approval does not follow its category.** It is stored as `follow_up`, and reads
  `approval_policy.visitCheckback` instead (default HOLD; a venue opts in with `"auto_send"`).
- **The one-hour spacing rule does not apply against this visit's own greeting**
  (`lastProactiveWasThisVisit`); it does against everything else.
- **The warm close waits for it and yields to it**, on both its paths: `checkback_pending`
  while one is owed, `checkback_unanswered` once it went out and got no reply ("send nothing
  more"). Unanswered is read from the GUEST's side, nothing of theirs since it went out; a
  comparison between two of our own timestamps was the first version and could never be true.
- Instagram only. 10 and 5 minutes are ruled; the 2-minute quiet floor and the 30-minute
  bound are choices, stated at the constants.

`resolveSameVisitOrderAt` is handed `alreadyAskedThisVisit: true` when the check-in could not
be read. The intention re-arms on a newer event, so reading a failure as "not asked" is how
one visit gets the question twice.

`first_recorded_order` and `recorded_order` are one word apart and opposite:
`recorded_order` takes the NEWEST order and HOLDS it until the order has left the
conversation it happened in ("did you try it?" a minute later is absurd), while
`first_recorded_order` takes the EARLIEST and holds nothing, because the question it arms
(`are_they_new_here`) is about the guest rather than the order and the counter session is
the only moment it fits.

`are_they_new_here` and `understand_order` can never be open on one turn: the first arms
only once a transaction exists, and a transaction satisfies the second, so the two never
compete for a turn. Its priority (45) orders it against `learn_name` (40), not against that.

Two predicates must move together: `shouldRenderOpenIntentions` (render side) and
`renderableIntentions` (record side). Suppressing on one only means the post-send
classifier is offered intentions the prompt never showed, which closes goals the guest
never saw.

### A first conversation gets to know the guest in a fixed order (TAC-575)

Ruled 2026-10-06, replacing TAC-567/568's "two questions, then the close". On a guest's
FIRST conversation eight of the ten may be raised, in `priority` order: `understand_order`,
`hows_it_so_far`, `check_back_on_order`, `learn_name`, `are_they_new_here`, then `are_they_local`, `their_rhythm`, `why_theyre_here`.
The two about a PAST order or suggestion stay suppressed.

**No getting-to-know-you question rides on a guest's first reply** (the two order questions,
`understand_order` and `hows_it_so_far`, are the exceptions: neither has a gate). A `replies_only` gate is shut until
`venueHasAnsweredBefore`, read from OUR side of the thread (`hasAnsweredGuestBefore`,
`retrieval-context.ts`) because an inbound count cannot say "first reply": three quick
messages reach a count of three with nothing yet said back. A venue's
`intention_rules.min_replies` tunes the count and cannot open that reply. What keeps six from
reading as an interview is the reply counts (3, 3, 5, 8, 11), one question per turn, and the
brake - not this policy.

**A turn with no intentions block still tells the model to ask nothing** on a first
conversation and inside the post-close quiet (`NO_QUESTION_RESTRAINT`, `serializers.ts`), and
a question the model emits with no block rendered is dropped in `generate-message.ts`. The
restraint reaches `body`; the drop reaches the field. Neither alone covers both.

`onFirstConversation` on the definition is the one declaration - `'allowed' | 'suppressed'` -
so a new intention must answer it or fail `tsc`; nothing in `derive.ts` branches on a key, and
its `switch` is over the closed union. "First conversation" is TAC-560's `isFirstConversation`
(`warm-close.ts`), resolved once in `build-runtime-context` against the same
`conversationWindowMs` the brake reads, anchored on `first_contacted_at ?? created_at`, and
carried on `RuntimeContext.firstConversation`.

**The warm close is triggered by a lull, never by a stored name.** In conversation it needs
the guest's sign-off AND the model's goodbye (`closesFirstConversation`); otherwise the pause
timer sends it, for any first Instagram conversation, scanned or not. **Neither path closes a
conversation staff answered by hand or one that contains a complaint** (`warmCloseBlocker`,
one check called by both, before the marker is claimed).

**After a warm close, no question until the guest is two messages past it AND one reply of
ours has reached them in between** (`isQuietAfterWarmClose`, `warm-close.ts`); two messages
five seconds apart are answered by one reply, which is still the very next one. It has the brake's shape: nothing renders, nothing
is recorded, so every intention comes back open. Not limited to a first conversation.

**`deriveOpenIntentions` applies the first-conversation policy TWICE and neither is
redundant.** The arming loop skips a suppressed intention, so no `eligible_at` row is written
and its window does not start ticking on a question nobody may ask. The open-set filter is the
actual guarantee: first-contact eligibility is STICKY, so a row already on file is never
re-gated and only the filter can stop it rendering.

The prompt half is a restraint paragraph the serializer renders into the intentions block when
`firstConversation` is true. It rides that block, so it does not render on a first-conversation
turn where nothing is open - stated at the constant, not discovered.

`understand_order` must not arm off `guests.last_visit_at` - every writer of that column
runs downstream of a transaction, and a transaction satisfies the intention.

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

**`''` is byte-identical to the pre-TAC-554 path.** The answer's own cap drops to `MAX_BUBBLES_PER_RESPONSE - 1`
so the total still honours the cap.

**`fitBubblesToInstagramCap` takes the tail too, and must.** Its repack throws the bubble
structure away and re-packs the whole reply greedily, which merges the question back into
the message in front of it - and only when a bubble is over 1000 bytes, so it is the kind of
conditional regression nothing notices.

Prompt wording cannot reach any of this: see `docs/decisions/0007-intention-question-is-its-own-bubble.md`.

## A reported visit can be taken back (TAC-573)

`retract-reported-visit.ts` owns it; its header has the rulings. The model reports
`reportedVisitCorrection`, code decides which rows may go, and every visit reader filters
`retracted_at is null`. **A new reader of `transactions` must filter it too.**

## Proactive sends (TAC-386)

Four paths reach a guest with no inbound behind them (the fourth is TAC-575's timed
check-back, described under Intentions): the scan greeting (TAC-536; started by
the Instagram webhook's fast path, cron as backstop, so only pausing the venue stops it), the warm
close (TAC-560; any first Instagram conversation since TAC-575), the inquiry follow-up (TAC-386, `lib/followups/`). **No two within 60
minutes**, via `proactive-spacing.ts` and `guests.last_proactive_send_at`. A follow-up is NOT
a warm-close anchor, excluded inside `loadWarmCloseCandidates`. Reasons in those headers.

## Other rules that bite

- `dispatch-reply.ts` is the one place a reply picks its transport. Nothing routes on a
  null channel.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
