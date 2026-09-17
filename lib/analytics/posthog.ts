/**
 * PostHog event registry for the agent observability layer.
 *
 * Dependency direction: this module is a leaf — other modules (lib/agent,
 * cron routes, etc.) import from here. This module imports only from
 * posthog-node. Never reverse the direction; analytics should never depend
 * on agent code.
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
 * - voice_fidelity_low
 *     Fires when generateMessage returns a final fidelity below 0.5.
 *     Sits between SEND_FIDELITY_FLOOR (0.4, refusal) and the regen loop's
 *     MIN_VOICE_FIDELITY (0.7, loop-exit target).
 *     Properties: { agentRunId, venueId, guestId, voiceFidelity, attempts,
 *                   attemptScores, category, inboundBody, generatedBody }
 *
 * - regeneration_triggered
 *     Fires when generateMessage's internal loop made > 1 attempt.
 *     Properties: { agentRunId, venueId, guestId, attempts, attemptScores,
 *                   finalFidelity, inboundBody, finalGeneratedBody }
 *
 * - dash_violation_persisted
 *     Fires when generateMessage exhausted MAX_ATTEMPTS regenerations and
 *     the shipped body still contains an em (—) or en (–) dash. The dash
 *     regex check (THE-225) is a deterministic backstop on top of the R3
 *     voice rule; persisted failures ship anyway and surface here.
 *     Properties: { agentRunId, venueId, guestId, category, attempts,
 *                   attemptScores, finalFidelity, inboundBody,
 *                   finalGeneratedBody }
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
 * - corpus_retrieval_below_threshold
 *     Fires when the best-match similarity is below 0.5 (looser bar than the
 *     fail-closed gate of 1 above 0.3). Catches "thin retrieval" runs that
 *     succeed structurally but lack venue-voice grounding.
 *     Properties: { agentRunId, venueId, guestId, totalMatches,
 *                   strongMatchCount, topSimilarity, inboundBody,
 *                   topMatchPreview }
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
 *                   voiceFidelity, generatedBody }
 *
 * - grounding_verifier_unavailable
 *     TAC-367. Fires from verifyGroundingStage (lib/agent/stages.ts) when the
 *     grounding backstop returned no verdict — `outcome: 'truncated'` (output
 *     cap hit mid-JSON; fails CLOSED, draft queued) or `outcome: 'degraded'`
 *     (transient fault; fails OPEN, reply proceeds). Slack-relays both: the
 *     property that let the truncation hole survive was that nothing was
 *     emitted at all. Query `failedClosed=false` for turns that shipped with
 *     no grounding verdict.
 *     Properties: { agentRunId, venueId, guestId, outcome, failedClosed,
 *                   error, errorCode }
 *
 * - webhook_silence
 *     Daily cron event. Fires when no inbound webhook has landed in 24+
 *     hours, but only when there's been at least one prior inbound (i.e.,
 *     skipped on initial venue state). Filtered to non-test venues.
 *     Properties: { hoursWithoutWebhook, lastWebhookAt }
 *
 * - ungrounded_claim_caught
 *     TAC-350. Fires from verifyGroundingStage (lib/agent/stages.ts) when the
 *     independent grounding backstop flags a reply the model itself had
 *     already self-certified as grounded (knowledgeGap=false) — distinct
 *     from draft_queued's generic primaryTrigger field so "how often is the
 *     model getting caught fabricating, per venue" is directly queryable
 *     without filtering the whole queue-decision stream. Slack-relays: this
 *     is exactly the failure class (a guest almost receiving an invented
 *     fact) TAC-350 exists to make visible.
 *     Properties: { agentRunId, venueId, guestId, inboundBody, replyBody,
 *                   ungroundedClaims }
 */

