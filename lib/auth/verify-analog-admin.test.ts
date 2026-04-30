import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminClient } from '../db/admin'
import { AuthError } from './types'
import {
  verifyAnalogAdminAccess,
  verifyAnalogAdminRequest,
} from './verify-analog-admin'
import { verifyOperatorRequest } from './verify-jwt'

vi.mock('../db/admin', () => ({
  createAdminClient: vi.fn(),
}))

vi.mock('./verify-jwt', () => ({
  verifyOperatorRequest: vi.fn(),
}))

type QueryResult<T> = {
  data: T | null
  error: { message: string } | null
}

// Mirrors the chained-builder mock pattern in verify-jwt.test.ts. Returns
// a thenable filter-builder so callers can await directly OR call .single()
// / .maybeSingle() as needed.
function makeBuilder<T>(result: QueryResult<T>) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (
      onFulfilled?: (value: QueryResult<T>) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  }
  return builder
}

// Per-table results. The bearer flow uses .from('operators') for the
// admin-flag assertion (after verifyOperatorRequest passes); the session
// flow uses .from('operators') for the operator+admin-flag lookup AND
// .from('operator_venues') for the venue list. Tests configure whichever
// they need.
function makeSupabaseMock(opts: {
  operatorsResult?: QueryResult<{ id: string; is_analog_admin: boolean }>
  adminFlagResult?: QueryResult<{ is_analog_admin: boolean }>
  venuesResult?: QueryResult<Array<{ venue_id: string }>>
}) {
  // The .from() call is used twice in the session path: once for operators,
  // once for operator_venues. The bearer path only uses operators (via
  // assertAnalogAdmin). Sequence matters less than table identity.
  return {
    from: vi.fn((table: string) => {
      if (table === 'operators') {
        // Both code paths read from operators. Bearer uses adminFlagResult
        // (reads only is_analog_admin); session uses operatorsResult (reads
        // id + is_analog_admin). Tests pass whichever is relevant.
        const result = opts.operatorsResult ?? opts.adminFlagResult ?? {
          data: null,
          error: null,
        }
        return makeBuilder(result)
      }
      if (table === 'operator_venues') {
        return makeBuilder(opts.venuesResult ?? { data: [], error: null })
      }
      throw new Error(`unexpected table in test: ${table}`)
    }),
  }
}

function emptyRequest(): Request {
  return new Request('https://example.test/api/x')
}

describe('verifyAnalogAdminRequest (bearer)', () => {
  beforeEach(() => {
    vi.mocked(createAdminClient).mockReset()
    vi.mocked(verifyOperatorRequest).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns AnalogAdminOperator on the happy path', async () => {
    vi.mocked(verifyOperatorRequest).mockResolvedValue({
      operatorId: 'operator-1',
      allowedVenueIds: ['venue-a', 'venue-b'],
    })
    const mock = makeSupabaseMock({
      adminFlagResult: { data: { is_analog_admin: true }, error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const out = await verifyAnalogAdminRequest(emptyRequest())
    expect(out).toEqual({
      operatorId: 'operator-1',
      allowedVenueIds: ['venue-a', 'venue-b'],
      isAnalogAdmin: true,
    })
  })

  it('propagates 401 when verifyOperatorRequest throws', async () => {
    vi.mocked(verifyOperatorRequest).mockRejectedValue(
      new AuthError(401, 'invalid or expired token'),
    )
    await expect(verifyAnalogAdminRequest(emptyRequest())).rejects.toMatchObject({
      status: 401,
      message: 'invalid or expired token',
    })
  })

  it('throws 403 when operator is verified but not is_analog_admin', async () => {
    vi.mocked(verifyOperatorRequest).mockResolvedValue({
      operatorId: 'operator-1',
      allowedVenueIds: [],
    })
    const mock = makeSupabaseMock({
      adminFlagResult: { data: { is_analog_admin: false }, error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(verifyAnalogAdminRequest(emptyRequest())).rejects.toMatchObject({
      status: 403,
      message: 'not an analog admin',
    })
  })

  it('throws 401 when the admin-flag lookup query errors', async () => {
    vi.mocked(verifyOperatorRequest).mockResolvedValue({
      operatorId: 'operator-1',
      allowedVenueIds: [],
    })
    const mock = makeSupabaseMock({
      adminFlagResult: { data: null, error: { message: 'connection refused' } },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(verifyAnalogAdminRequest(emptyRequest())).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('admin flag lookup failed'),
    })
  })
})

describe('verifyAnalogAdminAccess (session)', () => {
  beforeEach(() => {
    vi.mocked(createAdminClient).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns AnalogAdminOperator on the happy path', async () => {
    const mock = makeSupabaseMock({
      operatorsResult: {
        data: { id: 'operator-1', is_analog_admin: true },
        error: null,
      },
      venuesResult: {
        data: [{ venue_id: 'venue-a' }, { venue_id: 'venue-b' }],
        error: null,
      },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const out = await verifyAnalogAdminAccess('auth-user-1')
    expect(out).toEqual({
      operatorId: 'operator-1',
      allowedVenueIds: ['venue-a', 'venue-b'],
      isAnalogAdmin: true,
    })
  })

  it('throws 401 when no operator row exists for the auth user', async () => {
    const mock = makeSupabaseMock({
      operatorsResult: { data: null, error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(verifyAnalogAdminAccess('auth-user-x')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('not an operator'),
    })
  })

  it('throws 403 when operator exists but is_analog_admin is false', async () => {
    const mock = makeSupabaseMock({
      operatorsResult: {
        data: { id: 'operator-1', is_analog_admin: false },
        error: null,
      },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(verifyAnalogAdminAccess('auth-user-1')).rejects.toMatchObject({
      status: 403,
      message: 'not an analog admin',
    })
  })

  it('throws 401 when the operators query errors', async () => {
    const mock = makeSupabaseMock({
      operatorsResult: { data: null, error: { message: 'permission denied' } },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(verifyAnalogAdminAccess('auth-user-1')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('operator lookup failed'),
    })
  })

  it('throws 401 when the venues query errors after admin pass', async () => {
    const mock = makeSupabaseMock({
      operatorsResult: {
        data: { id: 'operator-1', is_analog_admin: true },
        error: null,
      },
      venuesResult: { data: null, error: { message: 'timeout' } },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    await expect(verifyAnalogAdminAccess('auth-user-1')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('venue allowlist lookup failed'),
    })
  })

  it('returns success with empty allowedVenueIds when admin has no venues', async () => {
    const mock = makeSupabaseMock({
      operatorsResult: {
        data: { id: 'operator-1', is_analog_admin: true },
        error: null,
      },
      venuesResult: { data: [], error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const out = await verifyAnalogAdminAccess('auth-user-1')
    expect(out).toEqual({
      operatorId: 'operator-1',
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })
  })
})
