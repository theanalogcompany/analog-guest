/**
 * Shape validation for the Jev (TypeSafe) credential, per the repo rule that a
 * new credential var ships with its validator in the same PR. The var is
 * `JEV_API_KEY` - the operator's chosen name, model-first like the product.
 *
 * Three parts, same as APNs (`lib/notifications/apns/env.ts`):
 *   1. This pure shape validator, which NEVER returns key material - problems
 *      name the var and the defect, never the value.
 *   2. First-call enforcement in `classify-message-jev.ts` (NOT module-load:
 *      CI sets no JEV_* vars, so a module-init throw would break tsc,
 *      and next build).
 *   3. An /admin/health row (`check-typesafe.ts`).
 *
 * The key format is `apikey_<hex>_<hex>`. The checks here are deliberately
 * loose - prefix, length, no embedded whitespace - because the real test of a
 * key is the 401 the API returns, and a validator that over-fits the vendor's
 * current format breaks on their next rotation scheme.
 */

export const REQUIRED_TYPESAFE_VARS = ['JEV_API_KEY'] as const

export type TypesafeEnvCheck = { ok: true } | { ok: false; problems: string[] }

const KEY_PREFIX = 'apikey_'
const MIN_KEY_LENGTH = 40

type EnvLike = Record<string, string | undefined>

export function checkTypesafeEnv(env: EnvLike = process.env): TypesafeEnvCheck {
  const problems: string[] = []
  const raw = env.JEV_API_KEY

  if (raw === undefined || raw.trim() === '') {
    problems.push('JEV_API_KEY: missing or empty')
  } else {
    const key = raw.trim()
    if (!key.startsWith(KEY_PREFIX)) {
      problems.push(`JEV_API_KEY: does not start with "${KEY_PREFIX}"`)
    }
    if (key.length < MIN_KEY_LENGTH) {
      problems.push(`JEV_API_KEY: shorter than ${MIN_KEY_LENGTH} characters`)
    }
    if (/\s/.test(key)) {
      problems.push('JEV_API_KEY: contains whitespace')
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}
