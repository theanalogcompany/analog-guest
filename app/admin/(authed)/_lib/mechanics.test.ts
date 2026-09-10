/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import type { MechanicCreate, MechanicPatch } from '@/lib/schemas'
import { addMechanic, deactivateMechanic, editMechanic } from './mechanics'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MECHANIC_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const fullCreate = (): MechanicCreate => ({
  type: 'perk',
  name: 'The Joey',
  description: 'A free drink for regulars',
  qualification: 'Any regular guest',
  rewardDescription: 'One free drink of choice',
  minState: 'regular',
  redemptionPolicy: 'one_time',
  redemptionWindowDays: null,
  requiresOperatorApproval: false,
  triggerType: 'guest_initiated_request',
  expirationRule: 'valid on next visit only',
})

const dbRow = (overrides: Record<string, unknown> = {}) => ({
  type: 'perk',
  name: 'The Joey',
  description: 'A free drink for regulars',
  qualification: 'Any regular guest',
  reward_description: 'One free drink of choice',
  min_state: 'regular',
  redemption_policy: 'one_time',
  redemption_window_days: null,
  requires_operator_approval: false,
  trigger: { type: 'guest_initiated_request' },
  expiration_rule: 'valid on next visit only',
  ...overrides,
})

interface MockState {
  insertedRow: { id: string } | null
  insertError: { message: string } | null
  insertCalls: Array<Record<string, unknown>>
  fetchedRow: Record<string, unknown> | null
  fetchError: { message: string } | null
  updateCalls: Array<Record<string, unknown>>
  updateError: { message: string } | null
  updatedRow: { id: string } | null
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    insertedRow: { id: MECHANIC_ID },
    insertError: null,
    insertCalls: [],
    fetchedRow: dbRow(),
    fetchError: null,
    updateCalls: [],
    updateError: null,
    updatedRow: { id: MECHANIC_ID },
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => ({
        select: (_cols: string) => ({
          single: async () => {
            state.insertCalls.push(row)
            if (state.insertError) return { data: null, error: state.insertError }
            return { data: state.insertedRow, error: null }
          },
        }),
      }),
      select: (_cols: string) => ({
        eq: (_f: string, _v: string) => ({
          single: async () => {
            if (state.fetchError) return { data: null, error: state.fetchError }
            return { data: state.fetchedRow, error: null }
          },
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: (_f: string, _v: string) => {
          state.updateCalls.push(payload)
          // editMechanic awaits .update().eq() directly; deactivateMechanic
          // chains .select().maybeSingle() onto it. Support both.
          const bareResult = Promise.resolve({ error: state.updateError })
          return Object.assign(bareResult, {
            select: (_c: string) => ({
              maybeSingle: async () => {
                if (state.updateError) return { data: null, error: state.updateError }
                return { data: state.updatedRow, error: null }
              },
            }),
          })
        },
      }),
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
})

describe('addMechanic', () => {
  it('inserts every editable field, mapped to snake_case, trigger as {type}', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await addMechanic({ venueId: VENUE_ID, mechanic: fullCreate() })

    expect(result).toEqual({ ok: true, mechanicId: MECHANIC_ID })
    expect(state.insertCalls[0]).toMatchObject({
      venue_id: VENUE_ID,
      type: 'perk',
      name: 'The Joey',
      min_state: 'regular',
      redemption_policy: 'one_time',
      requires_operator_approval: false,
      trigger: { type: 'guest_initiated_request' },
      expiration_rule: 'valid on next visit only',
    })
    // redemption is never written — not part of the editable set.
    expect(state.insertCalls[0]).not.toHaveProperty('redemption')
  })

  it('returns db_error on insert failure', async () => {
    const state = newState({ insertError: { message: 'connection lost' }, insertedRow: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await addMechanic({ venueId: VENUE_ID, mechanic: fullCreate() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('db_error')
  })
})

describe('editMechanic', () => {
  it('no_op when the patch is empty, without touching the DB', async () => {
    const result = await editMechanic({ mechanicId: MECHANIC_ID, patch: {} })
    expect(result).toEqual({
      ok: false,
      error: 'no_op: pass at least one field to change',
      errorCode: 'no_op',
    })
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it('merges a partial patch onto the fetched row and writes the whole merged shape', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const patch: MechanicPatch = { minState: 'raving_fan' }
    const result = await editMechanic({ mechanicId: MECHANIC_ID, patch })

    expect(result).toEqual({ ok: true, mechanicId: MECHANIC_ID })
    expect(state.updateCalls[0]).toMatchObject({
      min_state: 'raving_fan',
      // Untouched fields survive the merge.
      name: 'The Joey',
      type: 'perk',
    })
  })

  it('merges the new trigger type onto the raw trigger jsonb rather than replacing it wholesale', async () => {
    const state = newState({
      fetchedRow: dbRow({ trigger: { type: 'guest_initiated_request', note: 'legacy field' } }),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    await editMechanic({ mechanicId: MECHANIC_ID, patch: { triggerType: 'manual_invite' } })

    expect(state.updateCalls[0].trigger).toEqual({
      type: 'manual_invite',
      note: 'legacy field',
    })
  })

  it('falls back to a clean {type} object rather than merging into corrupted trigger data', async () => {
    // row.trigger is never anything but {type: '...'} on any live mechanic
    // (confirmed by querying the live table during plan review), but the
    // merge must fail safe rather than produce a wrong result if a future
    // hand-edited or migrated row ever violates that assumption.
    for (const corrupted of [['not', 'an', 'object'], 'a string', 42, null]) {
      const state = newState({ fetchedRow: dbRow({ trigger: corrupted }) })
      vi.mocked(createAdminClient).mockReturnValue(
        makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
      )

      await editMechanic({ mechanicId: MECHANIC_ID, patch: { triggerType: 'manual_invite' } })

      expect(state.updateCalls[0].trigger).toEqual({ type: 'manual_invite' })
    }
  })

  it('rejects a merge that violates the redemption pairing constraint', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await editMechanic({
      mechanicId: MECHANIC_ID,
      patch: { redemptionPolicy: 'renewable' }, // window stays null from current
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('invalid_after_merge')
    expect(state.updateCalls).toEqual([])
  })

  it('returns not_found when the mechanic does not exist', async () => {
    const state = newState({ fetchedRow: null, fetchError: { message: 'no rows' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await editMechanic({ mechanicId: MECHANIC_ID, patch: { name: 'New name' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('not_found')
  })
})

describe('deactivateMechanic', () => {
  it('sets is_active=false and deactivated_at, returns ok on an existing row', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await deactivateMechanic(MECHANIC_ID)
    expect(result).toEqual({ ok: true, mechanicId: MECHANIC_ID })
    expect(state.updateCalls[0]).toMatchObject({ is_active: false })
    expect(typeof state.updateCalls[0].deactivated_at).toBe('string')
  })

  it('returns not_found when the mechanic does not exist', async () => {
    const state = newState({ updatedRow: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await deactivateMechanic(MECHANIC_ID)
    expect(result).toEqual({
      ok: false,
      error: `mechanic not found: ${MECHANIC_ID}`,
      errorCode: 'not_found',
    })
  })
})
