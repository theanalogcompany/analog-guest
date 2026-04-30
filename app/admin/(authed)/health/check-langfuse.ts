// Pure helper for the /admin/health Langfuse row. Extracted from page.tsx so
// it's directly testable without rendering the server component (mirrors the
// verify-analog-admin pattern). Reads process.env at call time; returns a
// CheckRow shape consumed by the page.
//
// Detects four distinct operator-facing states. Order matters: the explicit
// "disabled" intent dominates over "missing key" misconfigurations.
//
//   1. Not configured     — no LANGFUSE_* env vars set. Local dev / no-op.
//                           tone='neutral'.
//   2. Disabled           — LANGFUSE_ENABLED=false set explicitly, even
//                           when keys are present. tone='neutral'.
//   3. Misconfigured      — some keys present but not all, OR host missing,
//                           OR host not in the allowlist of known cloud
//                           values. Surfaces the SPECIFIC reason — this is
//                           the case THE-200's stub missed.
//                           tone='bad'.
//   4. Active             — all keys present, host known, not disabled.
//                           tone='good'.
//
// Note: only three StatusDot tones exist (good/neutral/bad). "Not configured"
// and "Disabled" both share neutral; the detail text differentiates them.
//
// What this does NOT verify: that the keys are valid for the project, that
// the network path is open, or that traces are arriving. Operators must
// confirm a live trace appears in Langfuse after a real iMessage exchange.

export interface CheckLangfuseRow {
  label: 'Langfuse'
  detail: string
  tone: 'good' | 'neutral' | 'bad'
}

export const KNOWN_LANGFUSE_HOSTS = [
  'https://us.cloud.langfuse.com',
  'https://cloud.langfuse.com',
] as const

// Parameter is the runtime shape of process.env (string-or-undefined keyed by
// var name). Typed loosely (not as NodeJS.ProcessEnv) so tests can pass small
// synthetic env objects without satisfying the @types/node `NODE_ENV` constraint.
type EnvLike = Record<string, string | undefined>

export function checkLangfuse(env: EnvLike = process.env): CheckLangfuseRow {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim() ?? ''
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim() ?? ''
  // Match the wrapper's alias logic in lib/observability/langfuse.ts:
  // BASE_URL preferred, HOST accepted as legacy alias.
  const host =
    env.LANGFUSE_BASE_URL?.trim() || env.LANGFUSE_HOST?.trim() || ''
  const enabled = env.LANGFUSE_ENABLED?.trim() ?? ''

  // 1. Not configured — operator hasn't touched any Langfuse env. No-op mode
  //    is appropriate here (local dev). Don't flag as a problem.
  if (!publicKey && !secretKey && !host) {
    return {
      label: 'Langfuse',
      detail: 'Not configured (no LANGFUSE_* env vars set — local dev / no-op mode)',
      tone: 'neutral',
    }
  }

  // 2. Disabled — explicit intent dominates. Even fully-configured envs are
  //    treated as intentionally off when LANGFUSE_ENABLED='false'.
  if (enabled === 'false') {
    return {
      label: 'Langfuse',
      detail: 'Disabled — unset LANGFUSE_ENABLED to re-enable',
      tone: 'neutral',
    }
  }

  // 3. Misconfigured — some keys present, others not, or host invalid.
  //    Surfaces the specific reason so the operator knows what to fix.
  const missing: string[] = []
  if (!publicKey) missing.push('LANGFUSE_PUBLIC_KEY')
  if (!secretKey) missing.push('LANGFUSE_SECRET_KEY')
  if (!host) missing.push('LANGFUSE_BASE_URL (or LANGFUSE_HOST)')
  if (missing.length > 0) {
    const detail =
      missing.length === 1
        ? `Misconfigured — missing ${missing[0]}`
        : `Misconfigured — missing ${missing.join(' and ')}`
    return { label: 'Langfuse', detail, tone: 'bad' }
  }

  if (!KNOWN_LANGFUSE_HOSTS.includes(host as (typeof KNOWN_LANGFUSE_HOSTS)[number])) {
    return {
      label: 'Langfuse',
      detail: `Misconfigured — unrecognized host: ${host} (expected ${KNOWN_LANGFUSE_HOSTS.join(' or ')})`,
      tone: 'bad',
    }
  }

  // 4. Active. Show host + key prefix so the operator can confirm at a glance
  //    which project they're pointed at. "traces unconfirmed" is honest:
  //    this check doesn't verify keys are valid or traces are arriving.
  const keyPrefix = publicKey.slice(0, 8)
  return {
    label: 'Langfuse',
    detail: `Active — ${host} (${keyPrefix}…), traces unconfirmed`,
    tone: 'good',
  }
}
