// Pure helper for the /admin/health APNs row. Mirrors check-langfuse.ts:
// reads process.env at call time, returns a CheckRow shape, never throws.
//
// WHY THIS EXISTS: the APNs push path is fire-and-forget through waitUntil and
// errors-as-values, so a broken configuration produces NO user-visible signal —
// the agent runs normally, drafts queue normally, and the push simply never
// arrives. CLAUDE.md → "Common gotchas → APNs env vars fail SILENTLY" documents
// the diagnostic chain that follows, which today starts with reading PostHog
// minutes after the fact. This row makes the same information ambient.
//
// What this does NOT verify: that the key is valid for the Apple team, that
// the bundle ID matches a real app, that APNs is reachable, or that any push
// has ever been delivered. It validates SHAPE only. Confirm real delivery with
// the manual E2E pass — send an inbound that queues a draft and watch for the
// `[apns] apns response` log line.

import { checkApnsEnv, REQUIRED_APNS_VARS } from '@/lib/notifications/apns/env'

export interface CheckApnsRow {
  label: 'APNs push'
  detail: string
  tone: 'good' | 'neutral' | 'bad'
}

type EnvLike = Record<string, string | undefined>

export function checkApns(env: EnvLike = process.env): CheckApnsRow {
  const anySet = REQUIRED_APNS_VARS.some((name) => (env[name]?.trim() ?? '') !== '')

  // 1. Not configured — no APNS_* var touched at all. Local dev / no-op;
  //    the push helpers return early with error='env_missing' and the agent
  //    path is unaffected. Neutral, matching check-langfuse's posture.
  if (!anySet) {
    return {
      label: 'APNs push',
      detail: 'Not configured (no APNS_* env vars set — local dev / no-op mode)',
      tone: 'neutral',
    }
  }

  // 2. Misconfigured — partially set or malformed. Surface EVERY problem, not
  //    just the first: a truncated key and a wrong APNS_ENV are independent
  //    faults and fixing one at a time costs a deploy cycle each.
  const result = checkApnsEnv(env)
  if (!result.ok) {
    return {
      label: 'APNs push',
      detail: `Misconfigured — ${result.problems.join(' · ')}`,
      tone: 'bad',
    }
  }

  // 3. Active. Show the host the env selects and the key/team ids — these are
  //    public identifiers, not secrets. The key body is never surfaced.
  const apnsEnv = env.APNS_ENV?.trim()
  const host = apnsEnv === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'
  const buildKind = apnsEnv === 'production' ? 'TestFlight / App Store' : 'Xcode dev'
  return {
    label: 'APNs push',
    detail:
      `Active — ${host} (${apnsEnv}, expects a ${buildKind} build) · ` +
      `key ${env.APNS_KEY_ID?.trim()} · team ${env.APNS_TEAM_ID?.trim()} · ` +
      `topic ${env.APNS_BUNDLE_ID?.trim()} · delivery unconfirmed`,
    tone: 'good',
  }
}
