// PostHog primitive lives in lib/analytics/posthog.ts (the leaf module).
// This file owns the agent-flavored failure surface: fireRedAlert pairs a
// PostHog event with a Slack notification for on-call visibility.
import { capturePostHogEvent } from '@/lib/analytics/posthog'

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

  await capturePostHogEvent(eventName, context.guestId ?? context.agentRunId, {
    agentRunId: context.agentRunId,
    venueId: context.venueId,
    guestId: context.guestId,
    kind: context.kind,
    stage: context.stage,
    errorCode: context.errorCode,
    errorMessage: context.errorMessage,
    errorStack: context.errorStack,
    ...context.extra,
  })

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

// Re-export so existing callers (handle-inbound / handle-followup) don't
// need to import from two places.
export { capturePostHogEvent } from '@/lib/analytics/posthog'