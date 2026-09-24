// TAC-516: the pure half of `npm run insert-instagram-credential`.
//
// Split out for the reason `scripts/lib/instagram-smoke.ts` is: the entry
// script opens a database connection and calls Meta at module scope, so its
// decisions cannot be tested through it. The two decisions that matter are
// here — how the arguments parse, and whether this venue is ALLOWED to take
// the account the token turns out to belong to.

import type { GraphFailure } from '@/lib/messaging/instagram/graph'

/** Parsed CLI arguments. `confirm` gates the one write. */
export type InsertArgs = {
  venueSlug: string
  confirm: boolean
  dryRun: boolean
  /** Only consulted when Meta refuses to refresh; never a default. */
  expiresAtOverride: Date | null
  operatorId: string | null
}

export type ParseArgsResult = { ok: true; args: InsertArgs } | { ok: false; error: string }

export function parseInsertArgs(argv: readonly string[]): ParseArgsResult {
  let venueSlug: string | null = null
  let confirm = false
  let dryRun = false
  let expiresAtOverride: Date | null = null
  let operatorId: string | null = null

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string | null => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return null
      i += 1
      return value
    }
    switch (arg) {
      case '--venue': {
        const value = next()
        if (value === null) return { ok: false, error: '--venue needs a slug' }
        venueSlug = value
        break
      }
      case '--confirm':
        confirm = true
        break
      case '--dry-run':
        dryRun = true
        break
      case '--operator': {
        const value = next()
        if (value === null) return { ok: false, error: '--operator needs a uuid' }
        operatorId = value
        break
      }
      case '--expires-at': {
        const value = next()
        if (value === null) return { ok: false, error: '--expires-at needs an ISO timestamp' }
        const parsed = new Date(value)
        if (Number.isNaN(parsed.getTime())) {
          return { ok: false, error: `--expires-at is not a date I can read: ${value}` }
        }
        expiresAtOverride = parsed
        break
      }
      default:
        return { ok: false, error: `unrecognised argument: ${arg}` }
    }
  }

  if (venueSlug === null) return { ok: false, error: '--venue is required' }
  return { ok: true, args: { venueSlug, confirm, dryRun, expiresAtOverride, operatorId } }
}

/**
 * What the venue row says about the account this token turns out to own.
 *
 * `holderVenueId` is the venue that currently has `instagram_account_id` set
 * to the token's account, or null when no venue does.
 */
export type AccountClaim = {
  targetVenueId: string
  /** venues.instagram_account_id on the TARGET venue, before this run. */
  targetAccountId: string | null
  /** Which venue (if any) already holds the token's account. */
  holderVenueId: string | null
  /** The account the token actually belongs to, per Meta. */
  tokenAccountId: string
}

export type AccountDecision =
  /** Nothing else claims it, and the target is unset — point it at this account. */
  | { action: 'claim' }
  /** The target already names this exact account. Nothing to point. */
  | { action: 'already_pointed' }
  /** Refuse, with the reason a person needs to act on. */
  | { action: 'refuse'; reason: string }

/**
 * THE CROSS-VENUE RULE (ruled 2026-09-23, question 1), applied to the hand
 * insert rather than to the OAuth callback — the same rule has to hold on both
 * doors, or the hand path becomes the way to get around it.
 *
 * It refuses in BOTH directions, and the second is the one that is easy to
 * miss: another venue holding this account is the obvious conflict, but a
 * target venue already pointed at a DIFFERENT account is just as wrong — it
 * would leave the venue routing inbound from one account while sending with a
 * credential for another, which is the split-brain the single
 * `venues.instagram_account_id` column exists to make impossible.
 */
export function decideAccountClaim(claim: AccountClaim): AccountDecision {
  const { targetVenueId, targetAccountId, holderVenueId, tokenAccountId } = claim

  if (holderVenueId !== null && holderVenueId !== targetVenueId) {
    return {
      action: 'refuse',
      reason:
        `Instagram account ${tokenAccountId} is already connected to a different venue ` +
        `(${holderVenueId}). Moving an account between venues is a deliberate, separate ` +
        `action — this script will not do it as a side effect.`,
    }
  }

  if (targetAccountId !== null && targetAccountId !== tokenAccountId) {
    return {
      action: 'refuse',
      reason:
        `This venue is pointed at Instagram account ${targetAccountId}, but the token in ` +
        `INSTAGRAM_ACCESS_TOKEN belongs to ${tokenAccountId}. Storing it would leave the ` +
        `venue receiving on one account and sending on another. Check which token you meant.`,
    }
  }

  return targetAccountId === null ? { action: 'claim' } : { action: 'already_pointed' }
}

/**
 * A Meta failure, in words, for a person reading a terminal.
 *
 * A TOTAL switch rather than a template over `failure.httpStatus`, which only
 * two of the four members carry — the naive version does not compile, and the
 * version that casts around it prints "HTTP undefined" on a timeout. A fifth
 * reason fails `tsc` here rather than degrading to something vague.
 *
 * It renders CODES only, never Meta's own error message, which quotes the
 * object it failed on — the same rule `lib/messaging/instagram/graph.ts`
 * keeps, for the same reason.
 */
export function describeGraphFailure(failure: GraphFailure): string {
  switch (failure.reason) {
    case 'timeout':
      return 'the request to Meta timed out'
    case 'network':
      return `the request to Meta failed (${failure.errorName}${failure.causeCode ? `, ${failure.causeCode}` : ''})`
    case 'graph_error':
      return (
        `Meta refused it (HTTP ${failure.httpStatus}` +
        `${failure.code === null ? '' : `, code ${failure.code}`}` +
        `${failure.subcode === null ? '' : `/${failure.subcode}`})`
      )
    case 'malformed_response':
      return `Meta answered HTTP ${failure.httpStatus} in a shape this code could not read`
  }
}
