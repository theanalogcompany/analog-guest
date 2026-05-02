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
 *     Fires when classifierConfidence < 0.7.
 *     Properties: { agentRunId, venueId, guestId, category,
 *                   classifierConfidence, inboundLength, inboundBody }
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
 * - webhook_silence
 *     Daily cron event. Fires when no inbound webhook has landed in 24+
 *     hours, but only when there's been at least one prior inbound (i.e.,
 *     skipped on initial venue state). Filtered to non-test venues.
 *     Properties: { hoursWithoutWebhook, lastWebhookAt }
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
}

export async function captureClassificationLowConfidence(
  props: ClassificationLowConfidenceProps,
): Promise<void> {
  await capturePostHogEvent('classification_low_confidence', props.guestId, { ...props })
  await postToSlack(formatClassificationLowConfidence(props))
}

function formatClassificationLowConfidence(props: ClassificationLowConfidenceProps): string {
  return [
    `*Classification low confidence* — \`${props.classifierConfidence.toFixed(2)}\` for category \`${props.category}\``,
    `venue: \`${props.venueId}\``,
    `guest: \`${props.guestId}\``,
    `run: \`${props.agentRunId}\``,
    `inbound (${props.inboundLength} chars): "${truncate(props.inboundBody, SLACK_FIELD_TRUNCATE_CHARS)}"`,
  ].join('\n')
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