import { PostHog } from 'posthog-node'
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
 * failure logs via console.error and swallows so analytics outages can't
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
    console.error(`alert: posthog capture failed for ${event}`, {
      distinctId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const VOICE_FIDELITY_LOW_THRESHOLD = 0.5
export const CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD = 0.7
// Below this confidence, classifyStage rewrites the returned category to
// `unknown` so the agent ships a holding response. Original pick is preserved
// on the PostHog event payload for triage. Sits below the 0.7 LOW threshold.
export const CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD = 0.3
export const CORPUS_TOP_SIMILARITY_LOW_THRESHOLD = 0.5
export const AGENT_LATENCY_HIGH_THRESHOLD_MS = 10_000
export const WEBHOOK_SILENCE_THRESHOLD_HOURS = 24

// ---------------------------------------------------------------------------
// Named-event helpers
// ---------------------------------------------------------------------------

export interface VoiceFidelityLowProps {
  agentRunId: string
  venueId: string
  guestId: string
  voiceFidelity: number
  attempts: number
  attemptScores: number[]
  category: string
  inboundBody: string | null
  generatedBody: string
}

export async function captureVoiceFidelityLow(props: VoiceFidelityLowProps): Promise<void> {
  await capturePostHogEvent('voice_fidelity_low', props.guestId, { ...props })
  await postToSlack(formatVoiceFidelityLow(props))
}

function formatVoiceFidelityLow(props: VoiceFidelityLowProps): string {
  const scores = props.attemptScores.map((s) => s.toFixed(2)).join(', ')
  const lines = [
    `*Voice fidelity low* — score \`${props.voiceFidelity.toFixed(2)}\` (${props.attempts} attempt${props.attempts === 1 ? '' : 's'}: ${scores})`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `category: \`${props.category}\``,
  ]
  if (props.inboundBody) {
    lines.push(`inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  lines.push(`generated: "${truncate(props.generatedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  return lines.join('\n')
}

export interface RegenerationTriggeredProps {
  agentRunId: string
  venueId: string
  guestId: string
  attempts: number
  attemptScores: number[]
  finalFidelity: number
  inboundBody: string | null
  finalGeneratedBody: string
}

export async function captureRegenerationTriggered(
  props: RegenerationTriggeredProps,
): Promise<void> {
  await capturePostHogEvent('regeneration_triggered', props.guestId, { ...props })
  await postToSlack(formatRegenerationTriggered(props))
}

function formatRegenerationTriggered(props: RegenerationTriggeredProps): string {
  const scores = props.attemptScores.map((s) => s.toFixed(2)).join(', ')
  const lines = [
    `*Regeneration triggered* — ${props.attempts} attempts, final fidelity \`${props.finalFidelity.toFixed(2)}\` (scores: ${scores})`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
  ]
  if (props.inboundBody) {
    lines.push(`inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  lines.push(`final generated: "${truncate(props.finalGeneratedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
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
  await capturePostHogEvent('emoji_directive_violated', props.guestId, { ...props })
}

// THE-225: dash regex check inside generateMessage's regen loop forces a
// rewrite when an em or en dash sneaks past R3 in the system prompt. If
// MAX_ATTEMPTS exhaust without a clean reply, we ship the final body anyway
// (refusing on punctuation would be worse than violating it) and emit this
// event so the failure is visible in the silent-failure surfaces alongside
// voice_fidelity_low / regeneration_triggered.
export interface DashViolationPersistedProps {
  agentRunId: string
  venueId: string
  guestId: string
  category: string
  attempts: number
  attemptScores: number[]
  finalFidelity: number
  inboundBody: string | null
  finalGeneratedBody: string
}

export async function captureDashViolationPersisted(
  props: DashViolationPersistedProps,
): Promise<void> {
  await capturePostHogEvent('dash_violation_persisted', props.guestId, { ...props })
  await postToSlack(formatDashViolationPersisted(props))
}

function formatDashViolationPersisted(props: DashViolationPersistedProps): string {
  const scores = props.attemptScores.map((s) => s.toFixed(2)).join(', ')
  const lines = [
    `*Dash violation persisted* — shipped after ${props.attempts} attempts (scores: ${scores}), final fidelity \`${props.finalFidelity.toFixed(2)}\``,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `category: \`${props.category}\``,
  ]
  if (props.inboundBody) {
    lines.push(`inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  lines.push(`final generated: "${truncate(props.finalGeneratedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
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
  await capturePostHogEvent('classification_low_confidence', props.guestId, { ...props })
  await postToSlack(formatClassificationLowConfidence(props))
}

function formatClassificationLowConfidence(props: ClassificationLowConfidenceProps): string {
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
    lines.push('auto-routed to: `unknown` — agent shipped holding ack; decide if a real reply is needed')
  }
  return lines.join('\n')
}

export interface CorpusRetrievalBelowThresholdProps {
  agentRunId: string
  venueId: string
  guestId: string
  totalMatches: number
  strongMatchCount: number
  topSimilarity: number
  inboundBody: string | null
  topMatchPreview: string | null
}

export async function captureCorpusRetrievalBelowThreshold(
  props: CorpusRetrievalBelowThresholdProps,
): Promise<void> {
  await capturePostHogEvent('corpus_retrieval_below_threshold', props.guestId, { ...props })
  await postToSlack(formatCorpusRetrievalBelowThreshold(props))
}

function formatCorpusRetrievalBelowThreshold(props: CorpusRetrievalBelowThresholdProps): string {
  const lines = [
    `*Corpus retrieval thin* — top similarity \`${props.topSimilarity.toFixed(2)}\` (${props.strongMatchCount} strong matches above 0.3, ${props.totalMatches} total)`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
  ]
  if (props.inboundBody) {
    lines.push(`inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  if (props.topMatchPreview) {
    lines.push(`top match preview: "${truncate(props.topMatchPreview, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  return lines.join('\n')
}

// TAC-350: emitted from verifyGroundingStage (lib/agent/stages.ts) when the
// independent grounding backstop catches an unverified claim in a reply the
// model already self-certified as grounded. Slack relay yes — this is the
// exact failure (a guest nearly receiving an invented fact) TAC-350 exists
// to surface, same posture as captureDraftQueued.
export interface UngroundedClaimCaughtProps {
  agentRunId: string
  venueId: string
  guestId: string
  inboundBody: string
  // The reply text that was caught — never sent to the guest (the approval
  // gate blanks it before persisting), safe to log here for debugging.
  replyBody: string
  ungroundedClaims: string[]
}

export async function captureUngroundedClaimCaught(
  props: UngroundedClaimCaughtProps,
): Promise<void> {
  await capturePostHogEvent('ungrounded_claim_caught', props.guestId, { ...props })
  await postToSlack(formatUngroundedClaimCaught(props))
}

/**
 * TAC-367: emitted from verifyGroundingStage when the grounding backstop did
 * NOT return a verdict — i.e. the only fabrication check that fires under
 * real traffic did not run for this turn.
 *
 * Two outcomes, deliberately ONE event with a discriminator rather than two
 * events, because the question anyone actually asks is "how often is the
 * backstop not running", and that should be one PostHog query rather than a
 * union the next person has to know to write.
 *
 *   - `truncated`  — the model produced a verdict and the output cap cut it
 *                    off mid-JSON. Fails CLOSED: the draft is queued.
 *   - `degraded`   — a transient fault (network, provider error, timeout).
 *                    Fails OPEN: the draft proceeds through the rest of the
 *                    gate exactly as it did before TAC-350.
 *
 * `failedClosed` carries that consequence explicitly rather than leaving it
 * to be re-derived from `outcome`, so a query for "turns that sent without a
 * grounding verdict" is a single boolean filter.
 *
 * BOTH Slack-relay. The degraded case is the one worth arguing about, and it
 * relays because fail-open means a guest-facing message shipped with a safety
 * check skipped — the same class as captureUngroundedClaimCaught, and the
 * precise property that let the truncation bug survive unnoticed was that
 * nothing was emitted at all. Known cost: a sustained provider outage will
 * relay once per inbound. That is noisy by design — the alternative is a
 * fleet-wide silent bypass — but if the volume proves unworkable the lever is
 * a PostHog-side filter on `outcome`, not deleting the emit.
 */
export interface GroundingVerifierUnavailableProps {
  agentRunId: string
  venueId: string
  guestId: string
  outcome: 'truncated' | 'degraded'
  /** True when the draft was queued as a result; false when it proceeded. */
  failedClosed: boolean
  /** Provider/SDK error text. Never contains guest or venue content. */
  error: string
  errorCode?: string
}

export async function captureGroundingVerifierUnavailable(
  props: GroundingVerifierUnavailableProps,
): Promise<void> {
  await capturePostHogEvent('grounding_verifier_unavailable', props.guestId, { ...props })
  await postToSlack(formatGroundingVerifierUnavailable(props))
}

function formatGroundingVerifierUnavailable(props: GroundingVerifierUnavailableProps): string {
  const headline = props.failedClosed
    ? '*Grounding check truncated* — no verdict, draft queued for review'
    : '*Grounding check unavailable* — no verdict, reply proceeded ungated'
  return [
    headline,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `outcome: ${props.outcome}${props.errorCode ? ` (${props.errorCode})` : ''}`,
    `error: "${truncate(props.error, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ].join('\n')
}

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
   * whole point of the event; the two existing agent-quality Slack events
   * (ungrounded claim, mechanic offer) carry message text on the same basis.
   */
  sentBody: string
}

export async function captureIntentionPromptRaised(
  props: IntentionPromptRaisedProps,
): Promise<void> {
  await capturePostHogEvent('intention_prompt_raised', props.guestId, { ...props })
  await postToSlack(formatIntentionPromptRaised(props))
}

function formatIntentionPromptRaised(props: IntentionPromptRaisedProps): string {
  // The offered set minus what was raised, so the line reads as "she took this
  // one, these were also open" rather than repeating the raised key.
  const alsoOffered = props.offeredKeys.filter((k) => !props.raisedKeys.includes(k))
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
  await capturePostHogEvent('intention_prompt_recording_failed', props.guestId, { ...props })
  await postToSlack(formatIntentionPromptRecordingFailed(props))
}

function formatIntentionPromptRecordingFailed(props: IntentionPromptRecordingFailedProps): string {
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

function formatUngroundedClaimCaught(props: UngroundedClaimCaughtProps): string {
  const claimList = props.ungroundedClaims.map((c) => `"${truncate(c, SLACK_FIELD_TRUNCATE_CHARS)}"`).join(', ')
  const lines = [
    `*Ungrounded claim caught* — reply never sent, queued for review`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
    `caught claim(s): ${claimList}`,
    `flagged reply: "${truncate(props.replyBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ]
  return lines.join('\n')
}

// TAC-355: independent mechanic-offer verification backstop caught a reply
// promising an approval-gated mechanic the model didn't self-flag via either
// existing signal (requiresOperatorApproval or commitment.type). Mirrors
// UngroundedClaimCaughtProps/captureUngroundedClaimCaught's shape — same
// "how often is the model caught doing the thing self-report was supposed to
// catch" observability need, different failure mode.
export interface MechanicOfferBackstopCaughtProps {
  agentRunId: string
  venueId: string
  guestId: string
  mechanicId: string
  // The reply text that was caught — still queued for operator review (not
  // blanked, unlike the knowledge-gap backstop), safe to log here.
  replyBody: string
}

export async function captureMechanicOfferBackstopCaught(
  props: MechanicOfferBackstopCaughtProps,
): Promise<void> {
  await capturePostHogEvent('mechanic_offer_backstop_caught', props.guestId, { ...props })
  await postToSlack(formatMechanicOfferBackstopCaught(props))
}

function formatMechanicOfferBackstopCaught(props: MechanicOfferBackstopCaughtProps): string {
  const lines = [
    `*Mechanic offer caught without approval* — queued for review`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `mechanic: \`${props.mechanicId}\``,
    `flagged reply: "${truncate(props.replyBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ]
  return lines.join('\n')
}

export interface AgentLatencyHighProps {
  agentRunId: string
  venueId: string
  guestId: string
  totalElapsedMs: number
  kind: 'inbound' | 'followup'
  // Threaded through from the orchestrator's success path. inboundBody is
  // null for followups (no inbound). generatedBody is null on failure paths
  // that didn't reach a successful generation.
  inboundBody: string | null
  generatedBody: string | null
}

export async function captureAgentLatencyHigh(props: AgentLatencyHighProps): Promise<void> {
  await capturePostHogEvent('agent_latency_high', props.guestId, { ...props })
  await postToSlack(formatAgentLatencyHigh(props))
}

function formatAgentLatencyHigh(props: AgentLatencyHighProps): string {
  const seconds = (props.totalElapsedMs / 1000).toFixed(1)
  const lines = [
    `*Agent latency high* — ${seconds}s (${props.kind})`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
  ]
  if (props.inboundBody) {
    lines.push(`inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  if (props.generatedBody) {
    lines.push(`generated: "${truncate(props.generatedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  return lines.join('\n')
}

// TAC-212: emitted from the inbound + followup orchestrators when the
// approval-policy gate (applyApprovalPolicyStage in lib/agent/stages.ts)
// routes the draft to the operator queue instead of dispatching. Slack
// relay yes — pilot ops needs visibility into which drafts are landing in
// the queue and why. Mirrors the voice_fidelity_low / dash_violation_persisted
// shape (agentRunId + venue/guest IDs + the per-trigger metadata).
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
  voiceFidelity: number
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

export async function captureDraftQueued(props: DraftQueuedProps): Promise<void> {
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
    `category: \`${props.category}\` · fidelity: \`${props.voiceFidelity.toFixed(2)}\``,
    `slot: \`${props.slot}\`${props.otherSlotOccupied ? ' · second card for this guest' : ''}`,
  ]
  if (props.modelRequiresApproval && props.modelApprovalReason.length > 0) {
    lines.push(`model approval reason: "${truncate(props.modelApprovalReason, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  if (props.compRegexMatchedPattern) {
    lines.push(`comp regex matched: \`${props.compRegexMatchedPattern}\``)
  }
  if (props.inboundBody) {
    lines.push(`inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  lines.push(`draft: "${truncate(props.generatedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
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
  voiceFidelity: number
  modelRequiresApproval: boolean
  modelApprovalReason: string
  compRegexMatchedPattern: string | null
  kind: 'inbound' | 'followup'
  category: string
  inboundBody: string | null
  generatedBody: string
}

export async function captureDraftRegenerated(props: DraftRegeneratedProps): Promise<void> {
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
    `category: \`${props.category}\` · fidelity: \`${props.voiceFidelity.toFixed(2)}\``,
  ]
  if (props.modelRequiresApproval && props.modelApprovalReason.length > 0) {
    lines.push(`model approval reason: "${truncate(props.modelApprovalReason, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  if (props.compRegexMatchedPattern) {
    lines.push(`comp regex matched: \`${props.compRegexMatchedPattern}\``)
  }
  if (props.inboundBody) {
    lines.push(`inbound: "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
  }
  lines.push(`draft: "${truncate(props.generatedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`)
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
// disabling it should be loud in Slack. Fidelity-band / model-flagged-only
// bypasses stay PostHog-only so Slack doesn't drown in routine demo traffic
// (every mid-fidelity demo reply trips the fidelity band).
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
  voiceFidelity: number
  generatedBody: string
  // TAC-307. True when CATEGORY_REQUIRES_APPROVAL fired from a policy entry a
  // human set for this venue, rather than from the fleet-wide code default.
  // Drives the second Slack relay condition above. Optional so existing
  // callers and fixtures are unaffected; absent reads as "not explicit".
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
  await capturePostHogEvent('demo_bypassed_approval_gate', props.guestId, { ...props })
  const compBackstopBypassed = props.wouldHaveQueuedTriggers.includes(COMP_REGEX_BACKSTOP_TRIGGER)
  const explicitPolicyBypassed =
    props.policyHoldWasExplicit === true &&
    props.wouldHaveQueuedTriggers.includes(CATEGORY_REQUIRES_APPROVAL_TRIGGER)
  if (compBackstopBypassed || explicitPolicyBypassed) {
    await postToSlack(formatDemoBypassedApprovalGate(props, { compBackstopBypassed }))
  }
}

function formatDemoBypassedApprovalGate(
  props: DemoBypassedApprovalGateProps,
  opts: { compBackstopBypassed: boolean },
): string {
  const triggerList = props.wouldHaveQueuedTriggers.map((t) => `\`${t}\``).join(', ')
  const cause = opts.compBackstopBypassed
    ? 'comp regex backstop would have queued this draft'
    : "this venue's explicit approval policy would have queued this draft"
  return [
    `*Demo guest bypassed approval gate* — ${cause}`,
    `would-have-queued triggers: ${triggerList}`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `fidelity: \`${props.voiceFidelity.toFixed(2)}\``,
    `generated: "${truncate(props.generatedBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ].join('\n')
}

export interface WebhookSilenceProps {
  hoursWithoutWebhook: number
  lastWebhookAt: string
}

export async function captureWebhookSilence(props: WebhookSilenceProps): Promise<void> {
  // No guestId/venueId — system-level event. Use a stable distinctId so
  // aggregation in PostHog works.
  await capturePostHogEvent('webhook_silence', 'system:webhook-silence-cron', { ...props })
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
  const reasonList = props.wouldHaveDispatchedReasons.map((r) => `\`${r}\``).join(', ')
  return [
    `*Follow-up suppressed* — \`${props.suppressionReason}\` blocked: ${reasonList || '(no reasons)'}`,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
  ].join('\n')
}

export interface FollowupVenueBreakdown {
  venueId: string
  guestsEvaluated: number
  guestsDue: number
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
    venuesDispatching: number
    guestsEvaluated: number
    guestsDue: number
    guestsDispatched: number
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
  await capturePostHogEvent('followup_scan_complete', 'system:followup-engine', { ...props })
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
  await capturePostHogEvent('operator_message_approved', props.guestId, { ...props })
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
  await capturePostHogEvent('operator_message_edited', props.guestId, { ...props })
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
  await capturePostHogEvent('operator_message_skipped', props.guestId, { ...props })
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
  await capturePostHogEvent('operator_message_action_undone', props.guestId, { ...props })
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
  await capturePostHogEvent('operator_commitment_acknowledged', props.guestId, { ...props })
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
  await capturePostHogEvent('operator_draft_decline_initiated', props.guestId, { ...props })
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
  surface?: 'draft_flagged' | 'commitment_arrival'
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
  surface?: 'draft_flagged' | 'commitment_arrival'
}

export async function capturePushTokenInvalid(props: PushTokenInvalidProps): Promise<void> {
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
  | 'knowledge_gap_card_protected'
  | 'obligation_slot_taken'
  | 'slot_occupied'

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
export async function captureDraftDropped(props: DraftDroppedProps): Promise<void> {
  const { guestPhone, ...rest } = props
  await capturePostHogEvent('draft_dropped', props.guestId, {
    ...rest,
    guestPhoneLast4: phoneLast4(guestPhone),
  })
  await postToSlack(formatDraftDropped(props))
}

/** Exported for tests. */
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
  await capturePostHogEvent('manual_followup_slot_occupied', props.guestId, { ...props })
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
  await capturePostHogEvent('pending_slot_invariant_broken', props.guestId, { ...props })
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
  await capturePostHogEvent('crisis_safety_reply_sent', props.guestId, { ...props })
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
  await capturePostHogEvent('commitment_dedup_check_failed', props.guestId, { ...props })
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
