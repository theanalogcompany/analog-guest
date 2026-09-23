import type { GrantedVenueScope, VenueScope } from './venue-scope'

export class AuthError extends Error {
  readonly status: 401 | 403

  constructor(status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

export interface AuthenticatedOperator {
  operatorId: string
  /**
   * Which venues this principal may act on (TAC-530).
   *
   * This was `allowedVenueIds: string[]`, where an EMPTY array meant
   * "every venue" on the cookie path and "no venue" on the bearer path. The
   * cookie idiom was pasted onto bearer data at four call sites and let a
   * grantless operator act on the whole fleet. See lib/auth/venue-scope.ts
   * for why the union retires that, and prefer its helpers to narrowing by
   * hand.
   */
  venueScope: VenueScope
}

/**
 * What the operator BEARER path returns. Narrower than AuthenticatedOperator
 * on purpose: verifyOperatorRequest builds the scope from the operator's
 * literal operator_venues rows and performs no is_analog_admin lookup, so it
 * can never produce a fleet-wide scope. Stating that in the type means the
 * construction site is checked rather than trusted.
 */
export interface BearerOperator extends AuthenticatedOperator {
  venueScope: GrantedVenueScope
}
