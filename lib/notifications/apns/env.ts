// APNs environment validation (TAC-207 follow-up).
//
// CLAUDE.md → "Environment variables → Boot-time validation" prescribes a
// startup validator that crashes loudly for every required env var, written
// after the 2026-05-27 incident where APNS_AUTH_KEY was pasted without its
// `-----END PRIVATE KEY-----` footer, signed nothing, and failed silently at
// the first push attempt nine hours after deploy. That validator was never
// implemented — getApnsJwt still parsed the key lazily on first send.
//
// WHY THIS IS FIRST-CALL, NOT MODULE-LOAD:
//
// .github/workflows/ci.yml sets ZERO APNS_* vars, and its env block comments
// that the codebase "reads env vars lazily inside functions (not at module
// load)". A module-init throw would crash `tsc`, `vitest`, and `next build`
// on the very next PR, and the only way to satisfy it in CI would be to
// commit a real PKCS#8 key to a workflow file. So validation runs at first
// call (sendApnsRequest) where it fails loudly into the [apns] logs and the
// PostHog push.sent errorDetail, and is ALSO surfaced ambiently on
// /admin/health so a misconfiguration is visible without waiting for a guest
// to text in.
//
// PRIVACY: every message names the variable and the defect. No value, no
// fragment of a value, no length of the key body is ever returned.

/** Vars required for any APNs push to succeed. */
export const REQUIRED_APNS_VARS = [
  'APNS_AUTH_KEY',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'APNS_ENV',
] as const

export type ApnsEnvCheck =
  | { ok: true }
  | { ok: false; problems: string[] }

/** Apple key/team identifiers are always exactly 10 characters. */
const APPLE_ID_LENGTH = 10

const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----'
const PKCS8_FOOTER = '-----END PRIVATE KEY-----'
const SEC1_HEADER = '-----BEGIN EC PRIVATE KEY-----'

/**
 * Validates the shape of APNS_AUTH_KEY without importing or logging it.
 * Ordered so the most specific, most-previously-seen defect wins — a bare
 * base64 body reports "missing header AND footer", not a vague parse error.
 */
function checkAuthKey(raw: string): string[] {
  const problems: string[] = []
  const value = raw.trim()

  if (value.startsWith('"') || value.startsWith("'")) {
    problems.push(
      'APNS_AUTH_KEY: value is wrapped in quote characters — paste the raw PEM, ' +
        'the env layer does not strip quotes',
    )
  }
  if (value.includes('\\n')) {
    problems.push(
      'APNS_AUTH_KEY: contains literal backslash-n escapes instead of real newlines — ' +
        'importPKCS8 needs a genuine multi-line PEM',
    )
  }
  if (value.includes(SEC1_HEADER)) {
    problems.push(
      'APNS_AUTH_KEY: is a SEC1 "EC PRIVATE KEY" block — Apple .p8 keys are PKCS#8 ' +
        `("${PKCS8_HEADER}"); this key was converted or is the wrong file`,
    )
    return problems
  }

  const hasHeader = value.includes(PKCS8_HEADER)
  const hasFooter = value.includes(PKCS8_FOOTER)
  if (!hasHeader && !hasFooter) {
    problems.push(
      'APNS_AUTH_KEY: missing both PEM armor lines — looks like a bare base64 body. ' +
        `Wrap it in "${PKCS8_HEADER}" / "${PKCS8_FOOTER}" lines`,
    )
  } else if (!hasFooter) {
    // The documented 2026-05-27 failure: truncated on paste.
    problems.push(
      `APNS_AUTH_KEY: missing the "${PKCS8_FOOTER}" footer — the value was likely ` +
        'truncated on paste',
    )
  } else if (!hasHeader) {
    problems.push(`APNS_AUTH_KEY: missing the "${PKCS8_HEADER}" header line`)
  }

  return problems
}

export type ApnsVar = (typeof REQUIRED_APNS_VARS)[number]

/** Vars getApnsJwt needs to sign a bearer token. */
export const JWT_APNS_VARS = ['APNS_AUTH_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID'] as const

/** Vars sendApnsRequest needs to address a request (topic + host). */
export const TRANSPORT_APNS_VARS = ['APNS_BUNDLE_ID', 'APNS_ENV'] as const

/**
 * Validates APNs env shape. Pure — reads the passed object (defaults to
 * process.env) at call time so tests and the health page can pass a stub.
 *
 * `vars` scopes the check to one layer's own variables. This matters: the
 * client mocks getApnsJwt in its tests and genuinely does not use the signing
 * key, so validating the full set inside sendApnsRequest would couple the
 * transport layer to credentials it never touches. Each layer validates what
 * it owns; the health page validates all five.
 *
 * Never throws, never returns key material.
 */
export function checkApnsEnv(
  env: Record<string, string | undefined> = process.env,
  vars: readonly ApnsVar[] = REQUIRED_APNS_VARS,
): ApnsEnvCheck {
  const problems: string[] = []
  const wanted = new Set<string>(vars)

  for (const name of vars) {
    const value = env[name]
    if (value === undefined || value.trim() === '') {
      problems.push(`${name}: not set`)
    }
  }

  const authKey = env.APNS_AUTH_KEY
  if (wanted.has('APNS_AUTH_KEY') && authKey !== undefined && authKey.trim() !== '') {
    problems.push(...checkAuthKey(authKey))
  }

  for (const name of ['APNS_KEY_ID', 'APNS_TEAM_ID'] as const) {
    if (!wanted.has(name)) continue
    const value = env[name]?.trim()
    if (value !== undefined && value !== '' && value.length !== APPLE_ID_LENGTH) {
      problems.push(
        `${name}: expected exactly ${APPLE_ID_LENGTH} characters, got ${value.length}`,
      )
    }
  }

  const apnsEnv = env.APNS_ENV?.trim()
  if (
    wanted.has('APNS_ENV') &&
    apnsEnv !== undefined &&
    apnsEnv !== '' &&
    apnsEnv !== 'production' &&
    apnsEnv !== 'sandbox'
  ) {
    problems.push(
      `APNS_ENV: must be 'production' or 'sandbox', got '${apnsEnv}'. ` +
        'A TestFlight or App Store build requires production; a Xcode dev build requires sandbox. ' +
        'A mismatch returns HTTP 400 BadDeviceToken and delivers nothing.',
    )
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}
