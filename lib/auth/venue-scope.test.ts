// TAC-530. The three-way that the old `allowedVenueIds: string[]` could not
// express: fleet-wide, a real grant list, and a grant list that is EMPTY.
//
// Under the old shape the first and third were the same value, and which one
// it meant depended on which auth path produced it. Every assertion below is
// about keeping them apart.

import { describe, expect, it } from 'vitest'

import {
  ALL_VENUES,
  adminVenueScope,
  allowsVenue,
  bearerAllowsVenue,
  grantedVenues,
  venueFilterIds,
  venueScopeDeniesAll,
  type VenueScope,
} from './venue-scope'

const VENUE_A = '00000000-0000-0000-0000-00000000000a'
const VENUE_B = '00000000-0000-0000-0000-00000000000b'

describe('allowsVenue', () => {
  it('allows any venue when the scope is fleet-wide', () => {
    expect(allowsVenue(ALL_VENUES, VENUE_A)).toBe(true)
    expect(allowsVenue(ALL_VENUES, VENUE_B)).toBe(true)
  })

  it('allows only the granted venues', () => {
    const scope = grantedVenues([VENUE_A])
    expect(allowsVenue(scope, VENUE_A)).toBe(true)
    expect(allowsVenue(scope, VENUE_B)).toBe(false)
  })

  // THE ONE THAT MATTERS. Under the old shape this input was byte-identical
  // to the fleet-wide one, and four call sites read it as such.
  it('allows NOTHING when the grant list is empty', () => {
    expect(allowsVenue(grantedVenues([]), VENUE_A)).toBe(false)
    expect(allowsVenue(grantedVenues([]), VENUE_B)).toBe(false)
  })

  it('distinguishes an empty grant list from fleet-wide', () => {
    expect(allowsVenue(grantedVenues([]), VENUE_A)).not.toBe(
      allowsVenue(ALL_VENUES, VENUE_A),
    )
  })
})

// TAC-530, found in code review. The operator API is bearer-only and never
// legitimately receives a fleet-wide scope, but allowsVenue returns TRUE for
// one -- so a bearer helper using it would grant the whole fleet against a
// scope that only the cookie path can produce. Unreachable today; expressible
// with no compile error, which is the thing the union exists to stop.
describe('bearerAllowsVenue', () => {
  it('agrees with allowsVenue on every scope a bearer can actually hold', () => {
    for (const scope of [grantedVenues([]), grantedVenues([VENUE_A])]) {
      for (const venue of [VENUE_A, VENUE_B]) {
        expect(bearerAllowsVenue(scope, venue)).toBe(allowsVenue(scope, venue))
      }
    }
  })

  // THE DIFFERENCE, and the whole reason the second function exists.
  it('REFUSES a fleet-wide scope where allowsVenue allows it', () => {
    expect(allowsVenue(ALL_VENUES, VENUE_A)).toBe(true)
    expect(bearerAllowsVenue(ALL_VENUES, VENUE_A)).toBe(false)
  })
})

describe('venueScopeDeniesAll', () => {
  it('is true only for an empty grant list', () => {
    expect(venueScopeDeniesAll(grantedVenues([]))).toBe(true)
    expect(venueScopeDeniesAll(grantedVenues([VENUE_A]))).toBe(false)
    // Fleet-wide is the opposite of a deny, and it is also expressed by a
    // scope carrying no ids. Conflating the two is the original defect.
    expect(venueScopeDeniesAll(ALL_VENUES)).toBe(false)
  })
})

describe('venueFilterIds', () => {
  it('returns null for fleet-wide, meaning apply no filter', () => {
    expect(venueFilterIds(ALL_VENUES)).toBeNull()
  })

  it('returns the ids for a grant list', () => {
    expect(venueFilterIds(grantedVenues([VENUE_A, VENUE_B]))).toEqual([VENUE_A, VENUE_B])
  })

  // A caller that skips venueScopeDeniesAll gets an empty filter, which
  // matches no rows. Asserted because it is the reason forgetting the guard
  // is now safe: the failure direction is a deny, not a fleet grant.
  it('returns an empty list, NOT null, for an empty grant list', () => {
    const ids = venueFilterIds(grantedVenues([]))
    expect(ids).not.toBeNull()
    expect(ids).toEqual([])
  })
})

describe('adminVenueScope — the cookie path translation', () => {
  it('is fleet-wide for an admin with no explicit grants', () => {
    expect(adminVenueScope([])).toEqual({ kind: 'all_venues' })
  })

  it('restricts an admin who does have grants', () => {
    expect(adminVenueScope([VENUE_A])).toEqual({ kind: 'venues', ids: [VENUE_A] })
  })

  // The two constructors are handed the SAME input and must disagree. This is
  // the entire semantic difference between the two auth paths, in one place
  // instead of spread across fourteen call sites as a comment.
  it('disagrees with grantedVenues on an empty list, which is the whole point', () => {
    expect(adminVenueScope([])).not.toEqual(grantedVenues([]))
    expect(allowsVenue(adminVenueScope([]), VENUE_A)).toBe(true)
    expect(allowsVenue(grantedVenues([]), VENUE_A)).toBe(false)
  })
})

