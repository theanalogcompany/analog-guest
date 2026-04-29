import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminClient } from '../db/admin'
import { AuthError } from './types'
import { verifyOperatorRequest } from './verify-jwt'

vi.mock('../db/admin', () => ({
  createAdminClient: vi.fn(),
}))

type AuthGetUserResult = {
  data: { user: { id: string } | null } | null
  error: { message: string } | null
}

type QueryResult<T> = {
  data: T | null
  error: { message: string } | null
}

// Builds a Supabase client mock that supports the chained query shapes used
// by verify-jwt: `.from(t).select(c).eq(c, v).maybeSingle()` for the
// operators lookup, and `.from(t).select(c).eq(c, v)` (awaited directly) for
// the operator_venues lookup. The returned filter-builder is thenable so
// either form resolves to the configured result.
function makeBuilder<T>(result: QueryResult<T>) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (
      onFulfilled?: (value: QueryResult<T>) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  }
  return builder
}

function makeSupabaseMock(opts: {
  authUserResult: AuthGetUserResult
  operatorsResult?: QueryResult<{ id: string }>
  venuesResult?: QueryResult<Array<{ venue_id: string }>>
}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue(opts.authUserResult),
    },
    from: vi.fn((table: string) => {
      if (table === 'operators') {
        return makeBuilder(
          opts.operatorsResult ?? { data: null, error: null },
        )
      }
      if (table === 'operator_venues') {
        return makeBuilder(
          opts.venuesResult ?? { data: [], error: null },
        )
      }
      throw new Error(`unexpected table in test: ${table}`)
    }),
  }
}

function bearerRequest(token: string | null): Request {
  const headers = new Headers()
  if (token !== null) headers.set('authorization', token)
  return new Request('https://example.test/api/x', { headers })
}

describe('verifyOperatorRequest', () => {
  beforeEach(() => {
    vi.mocked(createAdminClient).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns operatorId + allowedVenueIds on the happy path', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: { id: 'auth-user-1' } }, error: null },
      operatorsResult: { data: { id: 'operator-1' }, error: null },
      venuesResult: {
        data: [{ venue_id: 'venue-a' }, { venue_id: 'venue-b' }],
        error: null,
      },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const out = await verifyOperatorRequest(bearerRequest('Bearer good-jwt'))
    expect(out).toEqual({
      operatorId: 'operator-1',
      allowedVenueIds: ['venue-a', 'venue-b'],
    })
    expect(mock.auth.getUser).toHaveBeenCalledWith('good-jwt')
  })

  it('throws AuthError(401) when Authorization header is missing', async () => {
    await expect(verifyOperatorRequest(bearerRequest(null))).rejects.toMatchObject({
      name: 'AuthError',
      status: 401,
      message: expect.stringContaining('missing'),
    })
  })

  it('throws AuthError(401) when header is malformed (no "Bearer")', async () => {
    await expect(
      verifyOperatorRequest(bearerRequest('blah-token')),
    ).rejects.toMatchObject({ status: 401, message: expect.stringContaining('malformed') })
  })

  it('throws AuthError(401) when the bearer token is empty after trim', async () => {
    // The "Bearer" prefix without a token. The malformed-pattern catches this
    // first because /^Bearer\s+\S+/ requires at least one non-whitespace char
    // after the spaces.
    await expect(
      verifyOperatorRequest(bearerRequest('Bearer    ')),
    ).rejects.toMatchObject({ status: 401, message: expect.stringContaining('malformed') })
  })

  it('throws AuthError(401) when auth.getUser returns an error', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: null, error: { message: 'JWT expired' } },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(
      verifyOperatorRequest(bearerRequest('Bearer expired-jwt')),
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('JWT expired'),
    })
  })

  it('throws AuthError(401) when auth.getUser returns no user', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: null }, error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(
      verifyOperatorRequest(bearerRequest('Bearer x')),
    ).rejects.toMatchObject({ status: 401, message: expect.stringContaining('no user') })
  })

  it('throws AuthError(401) when no matching operator row exists', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: { id: 'auth-user-x' } }, error: null },
      operatorsResult: { data: null, error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(
      verifyOperatorRequest(bearerRequest('Bearer x')),
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('not an operator'),
    })
  })

  it('throws AuthError(401) when the operators query errors', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: { id: 'auth-user-x' } }, error: null },
      operatorsResult: { data: null, error: { message: 'connection refused' } },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(
      verifyOperatorRequest(bearerRequest('Bearer x')),
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('operator lookup failed'),
    })
  })

  it('throws AuthError(401) when the operator_venues query errors', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: { id: 'auth-user-x' } }, error: null },
      operatorsResult: { data: { id: 'operator-1' }, error: null },
      venuesResult: { data: null, error: { message: 'permission denied' } },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(
      verifyOperatorRequest(bearerRequest('Bearer x')),
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('venue allowlist lookup failed'),
    })
  })

  it('returns success with empty allowedVenueIds when operator has no venues yet', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: { id: 'auth-user-1' } }, error: null },
      operatorsResult: { data: { id: 'operator-1' }, error: null },
      venuesResult: { data: [], error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const out = await verifyOperatorRequest(bearerRequest('Bearer good-jwt'))
    expect(out).toEqual({ operatorId: 'operator-1', allowedVenueIds: [] })
  })

  it('uses AuthError class instances (instanceof check)', async () => {
    try {
      await verifyOperatorRequest(bearerRequest(null))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError)
    }
  })
})
