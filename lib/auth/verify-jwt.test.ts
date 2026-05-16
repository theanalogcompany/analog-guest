import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminClient } from '../db/admin'
import { linkOperatorByAuthUser } from './link-operator'
import { AuthError } from './types'
import { verifyOperatorRequest } from './verify-jwt'

vi.mock('../db/admin', () => ({
  createAdminClient: vi.fn(),
}))

vi.mock('./link-operator', () => ({
  linkOperatorByAuthUser: vi.fn(),
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
// by verify-jwt: `.from(t).select(c).or(filter).maybeSingle()` for the
// operators lookup (TAC-272: OR across auth_user_id_phone + auth_user_id_email),
// and `.from(t).select(c).eq(c, v)` (awaited directly) for the
// operator_venues lookup. The returned filter-builder is thenable so either
// form resolves to the configured result.
function makeBuilder<T>(result: QueryResult<T>) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
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
    vi.mocked(linkOperatorByAuthUser).mockReset()
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

  it('throws AuthError(401) when no matching operator row exists and lazy-link fails', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: { id: 'auth-user-x' } }, error: null },
      operatorsResult: { data: null, error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)
    vi.mocked(linkOperatorByAuthUser).mockResolvedValue({
      ok: false,
      error: 'no_matching_operator',
    })

    await expect(
      verifyOperatorRequest(bearerRequest('Bearer x')),
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('not an operator'),
    })
  })

  it('lazy-links and returns operatorId when the OR lookup misses but linkOperator succeeds', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: { id: 'auth-newly-linked' } }, error: null },
      operatorsResult: { data: null, error: null }, // miss on initial lookup
      venuesResult: { data: [{ venue_id: 'venue-x' }], error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)
    vi.mocked(linkOperatorByAuthUser).mockResolvedValue({
      ok: true,
      operatorId: 'op-newly-linked',
      column: 'phone',
      mode: 'newly_linked',
    })

    const out = await verifyOperatorRequest(bearerRequest('Bearer good-jwt'))
    expect(out).toEqual({
      operatorId: 'op-newly-linked',
      allowedVenueIds: ['venue-x'],
    })
    expect(linkOperatorByAuthUser).toHaveBeenCalledWith('auth-newly-linked')
  })

  it('does NOT call lazy-link when the OR lookup already finds the operator', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: { id: 'auth-existing' } }, error: null },
      operatorsResult: { data: { id: 'op-existing' }, error: null },
      venuesResult: { data: [], error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const out = await verifyOperatorRequest(bearerRequest('Bearer good-jwt'))
    expect(out.operatorId).toBe('op-existing')
    expect(linkOperatorByAuthUser).not.toHaveBeenCalled()
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