describe('the union is total', () => {
  // Not a behavioural claim — a structural one. Every helper switches on
  // `kind` with no default, so a third arm fails to compile in venue-scope.ts
  // rather than falling through silently at a call site. This test records
  // the two arms that exist so adding one is a deliberate edit here too.
  it('has exactly two arms', () => {
    const arms: Array<VenueScope['kind']> = ['all_venues', 'venues']
    expect(arms).toEqual(['all_venues', 'venues'])
  })
})

// ---------------------------------------------------------------------------
// SOURCE-LEVEL GUARD.
//
// The property this ticket bought is a COMPILE-TIME one: the pasted idiom must
// not typecheck. Verified by mutation at build time -- both of these fail tsc:
//
//   operator.venueScope.ids.length > 0   TS2339: 'ids' does not exist on VenueScope
//   operator.allowedVenueIds             TS2339: does not exist on AuthenticatedOperator
//
// But narrowing on `kind` is legal TypeScript, so this typechecks:
//
//   if (scope.kind !== 'venues') return
//   const { ids } = scope
//   if (ids.length > 0) apply(ids)      // the original bug, one clause later
//
// A code reviewer PROVED the first version of this guard missed exactly that,
// by dropping such a file into lib/operator/ and watching all 15 tests pass
// and tsc stay clean. It also missed `scope['ids']` and a renamed local. This
// version bans the property access, the destructure and the bracket form, in
// any file that handles a scope at all.
//
// WHAT IT STILL DOES NOT CATCH, stated rather than left to be discovered: a
// caller that length-tests venueFilterIds' RESULT before applying the filter --
//
//   const ids = venueFilterIds(scope)
//   if (ids !== null && ids.length > 0) q = q.in('venue_id', ids)
//
// -- has no `.ids` in it and typechecks. That restores the fleet grant for a
// grantless bearer. The bearer-path routes all deny on BOTH branches instead,
// and the helpers refuse rather than skip, but nothing mechanical enforces it.
// Per this repo's own rule, a source-level guard catches only the spellings it
// was written against.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..')
const SCANNED_DIRS = ['lib', 'app', 'scripts']
/** venue-scope.ts IS the narrowing; it is the one place allowed to read `.ids`. */
const NARROWING_OWNER = join('lib', 'auth', 'venue-scope.ts')

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'sandbox') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Files that handle a venue scope at all. Scoped this way rather than
 * repo-wide because unrelated code legitimately spreads a local `ids` array
 * (lib/messaging/instagram/refresh-profile.ts, lib/ai/verify-mechanic-offer.ts)
 * and a blanket ban would flag those.
 */
function scopeHandlingFiles(): Array<{ path: string; text: string }> {
  return SCANNED_DIRS.flatMap((d) => sourceFiles(join(REPO_ROOT, d)))
    .filter((f) => !f.endsWith(NARROWING_OWNER))
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
    .filter(({ text }) => /venueScope|VenueScope/.test(text))
}

describe('venue scope is read through the helpers, not by reaching into an arm', () => {
  const files = scopeHandlingFiles()

  // Guard the guard: a scan that silently found nothing would pass forever.
  it('finds the files that handle a scope', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it.each([
    ['a property access', /\.\s*ids\b/],
    ['a destructure', /\{[^}\n]*\bids\b[^}\n]*\}\s*=/],
    ['bracket access', /\[\s*['"]ids['"]\s*\]/],
  ])('no scope-handling file reads `ids` by %s', (_label, pattern) => {
    const offenders = files
      .filter(({ text }) => pattern.test(text))
      .map(({ path }) => path.slice(REPO_ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  // The old field name must not come back on either auth path. It is still
  // legal prose in a comment, so only a property access or destructure counts.
  it.each([
    ['a property access', /\.\s*allowedVenueIds\b/],
    ['a destructure', /\{[^}\n]*\ballowedVenueIds\b[^}\n]*\}\s*=/],
  ])('no source file reads `allowedVenueIds` by %s', (_label, pattern) => {
    const all = SCANNED_DIRS.flatMap((d) => sourceFiles(join(REPO_ROOT, d)))
    const offenders = all
      .filter((f) => !f.endsWith(join('lib', 'notifications', 'recipients.ts')))
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(REPO_ROOT.length + 1))
    expect(offenders).toEqual([])
  })
})
