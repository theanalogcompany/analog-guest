/**
 * Shape validation for the Kimi (Moonshot) credential, per the repo rule that
 * a new credential var ships with its validator in the same PR.
 *
 * Three parts, same as Jev (`lib/ai/typesafe-env.ts`) and APNs
 * (`lib/notifications/apns/env.ts`):
 *   1. This pure shape validator, which NEVER returns key material - problems
 *      name the var and the defect, never the value.
 *   2. First-call enforcement in `getJudgeModel()` (NOT module-load: CI sets
 *      no KIMI_* vars, so a module-init throw would break tsc and next build).
 *   3. An /admin/health row (`check-kimi.ts`).
 *
 * The key format is `sk-<alnum>`. Checks are deliberately loose - prefix,
 * length, no embedded whitespace - because the real test of a key is the 401
 * the API returns, and a validator that over-fits the vendor's current format
 * breaks on their next rotation scheme.
 *
 * `KIMI_BASE_URL` is optional and defaults to the public endpoint; it exists
 * so the China-region host can be swapped in without a deploy.
 */

export const REQUIRED_KIMI_VARS = ['KIMI_API_KEY'] as const

export const DEFAULT_KIMI_BASE_URL = 'https://api.moonshot.ai/v1'

export type KimiEnvCheck = { ok: true } | { ok: false; problems: string[] }

const KEY_PREFIX = 'sk-'
const MIN_KEY_LENGTH = 32

type EnvLike = Record<string, string | undefined>

export function checkKimiEnv(env: EnvLike = process.env): KimiEnvCheck {
  const problems: string[] = []
  const raw = env.KIMI_API_KEY

  if (raw === undefined || raw.trim() === '') {
    problems.push('KIMI_API_KEY: missing or empty')
  } else {
    const key = raw.trim()
    if (!key.startsWith(KEY_PREFIX)) {
      problems.push(`KIMI_API_KEY: does not start with "${KEY_PREFIX}"`)
    }
    if (key.length < MIN_KEY_LENGTH) {
      problems.push(`KIMI_API_KEY: shorter than ${MIN_KEY_LENGTH} characters`)
    }
    if (/\s/.test(key)) {
      problems.push('KIMI_API_KEY: contains whitespace')
    }
  }

  const base = env.KIMI_BASE_URL
  if (base !== undefined && base.trim() !== '') {
    try {
      new URL(base.trim())
    } catch {
      problems.push('KIMI_BASE_URL: not a valid URL')
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}
