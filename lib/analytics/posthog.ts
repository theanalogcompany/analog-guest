/**
 * PostHog event registry for the agent observability layer.
 *
 * Dependency direction: this module is a leaf — other modules (lib/agent,
 * cron routes, etc.) import from here. This module imports only from
 * posthog-node, the Slack alert primitive, and the pure logger. Never
 * reverse the direction; analytics should never depend on agent code.
 *
 * The underlying primitive is `capturePostHogEvent`, which lazily initializes
 * the PostHog client and swallows internal failures so an analytics outage
 * can't cascade into the orchestrator. Each named helper is a typed wrapper
 * that documents the event shape and threshold.
 *
 * PII: event payloads currently include full inbound and generated message
 * text for retrieval-debugging during pilot. This is acceptable today (only
 * test traffic from the team). When real pilot guests start texting, redact
 * inboundBody / generatedBody / topMatchPreview before they leave the
 * boundary, OR migrate to PostHog projects with PII handling configured.
 *
 * Events:
 *
 * - inbound_message_handled / inbound_message_skipped /
 *   followup_message_handled
 *     Existing happy-path events fired from handle-inbound and
 *     handle-followup. Continue to use capturePostHogEvent directly.
 *
 * - inbound_message_failed / followup_message_failed
 *     Existing failure events fired from fireRedAlert (lib/agent/alerts.ts).
 *
 * - regeneration_triggered
 *     Fires when generateMessage's internal loop made > 1 attempt (self-talk
 *     or unverified-link retry; fidelity retries left with the v1.80.0
 *     schema diet, as did the voice_fidelity_low event).
 *     Properties: { agentRunId, venueId, guestId, attempts, inboundBody,
 *                   finalGeneratedBody }
 *
 * - dash_violation_persisted
 *     Fires when generateMessage exhausted MAX_ATTEMPTS regenerations and
 *     the shipped body still contains an em (—) or en (–) dash. The dash
 *     regex check (THE-225) is a deterministic backstop on top of the R3
 *     voice rule; persisted failures ship anyway and surface here.
 *     Properties: { agentRunId, venueId, guestId, category, attempts,
 *                   inboundBody, finalGeneratedBody }
 *
 * - classification_low_confidence
 *     Fires when classifierConfidence < 0.7. The `category` field carries the
 *     classifier's original pick (preserved even when the orchestrator
 *     auto-routed to `unknown` for confidence < 0.3 — see
 *     CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD). `autoRoutedToUnknown`
 *     distinguishes the two bands so dashboards can filter on routing
 *     behavior without losing the original signal.
 *     Properties: { agentRunId, venueId, guestId, category,
 *                   classifierConfidence, inboundLength, inboundBody,
 *                   autoRoutedToUnknown }
 *
 * - agent_latency_high
 *     Fires when handleInbound or handleFollowup total elapsed > 10s.
 *     Skipped on the duplicate-skip return path (fast, not interesting).
 *     Properties: { agentRunId, venueId, guestId, totalElapsedMs, kind }
 *
 * - demo_bypassed_approval_gate
 *     TAC-284. Fires from applyApprovalPolicyStage when a guest flagged
 *     is_demo=true bypasses the TAC-212 approval policy gate AND the bypass
 *     actually overrode a queue decision (the would-have-queued trigger set
 *     is non-empty). A clean demo reply that would have auto-sent anyway
 *     produces no event. Slack-relays ONLY when 'comp_regex_backstop' is
 *     among the would-have-queued triggers — that's the irreversible-
 *     financial-commitment case, and demo mode disabling the backstop
 *     should be loud.
 *     Properties: { agentRunId, venueId, guestId, wouldHaveQueuedTriggers,
 *                   generatedBody }
 *
 * - webhook_silence
 *     Daily cron event. Fires when no inbound webhook has landed in 24+
 *     hours, but only when there's been at least one prior inbound (i.e.,
 *     skipped on initial venue state). Filtered to non-test venues.
 *     Properties: { hoursWithoutWebhook, lastWebhookAt }
 */

import { PostHog } from 'posthog-node'
import { logger } from '@/lib/observability/logger'

import { postToSlack, truncate } from './slack'

const SLACK_FIELD_TRUNCATE_CHARS = 300

let postHogClient: PostHog | null = null

function getPostHog(): PostHog {
  if (postHogClient) return postHogClient
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  if (!apiKey) throw new Error('Missing env var: NEXT_PUBLIC_POSTHOG_KEY')
  postHogClient = new PostHog(apiKey, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
  })
  return postHogClient
}

/**
 * Primitive for capturing any PostHog event. Never throws; on internal
 * failure logs via logger.error and swallows so analytics outages can't
 * cascade into the orchestrator.
 */
