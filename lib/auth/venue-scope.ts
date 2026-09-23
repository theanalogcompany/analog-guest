// Which venues an authenticated principal may act on (TAC-530).
//
// THE DEFECT THIS TYPE EXISTS TO RETIRE. Both auth paths used to carry the
// same `allowedVenueIds: string[]`, and an EMPTY array meant opposite things
// on each:
//
//   - COOKIE path (verifyAnalogAdminAccess): throws 403 unless
//     is_analog_admin is true BEFORE it builds the array, so empty means "an
//     analog admin with no explicit grants" — i.e. every venue. The correct
//     idiom there was `if (ids.length > 0) applyFilter()`.
//   - BEARER path (verifyOperatorRequest): builds the array from the
//     operator's literal operator_venues rows with no admin lookup anywhere,
//     so empty means "allowlisted for nothing" — i.e. no venue.
//
// Fourteen correct cookie-path sites wrote `length > 0 &&`, which made it the
// obvious idiom to reach for, and it was pasted onto bearer data at four call
// sites. There it skipped the filter entirely and let an operator with a
// valid JWT and zero grants act on any card in the fleet. A fifth site worked
// around the same ambiguity with a `['']` sentinel — a fake uuid standing in
// for "match nothing". Three distinct workarounds for one field is the field
// being wrong, not the callers.
//
// WHAT THE UNION BUYS, precisely:
//
//   1. `scope.ids` does not exist on the `all_venues` arm, so the pasted
//      idiom is a compile error rather than a fleet grant. You must narrow on
//      `kind` first, which is a deliberate act rather than a reflex.
//   2. "Empty" no longer means "everything" ANYWHERE. Fleet-wide is its own
//      tag, so the dangerous idiom loses its legitimate twin: after this,
//      zero sites in the repo skip a filter because a list is empty.
//   3. THE FAILURE DIRECTION INVERTS, which matters most. Forgetting the
//      guard used to grant the fleet. Now the worst a forgetful caller does
//      is apply `.in('venue_id', [])`, which matches nothing — a deny.
//
// Prefer the helpers below to narrowing by hand. They are total over the
// union, so a third arm would fail to compile here rather than silently
// falling through at a call site.

/**
 * Fleet-wide, or a literal list of venue ids.
 *
 * An `all_venues` scope is produced ONLY by the analog-admin cookie path. The
 * operator bearer path always produces `venues`, possibly with an empty
 * `ids` — which is a deny, not a grant.
 */
export type VenueScope =
  | { readonly kind: 'all_venues' }
  | { readonly kind: 'venues'; readonly ids: readonly string[] }

/**
 * What the operator bearer path produces. Narrower than `VenueScope` on
 * purpose: a bearer token can never carry fleet-wide scope, and saying so in
 * the type means the construction site is checked rather than trusted.
 */
export type GrantedVenueScope = Extract<VenueScope, { kind: 'venues' }>

/** Fleet-wide. Analog-admin cookie sessions only. */
export const ALL_VENUES: VenueScope = { kind: 'all_venues' }

/**
 * A bearer principal's literal grants. An empty list is legal and means the
 * operator may act on nothing.
 */
export function grantedVenues(ids: readonly string[]): GrantedVenueScope {
  return { kind: 'venues', ids }
}

/**
 * The analog-admin cookie path's translation: an admin with no explicit
 * grants sees every venue, an admin with grants is restricted to them.
 *
 * This is the ONE place "empty means fleet-wide" is written down. It used to
 * be a comment repeated at fourteen call sites, which is how it came to be
 * copied onto data where it was false.
 */
export function adminVenueScope(ids: readonly string[]): VenueScope {
  return ids.length === 0 ? ALL_VENUES : { kind: 'venues', ids }
}

/** May this scope act on this venue? */
export function allowsVenue(scope: VenueScope, venueId: string): boolean {
  switch (scope.kind) {
    case 'all_venues':
      return true
    case 'venues':
      // An empty list allows nothing. That is the whole point.
      return scope.ids.includes(venueId)
  }
}

/**
 * Bearer-path membership. IDENTICAL to allowsVenue except that a FLEET-WIDE
 * scope is refused rather than allowed (TAC-530, found in code review).
 *
 * The operator API is bearer-only: verifyOperatorRequest is the only thing
 * that feeds it and never produces `all_venues`. But `allowsVenue` returns
 * true for that arm, so a helper using it would DISPATCH against a fleet-wide
 * scope -- expressible with no compile error, and exactly what a future admin
 * surface passing verifyAnalogAdminAccess's scope into an operator helper
 * would do. Unreachable is not the same as impossible, and the union exists
 * to make this class of asymmetry fail closed rather than open.
 *
 * Use this in anything under app/api/operator/* or the helpers it calls.
 * Use allowsVenue on the analog-admin cookie path, where fleet-wide is real.
 */
export function bearerAllowsVenue(scope: VenueScope, venueId: string): boolean {
  return scope.kind === 'venues' && scope.ids.includes(venueId)
}

/**
 * True when the scope permits no venue at all — a bearer principal with zero
 * grants. Call sites use this to deny before touching the database, so a
 * query is never issued on behalf of a principal that may act on nothing.
 */
export function venueScopeDeniesAll(scope: VenueScope): boolean {
  return scope.kind === 'venues' && scope.ids.length === 0
}

/**
 * A fresh array of ids to pass to a `.in('venue_id', ...)` filter, or `null`
 * when the
 * scope is fleet-wide and no filter should be applied.
 *
 * A non-null result may still be empty if the caller skipped
 * `venueScopeDeniesAll`. That degrades to a query matching no rows, which is
 * a deny — the safe direction, and the reason this is not a footgun.
 */
export function venueFilterIds(scope: VenueScope): string[] | null {
  switch (scope.kind) {
    case 'all_venues':
      return null
    case 'venues':
      // A copy: the scope is an auth fact and a caller must not be able to
      // widen its own permissions by mutating the array it was handed.
      return [...scope.ids]
  }
}
