import { PostHog } from 'posthog-node'

export interface AlertContext {
  agentRunId: string
  venueId: string
  guestId?: string
  kind: 'inbound' | 'followup'
  stage:
    | 'context_build'
    | 'classification'
    | 'corpus'
    | 'generation'
    | 'send'
    | 'persist'
    | 'venue_config_integrity'
  errorCode?: string
  errorMessage?: string
  errorStack?: string
  extra?: Record<string, unknown>
}

let postHogClient: PostHog | null = null

function getPostHog(): PostHog {
  if (postHogClient) return postHogClient
  // PostHog project tokens are write-only and safe to expose in client bundles,
  // so the project standardizes on the NEXT_PUBLIC_ prefix even for this
  // server-side reader. Server reads via process.env still work as normal.
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  if (!apiKey) throw new Error('Missing env var: NEXT_PUBLIC_POSTHOG_KEY')
  postHogClient = new PostHog(apiKey, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
  })
  return postHogClient
}

function formatSlackMessage(context: AlertContext): string {
  const lines = [
    `*Agent failure* — ${context.kind} stage: \`${context.stage}\``,
    `venue: \`${context.venueId}\``,
    `guest: \`${context.guestId ?? '—'}\``,
    `run: \`${context.agentRunId}\``,
    `error: ${context.errorMessage ?? '—'}`,
  ]
  if (context.errorCode) {
    lines.push(`code: \`${context.errorCode}\``)
  }
  if (context.extra && Object.keys(context.extra).length > 0) {
    lines.push(`extra: \`${JSON.stringify(context.extra)}\``)
  }
  return lines.join('\n')
}

/**
 * Fire a "red alert" for an agent-orchestrator failure: a PostHog event for
 * product analytics + a Slack message for on-call visibility.
 *
 * Server-only. Used by lib/agent/handle-inbound and lib/agent/handle-followup
 * on every fail-closed branch. Never throws — alerting failures are logged via
 * console.error and swallowed so they cannot cascade into the orchestrator.
 *
 * The PostHog event name is derived from `context.kind`:
 *   - 'inbound'  → 'inbound_message_failed'
 *   - 'followup' → 'followup_message_failed'
 *
 * Slack delivery is best-effort: if SLACK_ALERTS_WEBHOOK_URL is not set, this
 * function logs a warning and skips Slack without throwing.
 */
export async function fireRedAlert(context: AlertContext): Promise<void> {
  const eventName =
    context.kind === 'followup' ? 'followup_message_failed' : 'inbound_message_failed'

  try {
    getPostHog().capture({
      distinctId: context.guestId ?? context.agentRunId,
      event: eventName,
      properties: {
        agentRunId: context.agentRunId,
        venueId: context.venueId,
        guestId: context.guestId,
        kind: context.kind,
        stage: context.stage,
        errorCode: context.errorCode,
        errorMessage: context.errorMessage,
        errorStack: context.errorStack,
        ...context.extra,
        ts: new Date().toISOString(),
      },
    })
  } catch (e) {
    console.error('alert: posthog capture failed', {
      agentRunId: context.agentRunId,
      error: e instanceof Error ? e.message : String(e),
    })
  }

  const webhookUrl = process.env.SLACK_ALERTS_WEBHOOK_URL
  if (!webhookUrl) {
    console.warn('alert: SLACK_ALERTS_WEBHOOK_URL not set; skipping slack', {
      agentRunId: context.agentRunId,
      stage: context.stage,
    })
    return
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: formatSlackMessage(context) }),
    })
    if (!response.ok) {
      console.error('alert: slack webhook returned non-2xx', {
        agentRunId: context.agentRunId,
        status: response.status,
      })
    }
  } catch (e) {
    console.error('alert: slack webhook failed', {
      agentRunId: context.agentRunId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Capture a non-failure PostHog event (success, skip, etc.). Same lazy-init
 * client as fireRedAlert. Never throws — failures are logged via
 * console.error so an analytics outage cannot cascade into the orchestrator.
 *
 * Used by lib/agent/handle-inbound and handle-followup for events like
 * inbound_message_handled, inbound_message_skipped, followup_message_handled.
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