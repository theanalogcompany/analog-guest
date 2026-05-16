import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAdminClient } from '../db/admin'
import { linkOperatorByAuthUser } from './link-operator'

vi.mock('../db/admin', () => ({
  createAdminClient: vi.fn(),
}))

type QueryResult<T> = { data: T | null; error: { message: string } | null }

interface OperatorsLinkRow {
  id: string
  auth_user_id_phone: string | null
  auth_user_id_email: string | null
}

interface AuthUser {
  id: string
  phone?: string | null
  email?: string | null
}

type AuthAdminResult = {
  data: { user: AuthUser | null } | null
  error: { message: string } | null
}

// Builder usable for both `maybeSingle()` (fast-path lookup) and direct await
// (match query + update). Returns the configured result whichever shape the
// helper awaits. `update` writes through to the supplied spy so tests can
// observe the target column + value without intercepting the chain.
type UpdateSpy = (payload: Record<string, unknown>) => void

function makeBuilder<T>(result: QueryResult<T>, updateSpy?: UpdateSpy) {
  const builder = {
    select: () => builder,
    or: () => builder,
    eq: () => builder,
    update: (payload: Record<string, unknown>) => {
      if (updateSpy) updateSpy(payload)
      return builder
    },
    maybeSingle: () => Promise.resolve(result),
    then: (
      onFulfilled?: (value: QueryResult<T>) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  }
  return builder
}

// Supports a sequence of `.from('operators')` calls per test, each consuming
// the next result from the supplied list. Mirrors the helper's call order:
//   1. fast-path .or().maybeSingle() — looks for an existing link
//   2. .eq(matchField, ...) — looks up the matching operator
//   3. .update(...).eq('id', ...) — writes the link (skipped on error/early-return paths)
function makeSupabaseMock(opts: {
  authUserResult: AuthAdminResult
  operatorsCalls: Array<QueryResult<OperatorsLinkRow | OperatorsLinkRow[]>>
  updateSpy?: UpdateSpy
}) {
  let callIndex = 0
  return {
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue(opts.authUserResult),
      },
    },
    from: vi.fn((table: string) => {
      if (table !== 'operators') {
        throw new Error(`unexpected table in test: ${table}`)
      }
      const result = opts.operatorsCalls[callIndex] ?? {
        data: null,
        error: null,
      }
      callIndex += 1
      return makeBuilder(result, opts.updateSpy)
    }),
  }
}

const PHONE_AUTH: AuthUser = { id: 'auth-phone-1', phone: '18777804236' }
const EMAIL_AUTH: AuthUser = { id: 'auth-email-1', email: 'op@example.test' }

