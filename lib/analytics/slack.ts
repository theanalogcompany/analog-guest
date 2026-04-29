// Slack incoming-webhook primitive. Leaf module; imports nothing from
// lib/agent or other consumers. Owned by lib/analytics so the agent layer
// and the analytics event helpers (lib/analytics/posthog.ts) both consume
// from a single source of truth.
//
// Configure via SLACK_ALERTS_WEBHOOK_URL. Different webhooks for dev vs prod
// channels: set in .env.local for dev, Vercel project env vars for prod.
// Leaving the env var unset is supported — the function logs a warning and
// returns without sending.

/**
 * Truncate a string to at most `max` characters. If the string is longer,
 * cut to (max) and append a single ellipsis character.
 *
 * Used by event formatters to keep Slack message bodies under the 4000-char
 * Slack text limit, even with long inbound or generated message text.
 * Exported so all formatters share the same convention.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

/**
 * Post a message to the configured Slack webhook. Plain `text`-field payload
 * (no block kit) — matches the format the existing fireRedAlert flow uses.
 *
 * Never throws. Slack outages, missing config, and non-2xx responses are all
 * logged via console.warn / console.error so an alerting outage cannot
 * cascade into the orchestrator.
 */
export async function postToSlack(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_ALERTS_WEBHOOK_URL
  if (!webhookUrl) {
    console.warn('alert: SLACK_ALERTS_WEBHOOK_URL not set; skipping slack')
    return
  }
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) {
      console.error('alert: slack webhook returned non-2xx', { status: response.status })
    }
  } catch (e) {
    console.error('alert: slack webhook failed', {
      error: e instanceof Error ? e.message : String(e),
    })
  }
}