export async function capturePostHogEvent(
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  try {
    getPostHog().capture({
      distinctId,
      event,
      properties: { ...properties, ts: new Date().toISOString() },
    })
  } catch (e) {
    logger.error(`alert: posthog capture failed for ${event}`, {
      distinctId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD = 0.7
// Below this confidence, classifyStage rewrites the returned category to
// `unknown` so the agent ships a holding response. Original pick is preserved
// on the PostHog event payload for triage. Sits below the 0.7 LOW threshold.
export const CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD = 0.3
export const WEBHOOK_SILENCE_THRESHOLD_HOURS = 24

/**
 * Per-kind latency thresholds for the `agent_latency_high` event.
 *
 * PER-KIND BECAUSE ONE NUMBER CANNOT SERVE BOTH. Measured over 30 days to
 * 2026-09-29, from the Langfuse traces endpoint:
 *
 *   agent.inbound    n=276  p50 18.0s  p90 28.0s  p95 31.5s  p99 40.7s  max 68.5s
 *   agent.followup   n=132  p50  0.2s  p90  0.7s  p95  1.0s  p99 20.8s  max 21.9s
 *
 * They differ by ~90x at p50, because most followups never reach a model call.
 * The single shared 10_000 that used to live here fired on **99.3% of inbound
 * turns** (274/276) and relayed every one to Slack, which is how an alert
 * channel gets trained into background noise.
 *
 * Chosen to sit in the genuine tail rather than on the body of the
 * distribution, and deliberately NOT so high that the alarm can never fire —
 * a gate whose true-positive history you cannot produce is not a gate:
 *
 *   inbound  35_000 -> fired on 7/276 = 2.5% of the measured window (above p95)
 *   followup 20_000 -> fired on 2/132 = 1.5% (followup max is 21.9s, so this
 *                      is reachable; 25_000 would have made it dead)
 *
 * Re-derive from the same source if the pipeline's shape changes, and check BOTH
 * numbers still fire in the low single-digit percents. The query is in
 * `lib/observability/CLAUDE.md`.
 */
export const AGENT_LATENCY_HIGH_THRESHOLD_MS = {
  inbound: 35_000,
  followup: 20_000,
  // `satisfies`, not `:` — a `Record<AgentLatencyKind, number>` annotation would
  // also accept a missing key via widening in some positions, and this must fail
  // `tsc` if a third kind is added without a measured threshold.
} satisfies Record<AgentLatencyKind, number>

/**
 * Whether a run's elapsed time clears the bar for its kind.
 *
 * A helper rather than exposing the record to call sites: three orchestrators
 * compare against this, and an indexing expression at each is three chances to
 * index with the wrong kind.
 */
export function isAgentLatencyHigh(
  kind: AgentLatencyKind,
  totalElapsedMs: number,
): boolean {
  return totalElapsedMs > AGENT_LATENCY_HIGH_THRESHOLD_MS[kind]
}

// ---------------------------------------------------------------------------
// Named-event helpers
// ---------------------------------------------------------------------------

export interface RegenerationTriggeredProps {
  agentRunId: string
  venueId: string
  guestId: string
  attempts: number
  inboundBody: string | null
  finalGeneratedBody: string
}

export async function captureRegenerationTriggered(
  props: RegenerationTriggeredProps,
): Promise<void> {
  await capturePostHogEvent('regeneration_triggered', props.guestId, {
    ...props,
  })
  await postToSlack(formatRegenerationTriggered(props))
}

function formatRegenerationTriggered(
  props: RegenerationTriggeredProps,
): string {
  const lines = [
    `*Regeneration triggered* — ${props.attempts} attempts`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
  ]
  if (props.inboundBody) {
    lines.push(
      `inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
    )
  }
  lines.push(
    `final generated: "${truncate(props.finalGeneratedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  )
  return lines.join('\n')
}

// TAC-362: this turn's emoji directive was 'none' and the body shipped with
// an emoji anyway. Observation only — the body is NOT rewritten, matching
// the dash posture below: a post-generation body mutation would be this
// repo's first on the generation path, and the measured violation rate for a
// per-message emoji prohibition is 0 across 240 responses.
//
// PostHog only, NO Slack relay. This is a voice-quality observation, not an
// operational alert — nobody needs waking for one stray emoji. Its value is
// that a CHANGE in that 0-in-240 rate becomes queryable rather than
// invisible; if it turns out non-zero in practice, the deterministic strip
// backstop lands in a follow-up with evidence behind it instead of on a
// guess.
export interface EmojiDirectiveViolatedProps {
  agentRunId: string
  venueId: string
  guestId: string
  category: string
  emojiPolicy: string
  finalGeneratedBody: string
}

export async function captureEmojiDirectiveViolated(
  props: EmojiDirectiveViolatedProps,
): Promise<void> {
  await capturePostHogEvent('emoji_directive_violated', props.guestId, {
    ...props,
  })
}

// THE-225: dash regex check inside generateMessage's regen loop forces a
// rewrite when an em or en dash sneaks past R3 in the system prompt. If
// MAX_ATTEMPTS exhaust without a clean reply, we ship the final body anyway
// (refusing on punctuation would be worse than violating it) and emit this
// event so the failure is visible in the silent-failure surfaces alongside
// regeneration_triggered.
export interface DashViolationPersistedProps {
  agentRunId: string
  venueId: string
  guestId: string
  category: string
  attempts: number
  inboundBody: string | null
  finalGeneratedBody: string
}

export async function captureDashViolationPersisted(
  props: DashViolationPersistedProps,
): Promise<void> {
  await capturePostHogEvent('dash_violation_persisted', props.guestId, {
    ...props,
  })
  await postToSlack(formatDashViolationPersisted(props))
}

function formatDashViolationPersisted(
  props: DashViolationPersistedProps,
): string {
  const lines = [
    `*Dash violation persisted* — shipped after ${props.attempts} attempts`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `category: \`${props.category}\``,
  ]
  if (props.inboundBody) {
    lines.push(
      `inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
    )
  }
  lines.push(
    `final generated: "${truncate(props.finalGeneratedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  )
  return lines.join('\n')
}

export interface ClassificationLowConfidenceProps {
  agentRunId: string
  venueId: string
  guestId: string
  category: string
  classifierConfidence: number
  inboundLength: number
  inboundBody: string
  // True when classifyStage rerouted the classification to `unknown`
  // (confidence < CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD). The
  // `category` field still carries the classifier's original pick — this
  // flag is the routing signal layered on top.
  autoRoutedToUnknown: boolean
}

export async function captureClassificationLowConfidence(
  props: ClassificationLowConfidenceProps,
): Promise<void> {
  await capturePostHogEvent('classification_low_confidence', props.guestId, {
    ...props,
  })
  await postToSlack(formatClassificationLowConfidence(props))
}

function formatClassificationLowConfidence(
  props: ClassificationLowConfidenceProps,
): string {
  const lines = [
    `*Classification low confidence* — \`${props.classifierConfidence.toFixed(2)}\` for category \`${props.category}\``,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `inbound (${props.inboundLength} chars): "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ]
  // Two operator workflows: 0.3..0.7 = agent shipped at the classifier's pick,
  // operator should check; < 0.3 = agent shipped a holding ack, operator
  // decides if a real reply is needed. Spell out the action in the Slack copy.
  if (props.autoRoutedToUnknown) {
    lines.push(
      'auto-routed to: `unknown` — agent shipped holding ack; decide if a real reply is needed',
    )
  }
  return lines.join('\n')
}

export interface ComplaintThreadTurnProps {
  agentRunId: string
  venueId: string
  guestId: string
  /** What the classifier picked, after the low-confidence reroute. */
  classifierCategory: string
  classifierConfidence: number
  /** What the turn ran under. */
  category: string
  /** True when the open complaint thread replaced the classifier's pick. */
  carried: boolean
  crisisSafety: boolean
}

/**
 * A turn that answered a complaint's auto-sent clarifying question
 * (lib/agent/complaint-thread.ts). Fired whether or not the category was
 * carried, so `carried: true` over all events is the override rate, and
 * `classifierCategory` says what the classifier would have run the turn as.
 *
 * PostHog only. Carries no message content, and the turn it describes is
 * already an operator card, which is where a human sees it.
 */
export async function captureComplaintThreadTurn(
  props: ComplaintThreadTurnProps,
): Promise<void> {
  await capturePostHogEvent('complaint_thread_turn', props.guestId, {
    ...props,
  })
}

// `corpus_retrieval_below_threshold` (and CORPUS_TOP_SIMILARITY_LOW_THRESHOLD)
// lived here until decision 0008 (2026-09-29): voice is a static per-venue
// pack, so there is no similarity left to be thin. Historical PostHog rows
// under that event name describe the retrieval era.

/**
 * TAC-509: a reply carried a link that is not on the venue's curated
 * `venue_info.links` allowlist, and it survived every regen attempt. The draft
 * is queued, never sent.
 *
 * Slack-relays. A gate whose true-positive history cannot be produced on
 * demand is an unproven gate (CLAUDE.md, Common gotchas — `comp_regex_backstop`
 * read as a working comp backstop for two months on a single hit that was a
 * false positive). This one is expected to be quiet, which is exactly why each
 * firing should be visible rather than sitting in a PostHog count nobody
 * queries.
 *
 * `allowedUrlCount` is what tells a reader whether a hold means "the model
 * invented a link" or "this venue has no list yet" — the two look identical on
 * the card and have completely different fixes.
 */
export interface UnverifiedUrlHeldProps {
  agentRunId: string
  venueId: string
  guestId: string
  category: string | null
  // The links that were not on the list, verbatim as the model wrote them.
  unverifiedUrls: string[]
  // How many links the venue actually has curated. 0 means nothing was
  // sendable on this turn whatever the model wrote.
  allowedUrlCount: number
  // Never sent to the guest — the gate queues this draft.
  generatedBody: string
}

export async function captureUnverifiedUrlHeld(
  props: UnverifiedUrlHeldProps,
): Promise<void> {
  await capturePostHogEvent('unverified_url_held', props.guestId, { ...props })
  await postToSlack(formatUnverifiedUrlHeld(props))
}

/**
 * Decision 0003 (rewritten 2026-09-29): where the draft was when a
 * post-generation check fired.
 *
 *   'held' — the check ran BEFORE the send (followups, the holding message)
 *            and the draft queued or blocked as a result.
 *   'sent' — the check ran AFTER dispatch on the inbound path; the reply had
 *            already reached the guest and this event is the Slack forward
 *            for an upstream fix, not a hold notice.
 *
 * REQUIRED on every check event rather than defaulted, so each producer has
 * to state which claim it is making — a headline that misstates whether a
 * guest saw the reply is worse than none (the TAC-424 lesson).
 */
export type CheckDisposition = 'held' | 'sent'

// TAC-436 ruling 5: the post-send recorder RAISED an intention. Until this,
// a successful raise was a bare console.log on both send paths, so the only
// intention signals that reached PostHog or Slack were the two failures below
// — and since TAC-380 shipped, zero intentions had been raised, which was
// itself invisible. This event is what makes the first production raise
// observable, and it is the signal TAC-385 PR 2 keys its rollout on.
//
// Slack-relayed at pilot volume DELIBERATELY, unlike most success events: the
// question this exists to answer is "has an intention ever been raised", and
// at zero-to-a-handful a day the relay IS the answer. Revisit the relay (not
// the event) if raising becomes routine.
//
// Shape mirrors IntentionPromptRecordingFailedProps below field for field
// where they overlap, so the two are diffable in PostHog.
export interface IntentionPromptRaisedProps {
  /** Null on the dispatch paths: that draft's agent run ended when it queued. */
  agentRunId: string | null
  /**
   * Which send path raised it. REQUIRED, not defaulted, for the same reason
   * the failure event's is: a fourth send path has to decide rather than
   * silently inherit 'auto_send'.
   */
  via: 'auto_send' | 'operator_approve' | 'operator_edit'
  venueId: string
  guestId: string
  messageId: string
  /** What the classifier said this message actually raised. Never empty. */
  raisedKeys: string[]
  /**
   * Everything that was rendered and offered to the classifier. Carried so a
   * 1-of-4 raise is legible without a second query: raisedKeys alone cannot
   * distinguish "one door was open and she took it" from "four were open and
   * she took one".
   */
  offeredKeys: string[]
  classifierAttempts: number
  /**
   * The body as SENT. Truncated in Slack, full in PostHog. Without it the
   * first production raise is a key name with nothing to judge, which is the
   * whole point of the event; the other agent-quality Slack events (mechanic
   * offer, prose promise) carry message text on the same basis.
   */
  sentBody: string
}

export async function captureIntentionPromptRaised(
  props: IntentionPromptRaisedProps,
): Promise<void> {
  await capturePostHogEvent('intention_prompt_raised', props.guestId, {
    ...props,
  })
  await postToSlack(formatIntentionPromptRaised(props))
}

function formatIntentionPromptRaised(
  props: IntentionPromptRaisedProps,
): string {
  // The offered set minus what was raised, so the line reads as "she took this
  // one, these were also open" rather than repeating the raised key.
  const alsoOffered = props.offeredKeys.filter(
    (k) => !props.raisedKeys.includes(k),
  )
  return [
    '*Intention raised* — the agent asked, and it is recorded',
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `via: ${props.via}`,
    ...(props.agentRunId === null ? [] : [`run: \`${props.agentRunId}\``]),
    `message: \`${props.messageId}\``,
    `raised: ${props.raisedKeys.join(', ')}${alsoOffered.length > 0 ? ` (also open: ${alsoOffered.join(', ')})` : ''}`,
    `sent: "${truncate(props.sentBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ].join('\n')
}

// The once-ever Google review ask (lib/agent/review-ask.ts).
//
// Two events, deliberately a denominator and a numerator:
//   review_ask_raised — the eligibility predicate fired on an inbound turn.
//     Every raise fires this, whatever the draft's fate (auto-send, queue,
//     drop), so classifier precision on `praisedExperience` is measurable
//     against what operators then approve or skip.
//   review_ask_sent — the link actually reached the guest and the once-ever
//     marker was stamped (or found already stamped by a racing run). This is
//     the feature's true-positive history; a gate whose history cannot be
//     produced is an unproven gate.
// PostHog only, no Slack: neither is an anomaly, and the queue path already
// Slack-relays through the ordinary card flow.
export interface ReviewAskRaisedProps {
  agentRunId: string
  venueId: string
  guestId: string
  /** The curated link's label — which entry the predicate found. */
  linkLabel: string
  /** The inbound that read as praise, for judging the classifier's call. */
  inboundBody: string
}

export async function captureReviewAskRaised(
  props: ReviewAskRaisedProps,
): Promise<void> {
  await capturePostHogEvent('review_ask_raised', props.guestId, { ...props })
}

export interface ReviewAskSentProps {
  /** Null on the operator dispatch path: that draft's run ended at queue time. */
  agentRunId: string | null
  /** Which send path delivered it. A third path has to decide, not inherit. */
  via: 'auto_send' | 'operator_dispatch'
  venueId: string
  guestId: string
  messageId: string
  /** 'marked' = this write owns the once-ever stamp; 'already_marked' = a racing run beat it. */
  outcome: 'marked' | 'already_marked'
}

export async function captureReviewAskSent(
  props: ReviewAskSentProps,
): Promise<void> {
  await capturePostHogEvent('review_ask_sent', props.guestId, { ...props })
}

// TAC-380: the post-send intention recorder could not record normally. Both
// outcomes Slack-relay, because both change what a guest will be asked:
//   - closed_pessimistically: the classifier failed on every attempt, so every
//     rendered intention was closed without being judged. Nothing re-asks, but
//     a run of these means intentions are closing blind.
//   - write_failed: the database write failed. The one remaining path to a
//     genuine re-ask, which is the failure intentions exist to prevent.
// Before TAC-380 both were a bare console.warn, invisible in PostHog and Slack,
// and this ticket takes the number of intentions they apply to from two to seven.
export interface IntentionPromptRecordingFailedProps {
  /**
   * TAC-385 PR 1: NULLABLE, because the operator dispatch path has no agent
   * run — the draft's run ended when it was queued, possibly hours earlier.
   * Faking one would put a meaningless id in the Slack line; `via` below is
   * what tells you where to look instead.
   */
  agentRunId: string | null
  /**
   * Which send path this closure happened on. REQUIRED rather than optional,
   * so a third send path has to decide rather than silently inherit
   * 'auto_send'. It matters for triage: on the dispatch paths the offered set
   * came from the model's draft, which the operator may have rewritten, so a
   * pessimistic closure there can be wrong in a way it cannot be on auto-send.
   */
  via: 'auto_send' | 'operator_approve' | 'operator_edit'
  venueId: string
  guestId: string
  messageId: string
  outcome: 'closed_pessimistically' | 'write_failed'
  keys: string[]
  /** write_failed only: which kind of close was being written. */
  source?: 'classified' | 'pessimistic'
  /** Provider/DB error text. Never contains guest or venue content. */
  error: string
}

export async function captureIntentionPromptRecordingFailed(
  props: IntentionPromptRecordingFailedProps,
): Promise<void> {
  await capturePostHogEvent(
    'intention_prompt_recording_failed',
    props.guestId,
    { ...props },
  )
  await postToSlack(formatIntentionPromptRecordingFailed(props))
}

function formatIntentionPromptRecordingFailed(
  props: IntentionPromptRecordingFailedProps,
): string {
  const headline =
    props.outcome === 'closed_pessimistically'
      ? '*Intention classifier failed twice* — rendered intentions closed without a verdict'
      : '*Intention prompt write failed* — these intentions may be asked again'
  return [
    headline,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `via: ${props.via}`,
    ...(props.agentRunId === null ? [] : [`run: \`${props.agentRunId}\``]),
    `message: \`${props.messageId}\``,
    `keys: ${props.keys.join(', ')}${props.source ? ` (${props.source})` : ''}`,
    `error: "${truncate(props.error, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ].join('\n')
}

function formatUnverifiedUrlHeld(props: UnverifiedUrlHeldProps): string {
  const urlList = props.unverifiedUrls
    .map((u) => `\`${truncate(u, SLACK_FIELD_TRUNCATE_CHARS)}\``)
    .join(', ')
  const lines = [
    `*Unverified link held* — reply never sent, queued for review`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `category: ${props.category ?? 'unknown'}`,
    `link(s) not on the venue list: ${urlList}`,
    `venue has ${props.allowedUrlCount} approved link(s)`,
    `held reply: "${truncate(props.generatedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ]
  return lines.join('\n')
}

// TAC-401: the independent prose-promise check caught a reply committing the
// venue to something of value with no structured commitment behind it.
//
// Slack-relayed, like both sibling backstops. The rate this fires at is the
// thing nobody could answer before the check existed: the model's own
// self-flag fired 0 times in 220 replies and the comp regex caught 0 of the 4
// genuine promises, so "how often does the agent promise in prose" had no
// observable answer at all.
export interface ProsePromiseCaughtProps {
  agentRunId: string
  venueId: string
  guestId: string
  /** null on a proactive turn (followup, holding message). */
  category: string | null
  /**
   * What the check said is owed. NULL when it flagged a promise but could not
   * name a usable type or description — a real and separate outcome, because
   * that card carries no carrier and approving it creates no commitment.
   */
  commitmentType: string | null
  commitmentDescription: string | null
  /**
   * True when generation had emitted a RECOMMENDATION and this check's
   * obligation replaced it on the card (ruling 3 as narrowed, 2026-09-21).
   *
   * Recorded because it is the one case where the row ends up carrying
   * something the generating model did not emit, and because it is worth being
   * able to count: a recommendation and a prose comp in the same reply is the
   * shape where the old behaviour recorded a drink suggestion for a comp the
   * venue owed.
   */
  replacedRecommendation: boolean
  /**
   * TAC-527: the guest message the reply was answering, or null on a proactive
   * turn.
   *
   * Without it this event cannot tell a CORRECT catch from a false one, because
   * for an elliptical promise the item in `commitmentDescription` comes entirely
   * from the guest's message and never appears in the reply. Guest "the gulab
   * jamun was stale too" / reply "ugh, that's on us too" naming "a replacement
   * gulab jamun" is right; guest naming an item while the reply accepts only
   * FAULT for it and the check mints a comp anyway (measured 8-10/10 on the
   * ell-11 fixture) is wrong, and the two are indistinguishable from the reply
   * alone. CLAUDE.md's own rule: distrust any gate whose true-positive history
   * you cannot produce on demand — sharpened here because a false positive now
   * MINTS an obligation on approval rather than only holding a draft.
   *
   * Precedent for carrying an inbound on an event: captureDraftQueued,
   * captureDraftRegenerated, captureAgentLatencyHigh.
   */
  guestInboundBody: string | null
  // The reply text that was caught. Under 'held' it queued unblanked; under
  // 'sent' it already reached the guest.
  replyBody: string
  disposition: CheckDisposition
}

export async function captureProsePromiseCaught(
  props: ProsePromiseCaughtProps,
): Promise<void> {
  await capturePostHogEvent('prose_promise_caught', props.guestId, { ...props })
  await postToSlack(formatProsePromiseCaught(props))
}

function formatProsePromiseCaught(props: ProsePromiseCaughtProps): string {
  const owed =
    props.commitmentType === null
      ? 'not named by the check'
      : `${props.commitmentType}: ${props.commitmentDescription}`
  const lines = [
    props.disposition === 'sent'
      ? `*Promise caught with no commitment behind it* — reply ALREADY SENT (post-send check); the promise is live and untracked`
      : `*Promise caught with no commitment behind it* — queued for review`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `category: \`${props.category ?? 'proactive'}\``,
    `owed: ${owed}`,
    props.replacedRecommendation
      ? `carrier: from this check, replacing a recommendation the model emitted`
      : `carrier: from this check`,
    // ABOVE the reply, because resolving the reply is what it is for: for an
    // elliptical promise the item in `owed` is taken from here and from nowhere
    // else, so a reader cannot judge the catch without it.
    props.guestInboundBody === null
      ? `guest said: (proactive turn, no inbound)`
      : `guest said: "${truncate(props.guestInboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
    `flagged reply: "${truncate(props.replyBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ]
  return lines.join('\n')
}

// TAC-401: the prose-promise check did not produce a readable verdict, so the
// draft was queued on an absence of information rather than a finding.
//
// A failure path with no signal is how a hole survives unobserved. The check
// FAILS CLOSED, so a sustained provider outage queues nearly every reply, and this event plus the operator
// push are what make that legible as an outage while it is happening rather
// than as a wave of caught promises.
export interface ProsePromiseCheckUnavailableProps {
  agentRunId: string
  venueId: string
  guestId: string
  /**
   * 'truncated' — the model produced a verdict and the output cap cut it off.
   *   Not retried: retrying a cap that was already hit spends a second call to
   *   hit it again.
   * 'errored' — a transient fault that survived one immediate retry.
   */
  outcome: 'truncated' | 'errored'
  /**
   * Whether a SECOND call was made, not which outcome produced the result.
   *
   * A first-call truncation is false, because truncation is never retried. But
   * a transient fault whose retry then truncated is `true` alongside
   * `outcome: 'truncated'` — the pair is not redundant and neither field
   * implies the other.
   */
  retried: boolean
  error: string
  errorCode?: string
  disposition: CheckDisposition
}

export async function captureProsePromiseCheckUnavailable(
  props: ProsePromiseCheckUnavailableProps,
): Promise<void> {
  await capturePostHogEvent('prose_promise_check_unavailable', props.guestId, {
    ...props,
  })
  await postToSlack(formatProsePromiseCheckUnavailable(props))
}

function formatProsePromiseCheckUnavailable(
  props: ProsePromiseCheckUnavailableProps,
): string {
  const lines = [
    props.disposition === 'sent'
      ? `*Prose-promise check did not complete* — no verdict, and the reply was ALREADY SENT (post-send check)`
      : `*Prose-promise check did not complete* — failed CLOSED, draft queued`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `outcome: \`${props.outcome}\``,
    `retried: ${props.retried ? 'yes, once' : 'no'}`,
    `error: ${truncate(props.error, SLACK_FIELD_TRUNCATE_CHARS)}${props.errorCode ? ` (${props.errorCode})` : ''}`,
  ]
  return lines.join('\n')
}

// TAC-513: the reply told the guest a promise was cancelled and carried no
// cancellation. Draft held, never sent.
//
// Slack-relayed at pilot volume for the reason captureProsePromiseCaught is:
// the question this exists to answer is "does the agent still say things the
// ledger does not do", and at this rate the relay IS the answer.
export interface CancellationClaimUnbackedProps {
  agentRunId: string
  venueId: string
  guestId: string
  category: string | null
  /**
   * The id the model emitted, when it emitted one that did not resolve against
   * this guest's own open commitments. NULL when it emitted nothing at all.
   * The two are worth telling apart: an unresolved id is the model reaching
   * for a commitment that is not there, where an empty field is it not
   * reaching at all.
   */
  unresolvedCommitmentId: string | null
  /**
   * How many commitments the guest actually had open this turn. Separates "the
   * model invented a cancellation" from "the block was empty and it invented
   * one anyway", which have different fixes.
   */
  activeCommitmentCount: number
  /**
   * TRUE when the prose check read the body as claiming a cancellation. FALSE
   * when it did not and the hold came from an emitted id that resolved to
   * nothing.
   *
   * Both queue under the same trigger, and without this they are
   * indistinguishable in the data while having completely different fixes: one
   * is the model writing a cancellation it cannot carry, the other is it
   * reaching for a commitment id on a turn whose text says nothing of the
   * kind.
   *
   * Since the 2026-09-22 split the two also carry different operator copy
   * (`prose_cancellation_backstop` vs `unresolved_cancellation_id`), so this
   * field and the trigger agree by construction. It stays because the trigger
   * says which card an operator saw and this says what the check actually
   * found, and a future change to either should have to break both.
   */
  bodyClaimedIt: boolean
  // The flagged reply. Under 'held' it never sent; under 'sent' the guest
  // has already read a cancellation the ledger does not carry.
  replyBody: string
  disposition: CheckDisposition
}

export async function captureCancellationClaimUnbacked(
  props: CancellationClaimUnbackedProps,
): Promise<void> {
  await capturePostHogEvent('cancellation_claim_unbacked', props.guestId, {
    ...props,
  })
  await postToSlack(formatCancellationClaimUnbacked(props))
}

function formatCancellationClaimUnbacked(
  props: CancellationClaimUnbackedProps,
): string {
  const disposition =
    props.disposition === 'sent'
      ? 'ALREADY SENT (post-send check)'
      : 'held, not sent'
  const lines = [
    props.bodyClaimedIt
      ? `*Reply claimed a cancellation nothing carries* — ${disposition}`
      : `*Reply emitted a cancellation id that resolves to nothing* — ${disposition}. The body does not read as claiming one.`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `category: \`${props.category ?? 'none'}\``,
    `emitted id: ${props.unresolvedCommitmentId === null ? 'none' : `\`${props.unresolvedCommitmentId}\` (did not resolve)`}`,
    `guest had ${props.activeCommitmentCount} open commitment(s)`,
    `held reply: "${truncate(props.replyBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ]
  return lines.join('\n')
}

// TAC-513: a commitment was cancelled because an approved reply said so.
//
// The audit trail for the cancellation, standing in for the cancelled_at /
// cancelled_by columns this ticket deliberately did not add (TAC-299 declined
// them first and nothing since has needed them enough).
export interface CommitmentCancelledProps {
  venueId: string
  guestId: string
  commitmentId: string
  commitmentType: string
  /** The message whose dispatch carried the cancellation. */
  sourceMessageId: string
  /** 'operator_approve' | 'operator_edit' | 'auto_send'. */
  via: string
  /**
   * False when the CAS matched nothing: the row had already left
   * open/pending_ack, or never existed. The guest has been told it is
   * cancelled either way, which is why this is relayed rather than logged.
   */
  transitioned: boolean
}

export async function captureCommitmentCancelled(
  props: CommitmentCancelledProps,
): Promise<void> {
  await capturePostHogEvent('commitment_cancelled', props.guestId, { ...props })
  await postToSlack(formatCommitmentCancelled(props))
}

function formatCommitmentCancelled(props: CommitmentCancelledProps): string {
  const lines = [
    props.transitioned
      ? `*Commitment cancelled* — the reply said so and the ledger followed`
      : `*Commitment NOT cancelled* — the guest was told it was`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `commitment: \`${props.commitmentId}\` (${props.commitmentType})`,
    `message: \`${props.sourceMessageId}\``,
    `via: \`${props.via}\``,
  ]
  return lines.join('\n')
}

// TAC-513: the cancellation-claim check produced no readable verdict. Fails
// CLOSED, so the draft is queued. Mirrors captureProsePromiseCheckUnavailable.
export interface CancellationCheckUnavailableProps {
  agentRunId: string
  venueId: string
  guestId: string
  outcome: 'truncated' | 'errored'
  retried: boolean
  error: string
  errorCode?: string
  disposition: CheckDisposition
}

export async function captureCancellationCheckUnavailable(
  props: CancellationCheckUnavailableProps,
): Promise<void> {
  await capturePostHogEvent('cancellation_check_unavailable', props.guestId, {
    ...props,
  })
  await postToSlack(formatCancellationCheckUnavailable(props))
}

function formatCancellationCheckUnavailable(
  props: CancellationCheckUnavailableProps,
): string {
  const lines = [
    props.disposition === 'sent'
      ? `*Cancellation-claim check did not complete* — no verdict, and the reply was ALREADY SENT (post-send check)`
      : `*Cancellation-claim check did not complete* — failed CLOSED, draft queued`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `outcome: \`${props.outcome}\``,
    `retried: ${props.retried ? 'yes, once' : 'no'}`,
    `error: ${truncate(props.error, SLACK_FIELD_TRUNCATE_CHARS)}${props.errorCode ? ` (${props.errorCode})` : ''}`,
  ]
  return lines.join('\n')
}

// TAC-355: independent mechanic-offer verification backstop caught a reply
// promising an approval-gated mechanic the model didn't self-flag via either
// existing signal (requiresOperatorApproval or commitment.type).
// TAC-363: a reply that would have sent a guest to a closed venue, caught and
// queued. Modelled on captureMechanicOfferBackstopCaught.
//
// `source` is what makes this countable. The two mechanisms answer different
// questions and would otherwise be indistinguishable in the data: 'structured'
// means the model emitted an imminent arrival while the venue's own hours say
// it is shut, and 'text_backstop' means the reply READ as a confirmation with
// no structured field behind it. If the second ever dominates, the structural
// condition is missing the real shape of the failure and should be revisited.
export interface ClosedVenueArrivalCaughtProps {
  agentRunId: string
  venueId: string
  guestId: string
  source: 'structured' | 'text_backstop'
  // The reply that was caught. Under 'held' it queued unblanked (operator-
  // visible anyway); under 'sent' it already reached the guest.
  replyBody: string
  disposition: CheckDisposition
}

export async function captureClosedVenueArrivalCaught(
  props: ClosedVenueArrivalCaughtProps,
): Promise<void> {
  await capturePostHogEvent('closed_venue_arrival_caught', props.guestId, {
    ...props,
  })
  await postToSlack(formatClosedVenueArrivalCaught(props))
}

function formatClosedVenueArrivalCaught(
  props: ClosedVenueArrivalCaughtProps,
): string {
  const lines = [
    props.disposition === 'sent'
      ? `*Arrival confirmed at a closed venue* — reply ALREADY SENT (post-send check)`
      : `*Arrival confirmed at a closed venue* — queued for review`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `caught by: \`${props.source}\``,
    `flagged reply: "${truncate(props.replyBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ]
  return lines.join('\n')
}

export interface MechanicOfferBackstopCaughtProps {
  agentRunId: string
  venueId: string
  guestId: string
  mechanicId: string
  // The reply text that was caught. Under 'held' it queued unblanked (unlike
  // the knowledge-gap backstop); under 'sent' the offer already reached the
  // guest.
  replyBody: string
  disposition: CheckDisposition
}

export async function captureMechanicOfferBackstopCaught(
  props: MechanicOfferBackstopCaughtProps,
): Promise<void> {
  await capturePostHogEvent('mechanic_offer_backstop_caught', props.guestId, {
    ...props,
  })
  await postToSlack(formatMechanicOfferBackstopCaught(props))
}

function formatMechanicOfferBackstopCaught(
  props: MechanicOfferBackstopCaughtProps,
): string {
  const lines = [
    props.disposition === 'sent'
      ? `*Mechanic offer caught without approval* — reply ALREADY SENT (post-send check); the offer is live`
      : `*Mechanic offer caught without approval* — queued for review`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `mechanic: \`${props.mechanicId}\``,
    `flagged reply: "${truncate(props.replyBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ]
  return lines.join('\n')
}

/**
 * Which orchestrator measured the run. `handle-operator-decline` reports
 * `followup` too — its shape and latency profile match the followup path.
 */
export type AgentLatencyKind = 'inbound' | 'followup'

export interface AgentLatencyHighProps {
  agentRunId: string
  venueId: string
  guestId: string
  totalElapsedMs: number
  kind: AgentLatencyKind
  // Threaded through from the orchestrator's success path. inboundBody is
  // null for followups (no inbound). generatedBody is null on failure paths
  // that didn't reach a successful generation.
  inboundBody: string | null
  generatedBody: string | null
}

/**
 * POSTHOG ONLY — NO SLACK RELAY, DELIBERATELY.
 *
 * Latency is a *distribution*, and a per-run threshold is the wrong instrument
 * for it: any single number either fires constantly (the old 10_000 hit 99.3% of
 * inbound turns and Slacked every one) or sits so high it never fires at all.
 * Neither tells you latency got worse.
 *
 * The aggregate question — "did p95 move?" — belongs to a Langfuse threshold
 * alert over a rolling window, which is configured in the Langfuse console, not
 * here. See `lib/observability/CLAUDE.md`.
 *
 * What this event is still good for: per-run forensics. When the aggregate alert
 * fires, this is how you find which runs and which venues. That is worth a
 * PostHog event and is worth nobody's attention in real time.
 *
 * Do not re-add `postToSlack` here without also changing the threshold model.
 */
export async function captureAgentLatencyHigh(
  props: AgentLatencyHighProps,
): Promise<void> {
  await capturePostHogEvent('agent_latency_high', props.guestId, { ...props })
}

// Emitted once per `notify` policy hit on the v2 gate (lib/policy/gate.ts),
// fired by lib/policy/notify.ts. A notify row never changes the verdict — it
// is how a venue learns something happened WITHOUT the draft waiting on a
// human, which is the whole point of `complaint_notifies_owner`.
//
// SLACK RELAY ONLY WHEN THE DRAFT ACTUALLY WENT OUT. When another row queued
// the same turn, the operator card IS the notification and a second ping is
// noise — but the PostHog event still fires on every hit, because a rate
// nobody can count is how comp_regex_backstop became an illusion. Read the
// two apart in analytics on `verdict`.
//
// Scoping note for whoever adds the second notify row: the relay here is
// unconditional on policy key, which is right while the only notify row is
// one the owner explicitly wants pinged about. A chattier row needs the
// per-key scoping captureDemoBypassedApprovalGate uses, not a louder Slack.
export interface PolicyNotificationProps {
  agentRunId: string
  venueId: string
  guestId: string
  /** The notify row that hit, e.g. 'complaint_notifies_owner'. */
  policyKey: string
  /** The row's operator-facing label. */
  label: string
  /** The turn's verdict, decided by the OTHER rows; a notify never moves it. */
  verdict: 'send' | 'queue' | 'block'
  /** Active situations this turn, post-exempt-strip. */
  situations: string[]
  /** P(yes) when the notify row was semantic; absent for structural/always. */
  probability?: number
  inboundBody: string | null
  /** The bubbles as generated, joined for display. */
  generatedBody: string
}

export async function capturePolicyNotification(
  props: PolicyNotificationProps,
): Promise<void> {
  await capturePostHogEvent('policy_notification', props.guestId, { ...props })
  if (props.verdict === 'send') {
    await postToSlack(formatPolicyNotification(props))
  }
}

function formatPolicyNotification(props: PolicyNotificationProps): string {
  const lines = [
    `*${props.label}* — sent without approval \`${props.policyKey}\``,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `situations: ${props.situations.map((s) => `\`${s}\``).join(', ') || '—'}`,
  ]
  if (props.probability !== undefined) {
    lines.push(`p: \`${props.probability.toFixed(3)}\``)
  }
  if (props.inboundBody) {
    lines.push(
      `guest said: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
    )
  }
  lines.push(
    `we replied: "${truncate(props.generatedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  )
  return lines.join('\n')
}

// TAC-212: emitted from the inbound + followup orchestrators when the
// approval-policy gate (applyApprovalPolicyStage in lib/agent/stages.ts)
// routes the draft to the operator queue instead of dispatching. Slack
// relay yes — pilot ops needs visibility into which drafts are landing in
// the queue and why. Mirrors the dash_violation_persisted shape
// (agentRunId + venue/guest IDs + the per-trigger metadata).
export interface DraftQueuedProps {
  agentRunId: string
  venueId: string
  guestId: string
  // Every trigger that fired, in enumeration order. Composes; multiple
  // triggers can fire on one draft.
  triggers: string[]
  // Priority-selected trigger (see PRIMARY_TRIGGER_PRIORITY in stages.ts).
  // Also persisted on messages.review_reason — what the operator sees first
  // in the queue UI.
  primaryTrigger: string
  modelRequiresApproval: boolean
  // Empty string when the model didn't set the flag. We don't bother
  // null-coercing because the model returns "" by contract.
  modelApprovalReason: string
  // Pattern source from matchComp when the comp_regex_backstop trigger
  // fired; null when comp regex didn't match.
  compRegexMatchedPattern: string | null
  // True when previous_pending_held was among the triggers.
  hasPreviousPending: boolean
  // TAC-394: which pending slot the card landed in (migration 041), and
  // whether the guest's OTHER slot already held a card, i.e. whether this is
  // the guest's second card. A literal union rather than an import of
  // PendingSlot, because this module imports nothing from lib/agent.
  slot: 'obligation' | 'conversation'
  otherSlotOccupied: boolean
  // 'inbound' | 'followup' — distinguishes which orchestrator queued.
  kind: 'inbound' | 'followup'
  category: string
  inboundBody: string | null
  generatedBody: string
}

export async function captureDraftQueued(
  props: DraftQueuedProps,
): Promise<void> {
  await capturePostHogEvent('draft_queued', props.guestId, { ...props })
  await postToSlack(formatDraftQueued(props))
}

function formatDraftQueued(props: DraftQueuedProps): string {
  const triggerList = props.triggers.map((t) => `\`${t}\``).join(', ')
  const lines = [
    `*Draft queued for review* — primary trigger \`${props.primaryTrigger}\` (all: ${triggerList}, ${props.kind})`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `category: \`${props.category}\``,
    `slot: \`${props.slot}\`${props.otherSlotOccupied ? ' · second card for this guest' : ''}`,
  ]
  if (props.modelRequiresApproval && props.modelApprovalReason.length > 0) {
    lines.push(
      `model approval reason: "${truncate(props.modelApprovalReason, SLACK_FIELD_TRUNCATE_CHARS)}"`,
    )
  }
  if (props.compRegexMatchedPattern) {
    lines.push(`comp regex matched: \`${props.compRegexMatchedPattern}\``)
  }
  if (props.inboundBody) {
    lines.push(
      `inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
    )
  }
  lines.push(
    `draft: "${truncate(props.generatedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  )
  return lines.join('\n')
}

// TAC-264: emitted from the inbound + followup orchestrators when the
// approval-policy gate decides queue AND an existing pending draft was
// found, so the persist layer regenerates the row in place rather than
// inserting a new one. Distinct event from draft_queued so the funnel can
// distinguish "new card arrived" from "existing card refreshed against new
// guest context" — operator's mental model is one card per guest, the
// regen path is what keeps that promise. Slack relay yes for symmetry with
// captureDraftQueued (pilot ops needs visibility into both paths).
//
// originalDraftId: the messages.id that was UPDATEd in place. Same row the
// operator queue is already showing — analytics joins back to it.
// priorReviewReason: the value of messages.review_reason BEFORE the
// regen overwrite. Surfaces trigger evolution (e.g. comp_regex_backstop
// → model_flagged across regens on the same card).
export interface DraftRegeneratedProps {
  agentRunId: string
  venueId: string
  guestId: string
  originalDraftId: string
  triggers: string[]
  primaryTrigger: string
  priorReviewReason: string | null
  modelRequiresApproval: boolean
  modelApprovalReason: string
  compRegexMatchedPattern: string | null
  kind: 'inbound' | 'followup'
  category: string
  inboundBody: string | null
  generatedBody: string
}

export async function captureDraftRegenerated(
  props: DraftRegeneratedProps,
): Promise<void> {
  await capturePostHogEvent('draft_regenerated', props.guestId, { ...props })
  await postToSlack(formatDraftRegenerated(props))
}

function formatDraftRegenerated(props: DraftRegeneratedProps): string {
  const triggerList = props.triggers.map((t) => `\`${t}\``).join(', ')
  const transition =
    props.priorReviewReason && props.priorReviewReason !== props.primaryTrigger
      ? ` (was \`${props.priorReviewReason}\`)`
      : ''
  const lines = [
    `*Pending draft regenerated* — primary trigger \`${props.primaryTrigger}\`${transition} (all: ${triggerList}, ${props.kind})`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `draft: \`${props.originalDraftId}\``,
    `category: \`${props.category}\``,
  ]
  if (props.modelRequiresApproval && props.modelApprovalReason.length > 0) {
    lines.push(
      `model approval reason: "${truncate(props.modelApprovalReason, SLACK_FIELD_TRUNCATE_CHARS)}"`,
    )
  }
  if (props.compRegexMatchedPattern) {
    lines.push(`comp regex matched: \`${props.compRegexMatchedPattern}\``)
  }
  if (props.inboundBody) {
    lines.push(
      `inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
    )
  }
  lines.push(
    `draft: "${truncate(props.generatedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  )
  return lines.join('\n')
}

// TAC-284: emitted from applyApprovalPolicyStage (lib/agent/stages.ts) when a
// guest flagged is_demo=true bypasses the TAC-212 approval policy gate. Only
// fires when the bypass actually overrode a queue decision — a clean demo
// reply that would have auto-sent anyway produces no event.
//
// Slack relay is CONDITIONAL (TAC-284 risk-1 decision): only when
// 'comp_regex_backstop' is among the would-have-queued triggers. The comp
// backstop exists to catch irreversible financial commitments; demo mode
// disabling it should be loud in Slack. Model-flagged-only bypasses stay
// PostHog-only so Slack doesn't drown in routine demo traffic.
//
// TAC-307 adds a SECOND relay condition: an approval hold a human explicitly
// chose for this venue (a ticked category, or the master switch) that the
// demo flag then overrode. Demo guests deliberately stay exempt from approval
// policy — they're a teammate's own phone — but "the switch you flipped did
// not apply here" is exactly the kind of silent divergence this repo has been
// bitten by before, so it gets said out loud. Deliberately gated on
// `policyHoldWasExplicit`: the fleet-wide comp_complaint code default is on
// every venue and would relay constantly without anyone having chosen it.
export interface DemoBypassedApprovalGateProps {
  agentRunId: string
  venueId: string
  guestId: string
  // The triggers that WOULD have queued this draft were the guest not
  // flagged is_demo. Non-empty by construction — the caller only fires the
  // event when at least one trigger fired. Values are APPROVAL_TRIGGERS
  // codes from lib/agent/stages.ts.
  wouldHaveQueuedTriggers: string[]
  generatedBody: string
  // TAC-307. True when CATEGORY_REQUIRES_APPROVAL fired from a policy entry a
  // human set for this venue, rather than from the fleet-wide code default.
  // Drives the second Slack relay condition above. Optional so existing
  // callers are unaffected; absent reads as "not explicit".
  policyHoldWasExplicit?: boolean
}

// Literal kept in sync with APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP in
// lib/agent/stages.ts. Not imported: posthog.ts is a leaf module (see the
// dependency-direction note at the top) — importing from lib/agent would
// reverse the direction and create a cycle (stages.ts imports this file).
const COMP_REGEX_BACKSTOP_TRIGGER = 'comp_regex_backstop'

// Same kept-in-sync-by-hand rule as the line above, for the same
// dependency-direction reason. Mirrors APPROVAL_TRIGGERS.CATEGORY_REQUIRES_APPROVAL.
const CATEGORY_REQUIRES_APPROVAL_TRIGGER = 'category_requires_approval'

export async function captureDemoBypassedApprovalGate(
  props: DemoBypassedApprovalGateProps,
): Promise<void> {
  await capturePostHogEvent('demo_bypassed_approval_gate', props.guestId, {
    ...props,
  })
  const compBackstopBypassed = props.wouldHaveQueuedTriggers.includes(
    COMP_REGEX_BACKSTOP_TRIGGER,
  )
  const explicitPolicyBypassed =
    props.policyHoldWasExplicit === true &&
    props.wouldHaveQueuedTriggers.includes(CATEGORY_REQUIRES_APPROVAL_TRIGGER)
  if (compBackstopBypassed || explicitPolicyBypassed) {
    await postToSlack(
      formatDemoBypassedApprovalGate(props, { compBackstopBypassed }),
    )
  }
}

function formatDemoBypassedApprovalGate(
  props: DemoBypassedApprovalGateProps,
  opts: { compBackstopBypassed: boolean },
): string {
  const triggerList = props.wouldHaveQueuedTriggers
    .map((t) => `\`${t}\``)
    .join(', ')
  const cause = opts.compBackstopBypassed
    ? 'comp regex backstop would have queued this draft'
    : "this venue's explicit approval policy would have queued this draft"
  return [
    `*Demo guest bypassed approval gate* — ${cause}`,
    `would-have-queued triggers: ${triggerList}`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `generated: "${truncate(props.generatedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ].join('\n')
}

export interface WebhookSilenceProps {
  hoursWithoutWebhook: number
  lastWebhookAt: string
}

export async function captureWebhookSilence(
  props: WebhookSilenceProps,
): Promise<void> {
  // No guestId/venueId — system-level event. Use a stable distinctId so
  // aggregation in PostHog works.
  await capturePostHogEvent('webhook_silence', 'system:webhook-silence-cron', {
    ...props,
  })
  await postToSlack(formatWebhookSilence(props))
}

function formatWebhookSilence(props: WebhookSilenceProps): string {
  return [
    `*Webhook silence* — ${props.hoursWithoutWebhook} hours since last non-test inbound`,
    `last webhook: \`${props.lastWebhookAt}\``,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Follow-up engine events (TAC-123)
// ---------------------------------------------------------------------------
//
// Fired by lib/followups/engine.ts. Two events:
//
//   - `followup_suppressed` — fires per-guest when canSendFollowup (Gate 1)
//     blocks a run. PostHog + Slack so pilot ops can see which guests are
//     being held back and why (an unexpected spike in opted_out or
//     weekly_cap is operationally interesting).
//
//   - `followup_scan_complete` — fires once per processor run (all
//     dispatching venues aggregated). Includes per-venue breakdown so
//     dashboards keep venue-level granularity. PostHog only — operational
//     summary, no Slack noise.
//
// Reasons are the FollowupReason render enum strings (`post_visit_day_7`,
// `cold_lapsed`, `perk_unlock`); typed as `string[]` here to avoid
// importing from lib/schemas (this module is a leaf — see dependency-
// direction note at top).

export interface FollowupSuppressedProps {
  venueId: string
  guestId: string
  /** Reasons the detector returned for this guest's tick. */
  wouldHaveDispatchedReasons: readonly string[]
  /** Which suppression branch fired (opt-out / quiet hours / etc.). */
  suppressionReason: string
}

export async function captureFollowupSuppressed(
  props: FollowupSuppressedProps,
): Promise<void> {
  await capturePostHogEvent('followup_suppressed', props.guestId, { ...props })
  await postToSlack(formatFollowupSuppressed(props))
}

function formatFollowupSuppressed(props: FollowupSuppressedProps): string {
  const reasonList = props.wouldHaveDispatchedReasons
    .map((r) => `\`${r}\``)
    .join(', ')
  return [
    `*Follow-up suppressed* — \`${props.suppressionReason}\` blocked: ${reasonList || '(no reasons)'}`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
  ].join('\n')
}

/**
 * A follow-up that was RECORDED as a task for a human rather than sent
 * (TAC-469 PR B). Instagram only today: a scheduled follow-up never auto-sends
 * there, because the 24-hour reply window is usually shut when one fires and
 * nothing reopens it but the guest.
 *
 * Slack-relayed deliberately. Until TAC-486 builds the card surface these rows
 * have NO operator-facing surface at all, so the relay is the only way anyone
 * learns the venue owed a guest a touch. That is also the signal to watch: a
 * steady drip here is the backlog TAC-486 inherits.
 *
 * Carries no message body — there is no draft. TAC-486 generates the text when
 * it creates the card, so a day-3 line written now cannot be read on day 9.
 */
export interface FollowupManualTaskRecordedProps {
  venueId: string
  guestId: string
  /** Every reason this task covers, the render enum strings. */
  reasons: readonly string[]
  /** The highest-priority reason, or null when none survived the filter. */
  primaryReason: string | null
  /** The followup_log rows marked, which is what TAC-486 reads. */
  followupLogIds: readonly string[]
  channel: string
}

export async function captureFollowupManualTaskRecorded(
  props: FollowupManualTaskRecordedProps,
): Promise<void> {
  await capturePostHogEvent('followup_manual_task_recorded', props.guestId, {
    ...props,
  })
  await postToSlack(formatFollowupManualTaskRecorded(props))
}

function formatFollowupManualTaskRecorded(
  props: FollowupManualTaskRecordedProps,
): string {
  const reasonList = props.reasons.map((r) => `\`${r}\``).join(', ')
  return [
    `*Follow-up recorded as a task* — ${props.channel} cannot be sent to on a schedule, so a human has to send this one.`,
    `reasons: ${reasonList || '(none)'}`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `followup_log: ${props.followupLogIds.map((id) => `\`${id}\``).join(', ') || '(none)'}`,
  ].join('\n')
}

export interface FollowupVenueBreakdown {
  venueId: string
  guestsEvaluated: number
  guestsDue: number
  /**
   * TAC-529: due, but this venue cannot reach them on the channel they
   * resolve to (a phone guest at a venue with no number). Per venue, because
   * the cause is a venue-level misconfiguration even though the count is per
   * guest.
   */
  guestsUnservable: number
  /** Recorded as tasks rather than sent (TAC-469). */
  guestsTasked: number
  guestsDispatched: number
  guestsSuppressed: number
  guestsConflicted: number
  guestsDispatchFailed: number
}

export interface FollowupScanCompleteProps {
  /** ISO timestamp at the start of the processor tick. */
  now: string
  summary: {
    venuesScanned: number
    /** TAC-529: skipped because `venues.status` is paused or archived. */
    venuesHalted: number
    /** TAC-529: skipped because the venue has neither a phone nor Instagram. */
    venuesNoChannel: number
    venuesDispatching: number
    /** TAC-529: guests this venue cannot reach. See FollowupVenueBreakdown. */
    guestsUnservable: number
    guestsEvaluated: number
    guestsDue: number
    guestsDispatched: number
    guestsTasked: number
    guestsSuppressed: number
    suppressedBy: Record<string, number>
    guestsConflicted: number
    guestsDispatchFailed: number
  }
  perVenue: readonly FollowupVenueBreakdown[]
}

export async function captureFollowupScanComplete(
  props: FollowupScanCompleteProps,
): Promise<void> {
  // No guestId — system-level event. Stable distinctId so dashboards can
  // chart the daily processor run as a single series.
  await capturePostHogEvent(
    'followup_scan_complete',
    'system:followup-engine',
    { ...props },
  )
}

// ---------------------------------------------------------------------------
// Operator approval queue events (TAC-258)
// ---------------------------------------------------------------------------
//
// Fired from the operator API endpoints. Unlike the agent-runtime events
// above, these are product-analytics signals (operator behaviour: how often
// drafts are approved vs edited vs skipped, average time-to-action, undo
// rates), NOT operational red alerts. They do not post to Slack — analysts
// consume them in PostHog.
//
// Payload shape per the operator-side precedent (voices-commit /
// voice_critique_committed): IDs + small scalars, never full bodies. Bodies
// live on the row (messages.body, response_review.editedMessage,
// response_review.originalAiBody) and Langfuse trace; analysts join by
// messageId when needed.

export interface OperatorMessageApprovedProps {
  venueId: string
  guestId: string
  messageId: string
  operatorId: string
  /** now() - messages.created_at — how long the draft sat in queue. */
  timeToActionMs: number
  voiceFidelity: number | null
  category: string | null
  recognitionState: string | null
}

export async function captureOperatorMessageApproved(
  props: OperatorMessageApprovedProps,
): Promise<void> {
  await capturePostHogEvent('operator_message_approved', props.guestId, {
    ...props,
  })
}

export interface OperatorMessageEditedProps {
  venueId: string
  guestId: string
  messageId: string
  operatorId: string
  timeToActionMs: number
  voiceFidelity: number | null
  category: string | null
  recognitionState: string | null
  /** source_ref written to voice_corpus by the edit path (operator-approve:{messageId}). */
  corpusSourceRef: string
  /** Length of the AI draft (messages.body before the edit). */
  bodyLengthBefore: number
  /** Length of the operator's final text. */
  bodyLengthAfter: number
  /** ((after - before) / before) * 100, rounded to integer. 0 when before === 0. */
  bodyLengthDeltaPct: number
}

export async function captureOperatorMessageEdited(
  props: OperatorMessageEditedProps,
): Promise<void> {
  await capturePostHogEvent('operator_message_edited', props.guestId, {
    ...props,
  })
}

export interface OperatorMessageSkippedProps {
  venueId: string
  guestId: string
  messageId: string
  operatorId: string
  timeToActionMs: number
  voiceFidelity: number | null
  category: string | null
  recognitionState: string | null
}

export async function captureOperatorMessageSkipped(
  props: OperatorMessageSkippedProps,
): Promise<void> {
  await capturePostHogEvent('operator_message_skipped', props.guestId, {
    ...props,
  })
}

export interface OperatorMessageActionUndoneProps {
  venueId: string
  guestId: string
  messageId: string
  operatorId: string
  /** Action being undone. */
  undoneActionType: 'approved' | 'edited' | 'skipped'
  /**
   * True iff the action had already triggered a Sendblue dispatch (approve /
   * edit). In that case undo does NOT retract the send; state stays as-is
   * and only this analytics event fires. False for skipped→pending revert,
   * which is the only truly revertible case in v1.
   */
  undoneAfterDispatch: boolean
  /** now() - last_operator_action_at — how fast the undo arrived. */
  timeSinceActionMs: number
}

export async function captureOperatorMessageActionUndone(
  props: OperatorMessageActionUndoneProps,
): Promise<void> {
  await capturePostHogEvent('operator_message_action_undone', props.guestId, {
    ...props,
  })
}

// TAC-297: operator acknowledged a pending_ack commitment via the operator
// app's swipe-right. Mirrors the operator_message_* event shape — IDs +
// small scalars, no bodies. Distinct event name + commitmentId scalar so
// analysts can split commitment acks from draft approvals cleanly. Slack
// relay omitted (matches the draft-action analytics — product, not ops).
export interface OperatorCommitmentAcknowledgedProps {
  venueId: string
  guestId: string
  commitmentId: string
  operatorId: string
  /** now() - guest_commitments.created_at — how long the commitment sat. */
  timeToActionMs: number
  /** Commitment type at the time of ack (comp/hold/discount/recommendation). */
  type: string
}

export async function captureOperatorCommitmentAcknowledged(
  props: OperatorCommitmentAcknowledgedProps,
): Promise<void> {
  await capturePostHogEvent('operator_commitment_acknowledged', props.guestId, {
    ...props,
  })
}

/**
 * TAC-299 — operator swiped left on a heads-up card, triggering an
 * agent-drafted decline. Carries IDs only (mirrors the TAC-258 + TAC-297
 * operator events). messageId is the pending draft the route returned;
 * the body lives on the row + Langfuse so we don't duplicate. No Slack
 * relay — product analytics, not operational.
 */
export interface OperatorDraftDeclineInitiatedProps {
  venueId: string
  guestId: string
  commitmentId: string
  messageId: string
  operatorId: string
  /** Commitment type at the time of decline (comp/hold/discount/recommendation). */
  type: string
  /** now() - guest_commitments.created_at — how long the commitment sat. */
  timeToActionMs: number
  /** True when markCancelled CAS lost the race (concurrent ack); the draft
   * is still persisted, the commitment is not at status='cancelled'. */
  commitmentCancellationRaceLost: boolean
}

export async function captureOperatorDraftDeclineInitiated(
  props: OperatorDraftDeclineInitiatedProps,
): Promise<void> {
  await capturePostHogEvent('operator_draft_decline_initiated', props.guestId, {
    ...props,
  })
}

// ---------------------------------------------------------------------------
// APNs push events (TAC-207)
// ---------------------------------------------------------------------------
//
// Two events, asymmetric on Slack relay:
//   push.sent — fires on every send attempt (success OR transport failure).
//               ok:boolean carries the binary. No Slack relay: this is
//               product analytics, not operational. Spikes in ok=false
//               surface in PostHog dashboards.
//   push.token_invalid — fires when APNs returns 410 Gone or 400 +
//               reason=BadDeviceToken (the two ways APNs says "this device
//               token is dead"). The orchestrator has already nulled the
//               operator's token columns by the time the event fires; this
//               event is the breadcrumb. Slack-relays because the operator's
//               push pipeline is now non-functional until they reinstall.
//
// Distinct ID is the operator (not the guest) — push events are about the
// operator surface, not the guest conversation. Aggregations roll up cleanly
// by operator that way.

export interface PushSentProps {
  /** Null when fired from the cron (no agent run). String when fired from the
   * inbound CAS-win path or the draft-flagged path. */
  agentRunId: string | null
  venueId: string
  guestId: string
  operatorId: string
  /** messages.id for the draft-flagged surface; guest_commitments.id for the
   * commitment-arrival surface. The column name stays `draftId` for backward
   * compatibility with the existing draft-flagged dashboard panels.
   * TAC-297. */
  draftId: string
  /** approval.primaryTrigger for the draft-flagged surface; the literal
   * 'commitment_arrival' for the commitment surface. */
  primaryTrigger: string
  /** True iff APNs returned 200. False on any non-200 OR transport failure. */
  ok: boolean
  /** HTTP status from APNs, or null on transport-level failure (no response). */
  status: number | null
  /** Short error code on failure (jwt_failed / connection_failed / timeout / apns_status_non_200). Null on ok. */
  error: string | null
  /** APNs `reason` string from non-200 bodies, or transport error detail. Null on ok. */
  errorDetail: string | null
  /** Badge count carried in the payload. */
  badge: number
  /** TAC-297: discriminator so the two push surfaces can be analyzed
   * separately in PostHog. Optional + defaults to 'draft_flagged' so the
   * existing TAC-207 callsite doesn't have to pass it. */
  surface?: 'draft_flagged' | 'commitment_arrival' | 'instagram_window_warning'
}

export async function capturePushSent(props: PushSentProps): Promise<void> {
  await capturePostHogEvent('push.sent', props.operatorId, {
    ...props,
    surface: props.surface ?? 'draft_flagged',
  })
}

export interface PushTokenInvalidProps {
  /** Null when fired from the cron (no agent run). String otherwise. */
  agentRunId: string | null
  venueId: string
  guestId: string
  operatorId: string
  draftId: string
  primaryTrigger: string
  /** 410 (Unregistered) or 400 (BadDeviceToken). */
  status: number
  /** APNs `reason` field. Null on 410 with empty body. */
  reason: string | null
  /** TAC-297: same discriminator semantics as PushSentProps.surface. */
  surface?: 'draft_flagged' | 'commitment_arrival' | 'instagram_window_warning'
}

export async function capturePushTokenInvalid(
  props: PushTokenInvalidProps,
): Promise<void> {
  await capturePostHogEvent('push.token_invalid', props.operatorId, {
    ...props,
    surface: props.surface ?? 'draft_flagged',
  })
  await postToSlack(formatPushTokenInvalid(props))
}

function formatPushTokenInvalid(props: PushTokenInvalidProps): string {
  const surface = props.surface ?? 'draft_flagged'
  const idLabel = surface === 'commitment_arrival' ? 'commitment' : 'draft'
  return [
    `*APNs push token invalid* — status \`${props.status}\`${props.reason ? ` reason \`${props.reason}\`` : ''}${surface !== 'draft_flagged' ? ` · surface \`${surface}\`` : ''}`,
    `operator: \`${props.operatorId}\` (token nulled; operator must re-register via the operator app)`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `${idLabel}: \`${props.draftId}\` · trigger: \`${props.primaryTrigger}\``,
    `run: \`${props.agentRunId ?? '(cron)'}\``,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// TAC-308 / TAC-394: a generated draft was discarded to protect a pending card
// ---------------------------------------------------------------------------

/** A commitment as the drop alert names it. */
export interface DroppedDraftCommitment {
  type: string
  description: string
  code: string | null
}

export type DraftDropReason =
  'knowledge_gap_card_protected' | 'obligation_slot_taken' | 'slot_occupied'

export interface DraftDroppedProps {
  agentRunId: string
  venueId: string
  guestId: string
  /**
   * TAC-394: the guest as an operator finds them in the app. The 2026-09-14
   * ruling asked for the alert to name the guest, not just an id: the one
   * production instance of two overlapping obligations (2026-08-07) happened
   * during an incident, and whoever reads this may be reading it mid-incident.
   */
  guestFirstName: string | null
  /**
   * The full number, for formatting only. It never leaves this module whole:
   * PostHog and Slack both get the last four digits.
   */
  guestPhone: string | null
  /** Why the draft had nowhere to go. See SlotDropReason in lib/agent/pending-slots.ts. */
  reason: DraftDropReason
  /** messages.id of the pending card that kept its slot. */
  protectedDraftId: string
  /** That card's commitment carrier, or null when it carries none. */
  protectedCommitment: DroppedDraftCommitment | null
  /** The discarded draft's commitment, or null when it carried none. */
  droppedCommitment: DroppedDraftCommitment | null
  /** The triggers that would have queued the discarded draft. */
  triggers: string[]
  kind: 'inbound' | 'followup'
  category: string | null
  droppedBody: string
}

/**
 * Fires when a draft is discarded because a pending card holds its slot:
 * TAC-308's knowledge-gap card protection, or TAC-394's obligation slot.
 *
 * SLACK-RELAYED, unlike most product analytics, and the reason matters: this
 * is the one path where a guest says something and receives nothing while no
 * operator is told anything new. The sharpest TAC-308 case is a complaint (the
 * clarifying turn auto-sends, then the resolving draft trips
 * category_requires_approval and is dropped). The sharpest TAC-394 case is a
 * second offer while a first is still pending, which is rare and correlated
 * with things already going wrong, so the alert says exactly which two offers
 * and which guest.
 *
 * `slot_occupied` has copy too, but the followup orchestrator records a
 * refused manual followup with captureManualFollowupSlotOccupied instead: the
 * operator who clicked is told directly, so Slack would tell them twice.
 */
export async function captureDraftDropped(
  props: DraftDroppedProps,
): Promise<void> {
  const { guestPhone, ...rest } = props
  await capturePostHogEvent('draft_dropped', props.guestId, {
    ...rest,
    guestPhoneLast4: phoneLast4(guestPhone),
  })
  await postToSlack(formatDraftDropped(props))
}

export function formatDraftDropped(props: DraftDroppedProps): string {
  const last4 = phoneLast4(props.guestPhone)
  const guest = `guest: ${props.guestFirstName ?? 'unnamed guest'}${
    last4 ? `, phone ending ${last4}` : ''
  } (\`${props.guestId}\`)`
  const context = [
    `venue: \`${props.venueId}\``,
    `run: \`${props.agentRunId}\``,
    `category: \`${props.category ?? 'null'}\``,
    `would-have-queued: ${props.triggers.map((t) => `\`${t}\``).join(', ')}`,
    `discarded draft: ${truncate(props.droppedBody, 300)}`,
  ]
  switch (props.reason) {
    case 'obligation_slot_taken':
      return [
        `*Draft dropped: this guest already has a different offer waiting* (${props.kind})`,
        guest,
        `kept, pending card \`${props.protectedDraftId}\`: ${describeDroppedCommitment(props.protectedCommitment)}`,
        `dropped, never saved: ${describeDroppedCommitment(props.droppedCommitment)}`,
        ...context,
        `_The guest got no reply to their last message. The pending card is untouched. Decide it, then follow up if the guest is owed the second offer too._`,
      ].join('\n')
    case 'slot_occupied':
      return [
        `*Follow-up refused: a card for this guest is already waiting* (${props.kind})`,
        guest,
        `waiting card \`${props.protectedDraftId}\`: ${describeDroppedCommitment(props.protectedCommitment)}`,
        ...context,
        `_Nothing was sent or saved. Decide the waiting card, then send the follow-up again._`,
      ].join('\n')
    case 'knowledge_gap_card_protected':
      return [
        `*Draft dropped to protect a knowledge-gap card* (${props.kind})`,
        guest,
        `protected card: \`${props.protectedDraftId}\``,
        ...context,
        `_The guest received nothing on this turn. Answering the pending card releases the guest's slot._`,
      ].join('\n')
  }
}

function describeDroppedCommitment(c: DroppedDraftCommitment | null): string {
  if (c === null) return 'no commitment'
  return `${c.type} "${truncate(c.description, 120)}" (${c.code ? `code ${c.code}` : 'no code'})`
}

/** TAC-394: the last four digits of a phone number, for alerts that name a guest. */
export function phoneLast4(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : null
}

// ---------------------------------------------------------------------------
// TAC-394: a manual followup refused to overwrite a pending card
// ---------------------------------------------------------------------------

export interface ManualFollowupSlotOccupiedProps {
  agentRunId: string
  venueId: string
  guestId: string
  /** messages.id of the card holding the slot the followup would have used. */
  waitingDraftId: string
  triggers: string[]
}

/**
 * Fires when a Command Center Follow Up click would have queued into a slot a
 * pending card already holds, and was refused instead of regenerating over it.
 * TAC-307 kept manual followups away from regenerate-in-place; TAC-394 closed
 * the race path that got round that and made the refusal explicit.
 *
 * PostHog only, never silent: the orchestrator also logs it, and the route
 * tells the operator who clicked in plain words. A Slack alert on top would
 * tell the same person twice.
 */
export async function captureManualFollowupSlotOccupied(
  props: ManualFollowupSlotOccupiedProps,
): Promise<void> {
  await capturePostHogEvent('manual_followup_slot_occupied', props.guestId, {
    ...props,
  })
}

// ---------------------------------------------------------------------------
// TAC-394: a pending slot held more than one row
// ---------------------------------------------------------------------------

export interface PendingSlotInvariantBrokenProps {
  venueId: string
  guestId: string
  keptObligationId: string | null
  keptConversationId: string | null
  /** The rows loadPendingRowsBySlot did not return. */
  extraIds: string[]
}

/**
 * Fires when loadPendingRowsBySlot finds more than one pending row in a slot.
 * Unreachable while migration 041's indexes are live, which is why it
 * Slack-relays: it is the one signal that they are gone.
 */
export async function capturePendingSlotInvariantBroken(
  props: PendingSlotInvariantBrokenProps,
): Promise<void> {
  await capturePostHogEvent('pending_slot_invariant_broken', props.guestId, {
    ...props,
  })
  await postToSlack(
    [
      '*Pending-slot invariant broken: a guest has two pending cards in one slot*',
      `venue: \`${props.venueId}\``,
      `guest: \`${props.guestId}\``,
      `kept: obligation \`${props.keptObligationId ?? 'none'}\`, conversation \`${props.keptConversationId ?? 'none'}\``,
      `not read: ${props.extraIds.map((id) => `\`${id}\``).join(', ')}`,
      "_Migration 041's indexes may be missing. Check pg_indexes on messages first._",
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// TAC-309: a generation attempt was cut off at the output-token ceiling
// ---------------------------------------------------------------------------

export interface GenerationTruncatedProps {
  attempts: number
  maxOutputTokens: number
  promptVersion: string
  /** Head of the truncated raw text. Diagnostic only; never guest-facing. */
  truncatedTextPreview: string | null
}

/**
 * Fires when `generateObject` failed with `finishReason: 'length'` — the model
 * ran out of output budget and the JSON was cut mid-object.
 *
 * SLACK-RELAYED, because this is a ceiling we control rather than a model
 * misbehaving, and because the generic "could not parse the response" error
 * makes the two look identical. The 2026-08-08 occurrence cost a UAT session
 * to identify and required reading Langfuse latencies against a throughput
 * estimate to infer. It should announce itself next time.
 *
 * If this fires repeatedly, the fix is MAX_OUTPUT_TOKENS or a shorter
 * `reasoning`, not a retry — a retry re-runs into the same wall.
 */
export async function captureGenerationTruncated(
  props: GenerationTruncatedProps,
): Promise<void> {
  await capturePostHogEvent('generation_truncated', 'system', { ...props })
  await postToSlack(
    [
      '*Generation truncated at the output-token ceiling*',
      `attempts: \`${props.attempts}\` · cap: \`${props.maxOutputTokens}\` · prompt: \`${props.promptVersion}\``,
      'The emission hit the cap and was cut mid-JSON, so the whole object failed to parse.',
      'Fix the ceiling or shorten `reasoning` — a retry hits the same wall.',
      props.truncatedTextPreview
        ? `truncated head: ${truncate(props.truncatedTextPreview, 300)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

// ---------------------------------------------------------------------------
// TAC-348: a crisis-safety reply was sent (self-harm / medical-emergency
// signal, fixed hardcoded body, bypasses generation and the approval gate
// entirely — see lib/agent/crisis-safety.ts and handle-inbound.ts).
// ---------------------------------------------------------------------------

export interface CrisisSafetyReplySentProps {
  agentRunId: string
  venueId: string
  guestId: string
  outboundMessageId: string
  /** The classifier's category call on this turn — unrelated to the crisis
   * flag itself, kept for observability (e.g. a comp_complaint that also
   * tripped crisisSafety). */
  category: string
}

/**
 * PostHog-only, no Slack relay (owner decision, TAC-348 plan review: "no
 * separate mechanism" beyond the standard event). The reply itself is fixed
 * and unconditional — this event is audit/count visibility, not an alert.
 */
export async function captureCrisisSafetyReplySent(
  props: CrisisSafetyReplySentProps,
): Promise<void> {
  await capturePostHogEvent('crisis_safety_reply_sent', props.guestId, {
    ...props,
  })
}

// ---------------------------------------------------------------------------
// TAC-318: a commitment was deduped against an already-open row
// ---------------------------------------------------------------------------

export interface CommitmentDedupedProps {
  venueId: string
  guestId: string
  /** The row we resolved to. */
  existingCommitmentId: string
  existingType: string
  /** The type the agent just emitted. Differs from existingType on an upgrade. */
  incomingType: string
  /** The message that carried the duplicate emission. */
  sourceMessageId: string
  /**
   * How we got here. 'app_check' is the primary path (the read found it before
   * we tried to insert); '23505' means the app check missed and the unique
   * index caught it, which is the TOCTOU race and is worth being able to count
   * separately.
   */
  via: 'app_check' | '23505'
  /** True when a recommendation was upgraded in place to a gated type. */
  upgraded: boolean
}

/**
 * Fires whenever a repeat promise resolves to an existing open commitment.
 *
 * This exists because TAC-318's entire premise was a MEASURED duplication rate
 * ("a clean 2x"), and without an event the fix's effect is visible only in
 * ephemeral Vercel logs — the exact "gate whose true-positive history you
 * cannot produce on demand" that CLAUDE.md warns against.
 *
 * Slack-relays ONLY on an upgrade or a type mismatch. A plain same-type dedup
 * is the expected steady state on every repeated recommendation and would be
 * pure noise; a type change means the ledger row's identity moved and someone
 * may want to look.
 */
export async function captureCommitmentDeduped(
  props: CommitmentDedupedProps,
): Promise<void> {
  await capturePostHogEvent('commitment_deduped', props.guestId, { ...props })
  if (props.existingType === props.incomingType) return
  await postToSlack(
    [
      props.upgraded
        ? `*Open commitment upgraded in place* (${props.existingType} → ${props.incomingType})`
        : `*Commitment deduped across types* (kept \`${props.existingType}\`, dropped \`${props.incomingType}\`)`,
      `venue: \`${props.venueId}\``,
      `guest: \`${props.guestId}\``,
      `commitment: \`${props.existingCommitmentId}\``,
      `source message: \`${props.sourceMessageId}\``,
      `via: \`${props.via}\``,
      props.upgraded
        ? `_The guest keeps one live promise, now carrying the gated type's verification code._`
        : `_The incoming promise was NOT recorded separately — guest_commitments_open_dedup permits one open row per description._`,
    ].join('\n'),
  )
}

/**
 * TAC-318: the dedup read failed, so the app-level check did not run for this
 * write and the unique index is the only thing standing between us and a
 * duplicate.
 *
 * Relays because the primary enforcement being inert is exactly the condition
 * that is otherwise invisible — the table keeps looking correct while the
 * check does nothing.
 */
export async function captureCommitmentDedupCheckFailed(props: {
  venueId: string
  guestId: string
  sourceMessageId: string
  error: string
}): Promise<void> {
  await capturePostHogEvent('commitment_dedup_check_failed', props.guestId, {
    ...props,
  })
  await postToSlack(
    [
      '*Commitment dedup check failed — proceeding to insert*',
      `venue: \`${props.venueId}\``,
      `guest: \`${props.guestId}\``,
      `source message: \`${props.sourceMessageId}\``,
      `error: ${truncate(props.error, 300)}`,
      '_Fail-open by design. guest_commitments_open_dedup is the backstop; if this is sustained, the app-level check is inert._',
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// TAC-341 — commitment lifecycle: escalation + expiry
// ---------------------------------------------------------------------------

export type CommitmentEscalationReason =
  /** A comp or discount has sat open past COMP_ESCALATION_DAYS. */
  | 'aging_obligation'
  /** A hold is approaching close and is still unclaimed. */
  | 'hold_nearing_close'
  /**
   * A hold's horizon is a guess: venue hours were unreadable, the venue is
   * recorded closed that day, or the timezone was missing. Stamped at
   * creation, because that is the only moment the fallback is knowable.
   */
  | 'hold_horizon_unknown'
  /**
   * The row reached its horizon having never surfaced. Should be rare — it
   * means the lifecycle cron missed the whole escalation window — and it is
   * the case the "never silently expired" guarantee exists for.
   */
  | 'expiring_unsurfaced'

export interface CommitmentEscalatedProps {
  venueId: string
  guestId: string
  commitmentId: string
  type: string
  reason: CommitmentEscalationReason
  /** ISO. Null only in the degenerate case where no horizon could be built. */
  expiresAt: string | null
  createdAt: string
  /** Whole days the obligation has been open at the moment of escalation. */
  ageDays: number
}

/**
 * An obligation has been surfaced to a human for the first time.
 *
 * SLACK-RELAYED, unlike its expiry sibling — surfacing IS the point of
 * escalation, and an escalation nobody sees is the whole defect this ticket
 * exists to close. Fires at most once per commitment: markEscalated's CAS on
 * `escalated_at IS NULL` is what guarantees that, not this function.
 *
 * The reason rides here rather than on the row. guest_commitments.escalated_at
 * is an idempotency marker with exactly one job; putting the reason in the
 * event keeps the column honest and puts the detail where an analyst would
 * actually query it.
 */
export async function captureCommitmentEscalated(
  props: CommitmentEscalatedProps,
): Promise<void> {
  await capturePostHogEvent('commitment_escalated', props.guestId, { ...props })
  const detail: Record<CommitmentEscalationReason, string> = {
    aging_obligation: `open for ${props.ageDays} days with no resolution`,
    hold_nearing_close: 'still unclaimed and the venue closes soon',
    hold_horizon_unknown:
      'venue hours could not be read, so this expires at 23:59 venue-local as a fallback',
    expiring_unsurfaced:
      'reached its expiry without ever having surfaced — the escalation window was missed',
  }
  await postToSlack(
    [
      `*Open ${props.type} needs attention*`,
      `venue: \`${props.venueId}\``,
      `guest: \`${props.guestId}\``,
      `commitment: \`${props.commitmentId}\``,
      `why: ${detail[props.reason]}`,
      `expires: ${props.expiresAt ?? 'unknown'}`,
      `_The venue still owes this. It stays open until redeemed or expired._`,
    ].join('\n'),
  )
}

export interface CommitmentExpiredProps {
  venueId: string
  guestId: string
  commitmentId: string
  type: string
  createdAt: string
  expiresAt: string
  /** Whether a human had been told before this row elapsed. */
  hadEscalated: boolean
}

/**
 * An obligation reached its horizon and moved to `expired`.
 *
 * PostHog only, NO Slack relay — deliberately the opposite of its escalation
 * sibling. Expiry is the expected, healthy end of the lifecycle for anything
 * nobody claimed; relaying it would put a steady drip of non-actionable
 * messages next to the escalations that ARE actionable, which is how an alert
 * channel stops being read. The actionable half already fired, earlier, as an
 * escalation.
 *
 * `hadEscalated` is the one field worth querying: a false here means the
 * "never silently expired" guarantee leaned on the same-tick fallback rather
 * than on the escalation window doing its job.
 */
export async function captureCommitmentExpired(
  props: CommitmentExpiredProps,
): Promise<void> {
  await capturePostHogEvent('commitment_expired', props.guestId, { ...props })
}

// ---------------------------------------------------------------------------
// TAC-469: a conversation whose channel could not be resolved
// ---------------------------------------------------------------------------

export interface ConversationChannelUnresolvedProps {
  agentRunId: string
  venueId: string
  guestId: string
  inboundMessageId: string | null
  /** The inbound message's channel; undefined when the run had no inbound message. */
  inboundChannel: string | null | undefined
  hasPhone: boolean
  hasInstagramId: boolean
  reason: string | null
}

/**
 * Fires from buildRuntimeContext when resolveConversationChannel returns null.
 *
 * SLACK-RELAYED. Before TAC-469 this was a console.warn and only picked the
 * prompt copy; now that sends route on the channel, an unresolved channel is a
 * guest whose reply cannot be routed at all, because nothing routes on null.
 * Its main cause is migration 048's 'text' default on an Instagram row, the
 * same hazard that would blind the webhook-silence alarm. Carries only
 * presence flags: never the phone number or the Instagram ID.
 */
export async function captureConversationChannelUnresolved(
  props: ConversationChannelUnresolvedProps,
): Promise<void> {
  const inboundChannel =
    props.inboundChannel === undefined
      ? 'none'
      : (props.inboundChannel ?? 'unparseable')
  await capturePostHogEvent('conversation_channel_unresolved', props.guestId, {
    ...props,
    inboundChannel,
  })
  await postToSlack(
    [
      "*Conversation channel unresolved*: this guest's reply can't be routed",
      `reason: \`${props.reason ?? 'unknown'}\` · inbound channel: \`${inboundChannel}\``,
      `has phone: \`${props.hasPhone}\` · has Instagram ID: \`${props.hasInstagramId}\``,
      `venue: \`${props.venueId}\``,
      `guest: \`${props.guestId}\``,
      `run: \`${props.agentRunId}\``,
      props.inboundMessageId
        ? `inbound message: \`${props.inboundMessageId}\``
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

// ---------------------------------------------------------------------------
// TAC-469: an agent reply to an Instagram guest that did not go out
// ---------------------------------------------------------------------------

export interface InstagramSendFailedProps {
  agentRunId: string
  venueId: string
  guestId: string
  /** Why: a transport failure kind, the gate's window refusal, the cap, or missing configuration. */
  reason: string
  /** Whether the whole reply failed, or only the messages after the ones that went out. */
  scope: 'whole_reply' | 'remainder'
  bubbleCount: number
  deliveredBubbles: number
  /**
   * Milliseconds until Meta's window closes when the send was attempted, margin
   * not subtracted; null when unknown. A Meta refusal with subcode 2534022
   * while this was positive is the evidence the 5-minute margin is too small.
   */
  windowRemainingMs: number | null
  metaCode: number | null
  metaSubcode: number | null
  fbtraceId: string | null
  /** True when Meta may have delivered it anyway (a timeout, a lost connection, an unreadable 200). */
  outcomeUnknown: boolean
  /** The card the reply became, or null when none was written. */
  cardId: string | null
  /** Why no card was written, when cardId is null. */
  cardSkipped: string | null
  undeliveredBody: string
}

/**
 * SLACK-RELAYED, with the undelivered text: this is the one record of what the
 * guest did not get, including when no card could be written (the guest opted
 * out, or another card holds the slot). TAC-469 rule 4: a failed send is never
 * a log line alone.
 */
export async function captureInstagramSendFailed(
  props: InstagramSendFailedProps,
): Promise<void> {
  await capturePostHogEvent('instagram_send_failed', props.guestId, {
    ...props,
  })
  const meta =
    props.metaCode !== null
      ? ` · Meta code \`${props.metaCode}\`${props.metaSubcode !== null ? `/\`${props.metaSubcode}\`` : ''}${props.fbtraceId ? ` · fbtrace \`${props.fbtraceId}\`` : ''}`
      : ''
  await postToSlack(
    [
      `*Instagram reply didn't send*: \`${props.reason}\` (${props.scope === 'remainder' ? 'the rest of a split reply' : 'the whole reply'})${meta}`,
      props.outcomeUnknown
        ? 'Meta may have delivered it anyway: check the thread before sending again.'
        : '',
      props.windowRemainingMs !== null
        ? `window: \`${Math.round(props.windowRemainingMs / 1000)}s\` until Meta closes it`
        : '',
      `delivered \`${props.deliveredBubbles}\` of \`${props.bubbleCount}\` messages`,
      props.cardId !== null
        ? `card: \`${props.cardId}\``
        : `no card written: \`${props.cardSkipped ?? 'unknown'}\``,
      `venue: \`${props.venueId}\``,
      `guest: \`${props.guestId}\``,
      `run: \`${props.agentRunId}\``,
      `undelivered: "${truncate(props.undeliveredBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

export interface OperatorMessageResolvedExternallyProps {
  venueId: string
  guestId: string
  messageId: string
  operatorId: string
  /** The card's channel, so the Instagram and text cases are separable. */
  channel: string | null
  timeToActionMs: number
}

/**
 * TAC-473: an operator said a card was answered outside the app.
 *
 * IDs only, matching the TAC-258 operator-action events beside it: the body
 * lives on the row, and what this answers is how often the echo path failed to
 * clear a card before a human had to. No Slack relay — it is an ordinary
 * operator action, not an incident.
 */
export async function captureOperatorMessageResolvedExternally(
  props: OperatorMessageResolvedExternallyProps,
): Promise<void> {
  await capturePostHogEvent(
    'operator_message_resolved_externally',
    props.guestId,
    { ...props },
  )
}

export interface InstagramCardResolvedExternallyProps {
  venueId: string
  guestId: string
  /** The echo row that answered it. */
  echoMessageId: string
  /** The card resolved, or null when none was. */
  cardId: string | null
  outcome:
    | 'resolved'
    | 'window_open'
    | 'window_unknown'
    | 'no_card'
    | 'lost_race'
    | 'failed'
  /**
   * TAC-473: whether the resolved card carried a comp, hold or discount.
   *
   * FIFO takes the oldest pending card whatever slot it is in, so it can be an
   * obligation card; resolving one means the commitment is never materialised
   * and nobody sees the venue promised something. Counted here rather than
   * ruled on, so the decision has evidence. Null when nothing was resolved.
   */
  hadPendingCommitment: boolean | null
  error: string | null
}

/**
 * TAC-473: a pending card was answered from the Instagram app.
 *
 * PostHog only, no Slack relay. `window_open` and `no_card` are the ordinary
 * outcomes — every one of our own sends echoes back and lands on the first —
 * so relaying would post on routine traffic and mean nothing. The question
 * this answers is "has external resolution ever fired", which is a query, not
 * an alert.
 *
 * Carries no message body: the echo's text is the venue talking to a guest,
 * and the row id is enough to find it.
 */
export async function captureInstagramCardResolvedExternally(
  props: InstagramCardResolvedExternallyProps,
): Promise<void> {
  await capturePostHogEvent(
    'instagram_card_resolved_externally',
    props.guestId,
    { ...props },
  )
}

export interface InstagramReplySupersededProps {
  agentRunId: string
  venueId: string
  guestId: string
  inboundMessageId: string
  answeredByMessageId: string
}

/**
 * The agent held back a reply because the guest's message already had one,
 * usually a reply staff typed in the Instagram app. PostHog only: it is the
 * intended behaviour (TAC-469 rule 3), not an alert.
 */
export async function captureInstagramReplySuperseded(
  props: InstagramReplySupersededProps,
): Promise<void> {
  await capturePostHogEvent('instagram_reply_superseded', props.guestId, {
    ...props,
  })
}

export interface InstagramSenderActionFailedProps {
  venueId: string
  guestId: string
  /** 'mark_seen' | 'typing_on' | 'typing_off'. A vocabulary constant. */
  action: string
  /** The InstagramSendFailureKind the Graph failure classified to. */
  kind: string
}

/**
 * TAC-540: a Seen tick or a typing indicator did not go out.
 *
 * PostHog only, NO Slack relay, and the restraint is the point. These are
 * cosmetic by construction — nothing reads the result and no reply changes —
 * so relaying them would put a line in Slack for something nobody can act on
 * per occurrence. The cause that actually matters, a rejected or expired
 * token, already relays loudly through `instagram_send_failed` on the very
 * next reply, and `kind` here is the same vocabulary, so the two line up in a
 * query.
 *
 * Worth watching as a RATE rather than an event: a venue whose sender actions
 * all fail while its sends succeed is the shape of a permissions problem
 * rather than a token one.
 */
export async function captureInstagramSenderActionFailed(
  props: InstagramSenderActionFailedProps,
): Promise<void> {
  await capturePostHogEvent('instagram_sender_action_failed', props.guestId, {
    ...props,
  })
}

export type InstagramScanUnattributedReason =
  /**
   * An icebreaker tap carrying no referral.
   *
   * What this CAN see: Meta dropping the referral on the first-contact path
   * that is known to carry one today. An empty thread is the only place
   * Instagram offers icebreakers at all, so a tap is very often the venue's
   * link being opened, and without the referral nothing can say so.
   *
   * What it CANNOT see, stated because an earlier version of this comment
   * claimed the opposite: the returning guest who opens the link into a thread
   * that STILL HAS MESSAGES. TAC-518's recorded payloads showed that such a thread
   * shows no icebreakers, so there is no postback to report — that guest types,
   * and a typed message with no referral is indistinguishable from an ordinary
   * DM. Device QA answers that case by reading `messages.referral_source` on
   * the row, not by waiting for this event.
   *
   * KNOWN FALSE POSITIVE, and it is the likeliest first firing: a guest with no
   * prior DM who finds the venue in search and taps an icebreaker. Empty
   * thread, no link, ordinary first contact. Read `guestCreated` beside it.
   */
  | 'postback_without_referral'
  /**
   * A referral arrived whose source is not the one that means "opened from a
   * link". Meta documents others (ads, the customer-chat plugin), so this is
   * not necessarily wrong — but if Meta ever renames the value we match on,
   * every scan silently stops arming, and this is the only thing that would
   * say so.
   */
  | 'unrecognized_referral_source'

export interface InstagramScanUnattributedProps {
  venueId: string
  guestId: string
  messageId: string
  reason: InstagramScanUnattributedReason
  /**
   * Meta's own `referral.source`, or null when none arrived. A vocabulary
   * constant, never guest content — the same reasoning that lets the recorded
   * payloads keep `source` and `type` unreplaced.
   */
  referralSource: string | null
  /** Whether this event created the guest, i.e. their first message to us. */
  guestCreated: boolean
}

/**
 * An Instagram inbound that looks like it came from the venue's link and
 * carries nothing to prove it.
 *
 * SLACK-RELAYED, deliberately, and it is the point of TAC-518's visibility
 * half. The referral is the only signal that a returning guest is standing at
 * the counter; if it stops arriving, every such guest silently goes back to
 * being treated as an ordinary DM, and before this nothing anywhere said so.
 * At one venue's volume the relay IS the measurement. If it turns out to fire
 * on every returning scan, the answer is to say so and stop, not to infer a
 * scan from something weaker.
 *
 * Carries no message body and no scoped ID, per the Instagram logging rule.
 */
export interface InstagramScanConfirmedVisitProps {
  venueId: string
  guestId: string
  messageId: string
  /** True when this guest already had messages with the venue: the returning scanner. */
  returningGuest: boolean
  /** True when a confirmed visit was already on record and this scan moved the anchor later. */
  overrodeExistingAnchor: boolean
  /**
   * TAC-536: true when the anchor came from a STANDALONE scan carried forward
   * rather than from a referral on this message. Two different mechanisms, and
   * a rate for one must not be read as the other's.
   */
  carriedForward?: boolean
}

/**
 * A scan on this turn confirmed a visit, so order capture armed off it.
 *
 * The POSITIVE half of TAC-518's open question, and the half that actually
 * answers it. `instagram_scan_unattributed` says a referral did not arrive;
 * without this, a referral that DID arrive for a returning guest left no trace
 * anywhere until the model happened to raise the line — and between TAC-380 and
 * TAC-436 no intention was ever raised in production, so that is not a signal
 * to wait on.
 *
 * Slack-relayed ONLY for a returning guest. A first-contact scan is the case
 * already known to work and fires on every QR guest's first turn, which would
 * be noise; a returning guest's scan is the thing nobody has observed, and at
 * one venue's volume the relay is the measurement.
 */
export async function captureInstagramScanConfirmedVisit(
  props: InstagramScanConfirmedVisitProps,
): Promise<void> {
  await capturePostHogEvent('instagram_scan_confirmed_visit', props.guestId, {
    ...props,
  })
  if (!props.returningGuest) return
  await postToSlack(
    [
      '*A returning Instagram guest scanned at the counter*: order capture armed off the referral.',
      props.overrodeExistingAnchor
        ? 'a confirmed visit was already on record; this scan is the newer one'
        : 'no confirmed visit was on record before this scan',
      `venue: \`${props.venueId}\``,
      `guest: \`${props.guestId}\``,
      `message: \`${props.messageId}\``,
    ].join('\n'),
  )
}

/**
 * TAC-536: what became of a bare Instagram scan.
 *
 * Fires once per resolved scan, whichever way it went, so a greeting rate has
 * a denominator: before this the whole flow was invisible unless a message
 * appeared in the thread. Carries no message body and no scoped ID, per the
 * Instagram logging rule.
 */
export interface InstagramScanGreetingProps {
  venueId: string
  guestId: string
  /** The scan's own inbound row. Null when it has since been deleted. */
  scanMessageId: string | null
  /** The vocabulary of instagram_scan_arrivals.outcome. */
  outcome: string
  /**
   * Which greeting instruction rendered. Null on a suppressed scan, where
   * nothing was generated and the question did not arise.
   */
  hadPriorConversation: boolean | null
  /** The AgentResult status, on a scan that was actually greeted. */
  agentStatus?: string
  /**
   * TAC-575: this greeting took the follow-up on a complaint from an earlier
   * visit. Absent on a suppressed scan.
   */
  followedUpComplaint?: boolean
  /** TAC-575: and the complaint was recent enough for the greeting to refer to. */
  mentionedComplaint?: boolean
}

/**
 * Slack-relayed ONLY on a greeting that was actually generated.
 *
 * This is the one scheduled path in the repo that messages a guest with no
 * operator and no inbound behind it, and at pilot volume the relay IS the
 * answer to "has it ever fired". The suppressions are PostHog only: they are
 * the common case (a guest who writes within the greeting delay suppresses their
 * own greeting, which is the flow working) and relaying them would drown the
 * signal.
 */
export async function captureInstagramScanGreeting(
  props: InstagramScanGreetingProps,
): Promise<void> {
  await capturePostHogEvent('instagram_scan_greeting', props.guestId, {
    ...props,
  })
  if (props.outcome !== 'greeted') return
  await postToSlack(
    [
      '*An Instagram guest scanned the counter code and was greeted*: no message from them before the greeting delay ran out.',
      props.hadPriorConversation === true
        ? 'they have messaged this venue before, so the greeting does not introduce itself'
        : 'no messages with them on record, so the greeting says who they have reached',
      ...(props.followedUpComplaint === true
        ? [
            props.mentionedComplaint === true
              ? 'their last visit ended in a complaint, and this greeting follows it up'
              : "their last visit ended in a complaint too long ago to bring up; the review link is owed at this visit's sign-off",
          ]
        : []),
      `agent outcome: \`${props.agentStatus ?? 'unknown'}\``,
      `venue: \`${props.venueId}\``,
      `guest: \`${props.guestId}\``,
    ].join('\n'),
  )
}

export async function captureInstagramScanUnattributed(
  props: InstagramScanUnattributedProps,
): Promise<void> {
  await capturePostHogEvent('instagram_scan_unattributed', props.guestId, {
    ...props,
  })
  await postToSlack(
    [
      `*Instagram inbound could not be attributed to the venue's link*: \`${props.reason}\``,
      props.referralSource !== null
        ? `source Meta sent: \`${props.referralSource}\``
        : 'no referral on the event',
      props.guestCreated
        ? "this was the guest's first message"
        : 'the guest has messaged before',
      `venue: \`${props.venueId}\``,
      `guest: \`${props.guestId}\``,
      `message: \`${props.messageId}\``,
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// Instagram per-venue tokens (TAC-516 / TAC-460)
// ---------------------------------------------------------------------------

export interface InstagramTokenRefreshFailedProps {
  venueId: string
  /** Meta's code and subcode, or our own failure kind. NEVER Meta's message. */
  reason: string
  expiresAt?: string
}

/**
 * A refresh attempt failed and the old token was left in place. Recoverable:
 * the job runs daily against a ten-day margin, so there are many more
 * attempts before the window closes.
 *
 * Slack-relayed because the AC asks for a failed refresh to be visible rather
 * than silent, and at pilot volume (one connected venue) the relay IS the
 * visibility. The passive channel is the operator app's own `expiring` state.
 */
export async function captureInstagramTokenRefreshFailed(
  props: InstagramTokenRefreshFailedProps,
): Promise<void> {
  await capturePostHogEvent('instagram_token_refresh_failed', props.venueId, {
    ...props,
  })
  await postToSlack(
    [
      `*Instagram token refresh failed*`,
      `venue: \`${props.venueId}\``,
      `why: ${props.reason}`,
      props.expiresAt !== undefined
        ? `token expires: ${props.expiresAt}`
        : null,
      `_The existing token is untouched and still works. This retries daily._`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
  )
}

export interface InstagramTokenExpiredUnrecoverableProps {
  venueId: string
  expiredAt: string
}

/**
 * The token passed its expiry without being refreshed. Meta cannot refresh an
 * expired token at all, so this is the one failure here that no retry fixes:
 * that venue's Instagram messaging is down until a human re-authorizes it.
 *
 * Its OWN event rather than one more refresh failure, per TAC-460's note that
 * this path "should alert distinctly" — the action it needs is different, and
 * folding it in would bury the only one that needs a person today.
 */
export async function captureInstagramTokenExpiredUnrecoverable(
  props: InstagramTokenExpiredUnrecoverableProps,
): Promise<void> {
  await capturePostHogEvent(
    'instagram_token_expired_unrecoverable',
    props.venueId,
    { ...props },
  )
  await postToSlack(
    [
      `*Instagram token EXPIRED and cannot be refreshed*`,
      `venue: \`${props.venueId}\``,
      `expired: ${props.expiredAt}`,
      `_Meta cannot refresh an expired token. This venue's Instagram messaging is down until someone reconnects it._`,
    ].join('\n'),
  )
}

export interface InstagramConnectSubscribeFailedProps {
  venueId: string
  failureReason: string
  graphCode: number | null
}

/**
 * A venue connected, but subscribing its account to our webhooks failed.
 *
 * ITS OWN EVENT rather than part of a generic connect failure, because this
 * is the one outcome in the connect flow where the operator sees success and
 * nothing works: the credential is stored, the venue looks connected, and no
 * guest message ever arrives. Every other failure in that flow renders a
 * failure page, so the operator already knows.
 *
 * Recoverable by reconnecting, which is why the callback treats it as a
 * warning rather than failing a connection that is otherwise complete.
 */
export async function captureInstagramConnectSubscribeFailed(
  props: InstagramConnectSubscribeFailedProps,
): Promise<void> {
  await capturePostHogEvent(
    'instagram_connect_subscribe_failed',
    props.venueId,
    { ...props },
  )
  await postToSlack(
    [
      `*Instagram connected but NOT subscribed to webhooks*`,
      `venue: \`${props.venueId}\``,
      `why: ${props.failureReason}${props.graphCode === null ? '' : ` (code ${props.graphCode})`}`,
      `_This venue looks connected and will receive no messages. Reconnecting fixes it._`,
    ].join('\n'),
  )
}

export interface InstagramDeletionUnmatchedAccountProps {
  confirmationCode: string
}

/**
 * A data-deletion request arrived for an Instagram account no venue owns.
 *
 * Legitimate on its own: Meta can send one for an account that never finished
 * connecting, or one already disconnected and cleared.
 *
 * It is ALSO what a wrong id-matching assumption looks like. Whether
 * signed_request's `user_id` equals what we store in
 * venues.instagram_account_id is a Meta-side fact this repo cannot verify,
 * and CLAUDE.md records that Meta distinguishes an app-scoped `id` from
 * `user_id`. If those differ, every deletion request would match nothing,
 * redact nothing, and still answer Meta correctly — a silent failure of the
 * one callback Meta tests directly. Alerting turns an unverifiable assumption
 * into a visible signal.
 *
 * Carries the confirmation code only: never the account id, which belongs to
 * someone who has just asked us to erase their data.
 */
export async function captureInstagramDeletionUnmatchedAccount(
  props: InstagramDeletionUnmatchedAccountProps,
): Promise<void> {
  await capturePostHogEvent(
    'instagram_deletion_unmatched_account',
    props.confirmationCode,
    { ...props },
  )
  await postToSlack(
    [
      `*Instagram data-deletion request matched no venue*`,
      `confirmation: \`${props.confirmationCode}\``,
      `_Normal for a stale or already-disconnected account. If EVERY deletion request looks like this, the signed_request user_id does not match venues.instagram_account_id and nothing is being erased._`,
    ].join('\n'),
  )
}

// TAC-560: the warm "line is open" close.
//
// Slack-relayed on a SEND because this is a proactive guest-facing message with
// no operator and no inbound behind it, and at pilot volume the relay IS the
// answer to "has this ever fired, and by which path". The skip event is PostHog
// only: `not_yet` alone would fire on every tick, so a relay there would train
// people to ignore the channel (the `agent_latency_high` lesson).
export interface WarmCloseSentProps {
  agentRunId: string | null
  venueId: string
  guestId: string
  /**
   * Which path closed the conversation. `in_conversation` is the guest saying
   * thanks and the model reporting it; `pause_timer` is this ticket's cron.
   */
  via: 'in_conversation' | 'pause_timer'
  /** The outbound row the close answers, or null on the in-conversation path. */
  answersMessageId?: string | null
  /** How long the guest had been silent, on the timer path. */
  pauseMs?: number
  /** Whether our own last message had asked them something. */
  weAskedAQuestion?: boolean
  /** On the in-conversation path: whether the marker was already set. */
  markerOutcome?: 'marked' | 'already_marked' | 'write_failed'
}

export async function captureWarmCloseSent(
  props: WarmCloseSentProps,
): Promise<void> {
  await capturePostHogEvent('warm_close_sent', props.guestId, { ...props })
  await postToSlack(
    [
      `*Warm close sent* via \`${props.via}\`: the guest's first conversation ended with the line left open.`,
      props.via === 'pause_timer'
        ? `they had been quiet for ${Math.round((props.pauseMs ?? 0) / 60_000)}m${props.weAskedAQuestion ? ', and our last message had asked them something' : ''}`
        : `marker: \`${props.markerOutcome ?? 'unknown'}\``,
      `venue: \`${props.venueId}\``,
      `guest: \`${props.guestId}\``,
    ].join('\n'),
  )
}

export interface WarmCloseSkippedProps {
  venueId: string
  guestId: string
  messageId: string
  reason: string
  /** Set when the skip was a send that did not land, not a pre-claim refusal. */
  agentStatus?: string
}

export async function captureWarmCloseSkipped(
  props: WarmCloseSkippedProps,
): Promise<void> {
  await capturePostHogEvent('warm_close_skipped', props.guestId, { ...props })
}
