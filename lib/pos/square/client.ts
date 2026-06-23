// Square SDK construction. Internal to the Square provider — do NOT import
// from outside lib/pos/square/; consumers use the PosProvider interface
// (lib/pos/types.ts) via the registry.
//
// Construction is lazy (per call), not at module load: the Square client is
// only built when a credential is in hand. This mirrors createAdminClient
// (lib/db/admin.ts) and getCredentials (lib/messaging/sendblue-client.ts) and
// keeps the module vitest-safe — importing this file never constructs a
// client, so tests that touch the provider don't need real env.

import { SquareClient, SquareEnvironment } from 'square'

export type SquareEnv = 'sandbox' | 'production'

/**
 * Normalize the SQUARE_ENV value. Defaults to 'sandbox' when unset/empty so a
 * misconfigured environment never silently points at production. Throws on an
 * unrecognized value rather than guessing.
 */
export function resolveSquareEnv(raw: string | undefined): SquareEnv {
  if (raw === undefined || raw === '' || raw === 'sandbox') return 'sandbox'
  if (raw === 'production') return 'production'
  throw new Error(`Invalid SQUARE_ENV: "${raw}" (expected 'sandbox' | 'production')`)
}

function toSquareEnvironment(env: SquareEnv): SquareEnvironment {
  return env === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox
}

/**
 * Build a Square client for a specific access token + environment. Used with
 * per-merchant tokens once pos_credentials is wired (migration 030).
 */
export function createSquareClient(token: string, env: SquareEnv): SquareClient {
  return new SquareClient({ token, environment: toSquareEnvironment(env) })
}

/**
 * Build a Square client from the MVP single-merchant env vars. SQUARE_ENV
 * selects which token to read — SQUARE_SANDBOX_ACCESS_TOKEN or
 * SQUARE_PRODUCTION_ACCESS_TOKEN — so the same deploy can carry both and flip
 * environments without renaming a var. Throws on a missing token: this is
 * construction/setup, not a per-request path, so a loud failure at the outer
 * boundary is correct (matches the messaging + db client patterns).
 *
 * Per-merchant OAuth tokens supersede this once pos_credentials is wired
 * (migration 030); this env path is the single-merchant MVP bootstrap.
 */
export function squareAccessTokenFromEnv(): { token: string; env: SquareEnv } {
  const env = resolveSquareEnv(process.env.SQUARE_ENV)
  const tokenVar =
    env === 'production' ? 'SQUARE_PRODUCTION_ACCESS_TOKEN' : 'SQUARE_SANDBOX_ACCESS_TOKEN'
  const token = process.env[tokenVar]
  if (!token) throw new Error(`Missing env var: ${tokenVar}`)
  return { token, env }
}

export function squareClientFromEnv(): { client: SquareClient; env: SquareEnv } {
  const { token, env } = squareAccessTokenFromEnv()
  return { client: createSquareClient(token, env), env }
}
