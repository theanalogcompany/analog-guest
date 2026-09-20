// The agent REPLIES to Instagram guests. Flipped by TAC-469's PR C on
// 2026-09-20, alone and last, so a rollback is a one-line revert of this
// constant and nothing else.
//
// TAC-468 added the handler with replies OFF; TAC-469 built outbound
// (lib/agent/dispatch-reply.ts routes a reply by the conversation's channel,
// lib/agent/dispatch-instagram-reply.ts sends it) and deliberately left the
// gate shut so the flip could be its own change. The constant and the
// `enabled` parameter are deleted in a later cleanup, once replies have run
// for a while; until then agent-gate.test.ts pins the constant at true AND
// keeps the shut behaviour covered through the parameter, because that is what
// a rollback restores.
//
// ROLLING BACK: set this to false. Nothing else has to move. In-flight drafts
// are unaffected — a queued Instagram card stays queued and an operator can
// still send it while the window is open — and no guest gets a partial
// conversation, because the gate decides whether the agent RUNS, not whether a
// send succeeds.
//
// The pre-flight this waited on, as closed (TAC-469):
//   - Ice-breaker titles vs the menu: live config read from Meta. One title,
//     "Hi Le Mil's!", greeting-shaped, no menu collision. RE-CHECK after the
//     Phase 3 OAuth connect: titles do not carry across accounts and nothing
//     automates setting them.
//   - "text" / "number" / "DM" in Instagram replies: measured, 0 phone claims
//     in 24 Instagram generations across two configurations, the second with
//     the grounding backstop in the loop. The control was recorded as SPENT
//     rather than passed — every fix that cleaned the Instagram arm also
//     removed a control provocation. Not proof; enough for a one-venue pilot
//     behind an operator queue.
//   - STOPs received while the gate was shut: all 5 Instagram inbound rows
//     read, 3 guests, no opt-out language of any kind. A STOP sent as a voice
//     note or sticker would be invisible (those are logged, not saved), which
//     the read cannot exclude.
//   - TAC-492 device pass on a fresh Instagram account.
//
// What the shut gate was hiding, and where each stands (TAC-469):
//   - A postback saved with no title (body '', no media). HANDLED: the agent is
//     not run on it (agentMessageIdFor below), and the saved-event log line
//     carries titlelessPostback: true. The row still opens the reply window.
//     Since TAC-492 it can be a QR guest's opener turn; because the history
//     query skips empty bodies, the opener then fires on the guest's NEXT
//     message instead. Meta has always sent a title in what was captured.
//   - A message the guest unsent is only logged (message_deleted), so it stays
//     in the thread and in the agent's history. ACCEPTED, not fixed.
//   - A STOP received while the gate was shut was never classified. DONE
//     2026-09-20: every Instagram inbound row read, none is an opt-out. Opt-out
//     is still not recorded on any channel (TAC-475), so an Instagram guest who
//     says STOP from here on is handled only by the classifier inside the agent
//     run this flip turns on, and PR B still records a follow-up task for them.
//   - The icebreaker titles (TAC-492). A QR guest's first message is the title
//     of the icebreaker they tapped, which lives in Meta's settings and nowhere
//     in this repo. RULED 2026-09-19: keep every title a greeting. A question-
//     shaped title isn't worth measuring: the opener's copy branches explicitly
//     (if the guest asked something, answer that instead), so a question
//     suppresses the recognition moment deterministically, every time. A
//     title that names a menu item drops understand_order's line for the turn
//     (applyCurrentTurnSuppression, TAC-326) and sends the turn to the order
//     extractor; the "QR prefilled-body collision guard" table in
//     extract-reported-order.test.ts carries Le Mil's title and menu, and has
//     to be updated whenever either changes, because nothing errors when it
//     breaks. Per Jaipal the configured title is "Hi Le Mil's!" (payload
//     ICEBREAKER_HELLO). An earlier version of this comment called "What are
//     your hours?" the recorded title; that was the body of a Phase 0 QA step,
//     not a configured title. MANUAL, before the flip: read the LIVE titles
//     from Meta and confirm the table matches.
//
// TAC-495's five, all on TAC-469's pre-flight list:
//   - A returning guest is greeted as a first-timer (TAC-497): the first-visit
//     gate can't see DM history from before the integration. ACCEPTED for the
//     pilot (ruled 2026-09-19): one venue, low volume, a tone mismatch rather
//     than a false claim, and it reaches only guests just created (the opener
//     still needs qr_scan, no prior rows, creation within 7 days). Revisit
//     before a second venue.
//   - Measure it. DONE: see the pre-flight above. The formality watch-item
//     stands — if the Instagram voice reads more formal than Sendblue's, look
//     first at the casual formality line ("message a friend"; serializers.ts),
//     which the measurement did not test for.
//   - Surface an unresolved channel. DONE: buildRuntimeContext raises
//     conversation_channel_unresolved (PostHog and Slack), and nothing routes
//     a send on a null channel.
//   - Guests with both identifiers. DONE: with no inbound message, the channel
//     is the one the guest last messaged on (conversation-channel.ts), and the
//     copy and the routing read the same answer. No such guest exists yet.
//   - An Instagram-only venue. DONE for sends: nothing on the Instagram path
//     reads messaging_phone_number (window-import-guard.test.ts pins that).
//     NOT fixed: the test harness (run-test-scenarios) still needs the number,
//     since its synthetic guests all have phones, so it stops working at Le
//     Mil's when the number is deleted.
//
// The kind check below is NOT part of the gate and stays when it goes: an echo
// is the venue's own message and a read receipt is not a message, so neither
// is ever handed to the agent. Without it, the agent would answer its own
// replies once they echo back.
//
// Scheduled follow-ups never reach Instagram at all (TAC-469 rule 2):
// handleFollowup refuses an Instagram conversation, and the Command Center
// Follow Up button refuses one before generating.

import type { InstagramEventOutcome } from './handle-events'

export const INSTAGRAM_AGENT_REPLIES_ENABLED: boolean = true

/**
 * The message row to hand to the agent for this outcome, or null. Only a
 * guest message or postback saved by this delivery qualifies, and only while
 * the gate is open. A duplicate is never handed over: its first delivery was.
 */
export function agentMessageIdFor(
  outcome: InstagramEventOutcome,
  enabled: boolean = INSTAGRAM_AGENT_REPLIES_ENABLED,
): string | null {
  if (!enabled) return null
  if (outcome.status !== 'persisted' || outcome.kind === 'echo') return null
  // TAC-469: an icebreaker tap with no title is an empty inbound. There is
  // nothing to reply to, so the agent isn't run; the row still opens the
  // window, and the saved-event log line says it was titleless.
  if (outcome.titlelessPostback) return null
  return outcome.messageId
}
