<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `lib/agent`

42 test files, 1539 `it`/`test` declaration sites, 31 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `lib/agent/build-runtime-context.test.ts` | 32 | names | buildRuntimeContext: brake history horizon (TAC-380); buildRuntimeContext: recorded-order arming input (TAC-380); buildRuntimeContext: history delivery (TAC-394); buildRuntimeContext: visit_confirmed… |
| `lib/agent/calendar.test.ts` | 11 | names | computeCalendar (TAC-522) |
| `lib/agent/coalesce-inbound.test.ts` | 37 | header | TAC-526: the orchestrator half of burst coalescing. |
| `lib/agent/coalesce-turn.test.ts` | 56 +1e | names | claimInboundTurn; releaseInboundTurn; pickNewer; the shipped constants; the default store is bound to migration 057; the DEFAULT store issues the right queries; the DEFAULT findNewerInbound query; fi… |
| `lib/agent/comp-backstop.test.ts` | 4 | names | matchComp — positive (should fire); matchComp — negative (must NOT fire); matchComp — pattern surface |
| `lib/agent/complaint-floor.test.ts` | 11 | header | Fixtures are the COMPLETE set of comp_complaint outbounds in production at the time this module was written (2026-05-02 .. 2026-08-07, 12 rows), not a hand-written sample. `expected` is the ground-tr… |
| `lib/agent/complaint-routing.test.ts` | 4 | header | FIXTURES WRITTEN BEFORE THE MODULE (v1.24.0). |
| `lib/agent/conversation-channel.test.ts` | 17 | names | resolveConversationChannel; venueMessagingNumberRequired (TAC-495) |
| `lib/agent/crisis-safety.test.ts` | 13 | names | CRISIS_SAFETY_REPLY_BODY (TAC-348); buildCrisisSafetyResult (TAC-348); CRISIS_SAFETY_REVIEW_REASON (TAC-348) |
| `lib/agent/dispatch-arrival-capture.test.ts` | 26 | header | TAC-363: first tests for the arrival-capture dispatch. |
| `lib/agent/dispatch-instagram-reply.test.ts` | 48 | names | dispatchInstagramReply: the window is open; dispatchInstagramReply: what the row says it answers; dispatchInstagramReply: what reached the guest; dispatchInstagramReply: the window is closed; dispatc… |
| `lib/agent/dispatch-reply.test.ts` | 4 | names | dispatchReply (TAC-469) |
| `lib/agent/extract-recent-visits.test.ts` | 20 | names | extractRecentVisits — null / empty inputs; extractRecentVisits — order preservation; extractRecentVisits — per-row freshness cutoff; extractRecentVisits — per-row raw_data shape; extractRecentVisits… |
| `lib/agent/extract-reported-order.test.ts` | 78 | names | bodyMentionsMenuItem (pure prefilter); QR prefilled-body collision guard (TAC-326); resolveReportedItems (pure resolution); extractReportedOrder (orchestration gate) |
| `lib/agent/followup-rules.test.ts` | 24 | names | canSendFollowup; isQuietHour |
| `lib/agent/group-responses.test.ts` | 26 +4e | names | groupIntoResponses; deriveDelivery (TAC-394); groupIntoResponses delivery (TAC-394) |
| `lib/agent/handle-followup.test.ts` | 33 +3e | names | handleFollowup — mechanic-offer backstop wiring (TAC-355); handleFollowup: a draft with nowhere to go (TAC-394); handleFollowup: never on Instagram (TAC-469); handleFollowup — prose-promise backstop… |
| `lib/agent/handle-holding-message.test.ts` | 29 | names | handleHoldingMessage (TAC-308); handleHoldingMessage — grounding backstop (TAC-376); handleHoldingMessage — suppression + persistence (TAC-308 review); handleHoldingMessage — Instagram (TAC-469) |
| `lib/agent/handle-inbound.test.ts` | 126 +3e | header | TAC-309. Tests for the generation-failure fallback in the inbound orchestrator. |
| `lib/agent/handle-operator-decline.test.ts` | 25 | header | TAC-299. Tests for the operator-initiated decline orchestrator. |
| `lib/agent/holding-message-replay.test.ts` | 10 +1e | header | TAC-484: the 2026-09-18 Le Mil's exchange, replayed against the real gate, the real persist layer and the real findPendingQuestion. |
| `lib/agent/instagram-scan-greeting.test.ts` | 14 | header | TAC-536: the every-minute processor that turns a pending scan into a greeting, or records why it did not. |
| `lib/agent/instagram-window-warning.test.ts` | 17 | header | TAC-473: the one-hour Instagram reply-window warning. |
| `lib/agent/intentions/definitions.test.ts` | 22 +1e | names | INTENTION_DEFINITIONS — shape; INTENTION_DEFINITIONS — arming, gates and windows (rulings 2–4); INTENTION_DEFINITIONS — rule interactions; isSatisfied truth table |
| `lib/agent/intentions/derive.test.ts` | 100 +1e | names | window constants; deriveOpenIntentions — state rows (trap 1); deriveOpenIntentions — arming; deriveOpenIntentions — re-arming; deriveOpenIntentions — conversational gate; deriveOpenIntentions — eligi… |
| `lib/agent/intentions/load.test.ts` | 8 | names | loadIntentionRows |
| `lib/agent/intentions/record.test.ts` | 30 | names | buildEligibilityRow (trap 3); recordIntentionEligibility; recordIntentionPrompts; re-arm and stamp, applied to a row in either order |
| `lib/agent/knowledge-gap-timeout.test.ts` | 15 | names | processDueKnowledgeGaps (TAC-308); processDueKnowledgeGaps — disabled by default (TAC-484) |
| `lib/agent/knowledge-tag-mapping.test.ts` | 7 | names | getPrimaryTagPreference |
| `lib/agent/looks-like-question.test.ts` | 3 | names | looksLikeQuestion — positive (reads as a question); looksLikeQuestion — negative (does not read as a question); looksLikeQuestion — accepted precision-over-recall tradeoff |
| `lib/agent/pending-question.test.ts` | 14 | header | TAC-364: the repo's first test for this module. |
| `lib/agent/pending-slots.test.ts` | 97 +9e | header | TAC-394, option F: two pending slots per guest. |
| `lib/agent/record-inbound-turn-outcome.test.ts` | 21 +1e | names | ledgerEntryFor — every AgentResult status maps to a ledger entry; recordInboundTurnOutcome — the row it writes; recordInboundTurnOutcome — never throws; insertInboundTurnOutcome — the shared writer |
| `lib/agent/retrieval-context.test.ts` | 32 +1e | names | reachedGuest — only what the guest actually read steers the search; buildContextQuery; mergeKnowledgeMatches |
| `lib/agent/scan-arrival.test.ts` | 10 | header | TAC-536's timing rules. Every constant here decides something guest-facing, so the boundaries are pinned rather than the middles. |
| `lib/agent/schedule-and-send.test.ts` | 72 | names | persistOrRegenQueuedDraft (TAC-264); persistOrRegenQueuedDraft — pending_until (TAC-308); persistOrRegenQueuedDraft — updateOnly (TAC-308); persistOrRegenQueuedDraft — blankBody (TAC-309); scheduleAn… |
| `lib/agent/sentence-split.test.ts` | 32 +1e | names | splitIntoSentences; stripTerminalPeriod; resolveDispatchBubbles — the flip |
| `lib/agent/split-message.test.ts` | 10 +1e | names | collapseToSingleMessage; constants |
| `lib/agent/stages.test.ts` | 345 +2e | names | retrieveCorpusStage — inbound path (existing behavior); retrieveCorpusStage — followup path (THE-231); shouldRetrieveKnowledge; classifyStage — 3-tier confidence routing (v1.11.0); retrieveKnowledgeS… |
| `lib/agent/two-pending-slots.test.ts` | 38 | header | TAC-394, option F, end to end against an in-memory `messages` table. |
| `lib/agent/typing-indicator.test.ts` | 8 +2e | header | TAC-540: the channel switch for the typing indicator. |
| `lib/agent/venue-open-state.test.ts` | 10 | header | TAC-363: tests for the shared open/closed derivation. |