describe('linkOperatorByAuthUser', () => {
  beforeEach(() => {
    vi.mocked(createAdminClient).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('newly links phone-auth user via auth_user_id_phone', async () => {
    const updateSpy = vi.fn()
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: PHONE_AUTH }, error: null },
      operatorsCalls: [
        // 1. fast-path: not yet linked
        { data: null, error: null },
        // 2. match query: one operator with the matching +E.164 phone
        {
          data: [
            {
              id: 'op-phone',
              auth_user_id_phone: null,
              auth_user_id_email: null,
            },
          ],
          error: null,
        },
        // 3. update: success
        { data: null, error: null },
      ],
      updateSpy,
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(PHONE_AUTH.id)
    expect(result).toEqual({
      ok: true,
      operatorId: 'op-phone',
      column: 'phone',
      mode: 'newly_linked',
    })
    expect(updateSpy).toHaveBeenCalledWith({
      auth_user_id_phone: PHONE_AUTH.id,
    })
  })

  it('newly links email-auth user via auth_user_id_email', async () => {
    const updateSpy = vi.fn()
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: EMAIL_AUTH }, error: null },
      operatorsCalls: [
        { data: null, error: null },
        {
          data: [
            {
              id: 'op-email',
              auth_user_id_phone: null,
              auth_user_id_email: null,
            },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      updateSpy,
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(EMAIL_AUTH.id)
    expect(result).toEqual({
      ok: true,
      operatorId: 'op-email',
      column: 'email',
      mode: 'newly_linked',
    })
    expect(updateSpy).toHaveBeenCalledWith({
      auth_user_id_email: EMAIL_AUTH.id,
    })
  })

  it('is idempotent — already-linked phone user short-circuits to already_linked', async () => {
    const updateSpy = vi.fn()
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: PHONE_AUTH }, error: null },
      operatorsCalls: [
        // fast-path hits an existing link
        {
          data: {
            id: 'op-phone',
            auth_user_id_phone: PHONE_AUTH.id,
            auth_user_id_email: null,
          },
          error: null,
        },
      ],
      updateSpy,
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(PHONE_AUTH.id)
    expect(result).toEqual({
      ok: true,
      operatorId: 'op-phone',
      column: 'phone',
      mode: 'already_linked',
    })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('is idempotent — already-linked email user short-circuits to already_linked', async () => {
    const updateSpy = vi.fn()
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: EMAIL_AUTH }, error: null },
      operatorsCalls: [
        {
          data: {
            id: 'op-email',
            auth_user_id_phone: null,
            auth_user_id_email: EMAIL_AUTH.id,
          },
          error: null,
        },
      ],
      updateSpy,
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(EMAIL_AUTH.id)
    expect(result).toEqual({
      ok: true,
      operatorId: 'op-email',
      column: 'email',
      mode: 'already_linked',
    })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('returns auth_user_not_found when admin.getUserById errors', async () => {
    const mock = makeSupabaseMock({
      authUserResult: {
        data: null,
        error: { message: 'user not found' },
      },
      operatorsCalls: [],
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser('missing-id')
    expect(result).toMatchObject({
      ok: false,
      error: 'auth_user_not_found',
      details: 'user not found',
    })
  })

  it('returns auth_user_not_found when admin.getUserById returns a null user', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: null }, error: null },
      operatorsCalls: [],
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser('missing-id')
    expect(result).toMatchObject({ ok: false, error: 'auth_user_not_found' })
  })

  it('returns auth_user_has_no_identity when both phone and email are null', async () => {
    const mock = makeSupabaseMock({
      authUserResult: {
        data: { user: { id: 'anon', phone: null, email: null } },
        error: null,
      },
      operatorsCalls: [],
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser('anon')
    expect(result).toMatchObject({
      ok: false,
      error: 'auth_user_has_no_identity',
    })
  })

  it('returns no_matching_operator when no operators row matches the identity', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: EMAIL_AUTH }, error: null },
      operatorsCalls: [
        { data: null, error: null },
        { data: [], error: null },
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(EMAIL_AUTH.id)
    expect(result).toMatchObject({ ok: false, error: 'no_matching_operator' })
  })

  it('returns multiple_matching_operators when two operators share an identity', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: EMAIL_AUTH }, error: null },
      operatorsCalls: [
        { data: null, error: null },
        {
          data: [
            { id: 'op-a', auth_user_id_phone: null, auth_user_id_email: null },
            { id: 'op-b', auth_user_id_phone: null, auth_user_id_email: null },
          ],
          error: null,
        },
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(EMAIL_AUTH.id)
    expect(result).toMatchObject({
      ok: false,
      error: 'multiple_matching_operators',
    })
  })

  it('returns already_claimed_by_different_user when target column points to a different auth user', async () => {
    const updateSpy = vi.fn()
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: PHONE_AUTH }, error: null },
      operatorsCalls: [
        { data: null, error: null },
        {
          data: [
            {
              id: 'op-conflict',
              auth_user_id_phone: 'some-other-auth-user-id',
              auth_user_id_email: null,
            },
          ],
          error: null,
        },
      ],
      updateSpy,
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(PHONE_AUTH.id)
    expect(result).toMatchObject({
      ok: false,
      error: 'already_claimed_by_different_user',
    })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('returns db_error when the fast-path lookup fails', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: EMAIL_AUTH }, error: null },
      operatorsCalls: [
        { data: null, error: { message: 'connection refused' } },
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(EMAIL_AUTH.id)
    expect(result).toMatchObject({
      ok: false,
      error: 'db_error',
      details: expect.stringContaining('existing-link lookup failed'),
    })
  })

  it('returns db_error when the match query fails', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: EMAIL_AUTH }, error: null },
      operatorsCalls: [
        { data: null, error: null },
        { data: null, error: { message: 'permission denied' } },
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(EMAIL_AUTH.id)
    expect(result).toMatchObject({
      ok: false,
      error: 'db_error',
      details: expect.stringContaining('operator match failed'),
    })
  })

  it('returns db_error when the update fails', async () => {
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: EMAIL_AUTH }, error: null },
      operatorsCalls: [
        { data: null, error: null },
        {
          data: [
            { id: 'op-x', auth_user_id_phone: null, auth_user_id_email: null },
          ],
          error: null,
        },
        { data: null, error: { message: 'unique constraint violated' } },
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(EMAIL_AUTH.id)
    expect(result).toMatchObject({
      ok: false,
      error: 'db_error',
      details: expect.stringContaining('link update failed'),
    })
  })

  it('phone+email auth.users picks phone column (defensive — Supabase today provisions one identity per row)', async () => {
    const dualAuth: AuthUser = {
      id: 'auth-dual',
      phone: '18005550199',
      email: 'dual@example.test',
    }
    const updateSpy = vi.fn()
    const mock = makeSupabaseMock({
      authUserResult: { data: { user: dualAuth }, error: null },
      operatorsCalls: [
        { data: null, error: null },
        {
          data: [
            {
              id: 'op-dual',
              auth_user_id_phone: null,
              auth_user_id_email: null,
            },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      updateSpy,
    })
    vi.mocked(createAdminClient).mockReturnValue(mock as never)

    const result = await linkOperatorByAuthUser(dualAuth.id)
    expect(result).toMatchObject({
      ok: true,
      column: 'phone',
      mode: 'newly_linked',
    })
    expect(updateSpy).toHaveBeenCalledWith({ auth_user_id_phone: dualAuth.id })
  })
})
