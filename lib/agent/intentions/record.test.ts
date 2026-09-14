import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenIntention } from './derive'

const classifyIntentionPromptsMock = vi.fn()
vi.mock('@/lib/ai', () => ({
  classifyIntentionPrompts: (...a: unknown[]) => classifyIntentionPromptsMock(...a),
}))

type Filter = [method: string, args: unknown[]]

interface SupabaseMockState {
  upsertCalls: { payload: Record<string, unknown>[]; options: Record<string, unknown> }[]
  updateCalls: { payload: Record<string, unknown>; filters: Filter[] }[]
  upsertError: { message: string } | null
  updateError: { message: string } | null
}

function newSupabaseState(overrides: Partial<SupabaseMockState> = {}): SupabaseMockState {
  return { upsertCalls: [], updateCalls: [], upsertError: null, updateError: null, ...overrides }
}

function makeSupabaseMock(state: SupabaseMockState) {
  return {
    from: (table: string) => {
      if (table !== 'guest_intention_prompts') {
        throw new Error(`unexpected table in test mock: ${table}`)
      }
      return {
        upsert: (payload: Record<string, unknown>[], options: Record<string, unknown>) => {
          state.upsertCalls.push({ payload, options })
          return Promise.resolve({ error: state.upsertError })
        },
        update: (payload: Record<string, unknown>) => {
          const call = { payload, filters: [] as Filter[] }
          state.updateCalls.push(call)
          const chain: Record<string, unknown> = {}
          for (const method of ['eq', 'in', 'is', 'lt', 'lte', 'or']) {
            chain[method] = (...args: unknown[]) => {
              call.filters.push([method, args])
              return chain
            }
          }
          chain.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ error: state.updateError }).then(resolve)
          return chain
        },
      }
    },
  }
}

let currentState = newSupabaseState()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => makeSupabaseMock(currentState),
}))

// Import after mocks so the module under test picks them up.
import {
  buildEligibilityRow,
  CLASSIFIER_ATTEMPTS,
  recordIntentionEligibility,
  recordIntentionPrompts,
} from './record'

const NOW = new Date('2026-09-14T12:00:00.000Z')
const NAME_ELIGIBLE = new Date('2026-09-13T09:00:00.000Z')
const LOCAL_ELIGIBLE = new Date('2026-09-12T09:00:00.000Z')
const REC_ELIGIBLE = new Date('2026-09-14T08:00:00.000Z')
const REC_ANCHOR = REC_ELIGIBLE.toISOString()

// An event-armed intention. Recording never reads promptLine.
const REC_OPEN: OpenIntention = {
  key: 'got_the_recommendation',
  promptLine: 'unused by recording',
  eligibleAt: REC_ELIGIBLE,
}

const anchoredStampFilters = (key: string, anchor: string): Filter[] => [
  ['eq', ['venue_id', 'v1']],
  ['eq', ['guest_id', 'g1']],
  ['eq', ['intention_key', key]],
  ['lte', ['eligible_at', anchor]],
  ['or', [`prompted_at.is.null,prompted_at.lt.${anchor}`]],
]

const twoOpen: OpenIntention[] = [
  { key: 'learn_name', promptLine: "You don't know this guest's name yet.", eligibleAt: NAME_ELIGIBLE },
  {
    key: 'are_they_local',
    promptLine: "You don't know whether this guest lives or works nearby.",
    eligibleAt: LOCAL_ELIGIBLE,
  },
]

const base = {
  venueId: 'v1',
  guestId: 'g1',
  messageId: 'm1',
  sentBody: 'text',
  openIntentions: twoOpen,
  now: NOW,
}

const raised = (keys: string[]) => ({ ok: true, data: { raisedKeys: keys, promptVersion: 'v1.0.0' } })

const stampFilters = (keys: string[]): Filter[] => [
  ['eq', ['venue_id', 'v1']],
  ['eq', ['guest_id', 'g1']],
  ['in', ['intention_key', keys]],
  ['is', ['prompted_at', null]],
]

afterEach(() => {
  classifyIntentionPromptsMock.mockReset()
  currentState = newSupabaseState()
})

// TAC-380 trap 3. guest_intention_prompts.prompted_at still carries its
// migration-035 DEFAULT now() (kept deliberately through the deploy window, see
// migration 040). An eligibility row that merely OMITS prompted_at is therefore
// born already-prompted — closed before it was ever shown. toStrictEqual, not
// toEqual: the difference between an explicit null and a missing key is the
// entire defect.
describe('buildEligibilityRow (trap 3)', () => {
  it('writes prompted_at: null explicitly, because the live column default is now()', () => {
    const row = buildEligibilityRow({
      venueId: 'v1',
      guestId: 'g1',
      key: 'learn_name',
      eligibleAt: NAME_ELIGIBLE,
    })
    expect(row).toStrictEqual({
      venue_id: 'v1',
      guest_id: 'g1',
      intention_key: 'learn_name',
      eligible_at: NAME_ELIGIBLE.toISOString(),
      prompted_at: null,
      prompt_source: null,
      message_id: null,
    })
  })
})

describe('recordIntentionEligibility', () => {
  it('writes nothing when there is nothing newly eligible', async () => {
    const result = await recordIntentionEligibility({ venueId: 'v1', guestId: 'g1', entries: [] })
    expect(result).toEqual({ kind: 'nothing_to_record' })
    expect(currentState.upsertCalls).toEqual([])
  })

  it('inserts explicit-null eligibility rows and never overwrites an existing anchor', async () => {
    const result = await recordIntentionEligibility({
      venueId: 'v1',
      guestId: 'g1',
      entries: [{ key: 'learn_name', eligibleAt: NAME_ELIGIBLE, rearm: false }],
    })

    expect(result).toEqual({ kind: 'recorded', keys: ['learn_name'] })
    expect(currentState.upsertCalls).toStrictEqual([
      {
        payload: [
          buildEligibilityRow({ venueId: 'v1', guestId: 'g1', key: 'learn_name', eligibleAt: NAME_ELIGIBLE }),
        ],
        // ignoreDuplicates keeps the EARLIEST eligible_at: a second observation
        // must not slide an expiry window later.
        options: { onConflict: 'guest_id,intention_key', ignoreDuplicates: true },
      },
    ])
    expect(currentState.updateCalls).toEqual([])
  })

  // Re-arming. An ignoreDuplicates upsert can never move an existing row, so a
  // re-arm is an UPDATE. It moves eligible_at and nothing else: the row's last
  // prompt stays, because the brake still counts it.
  it('re-arms with an UPDATE of eligible_at alone, guarded on an older stored anchor', async () => {
    const result = await recordIntentionEligibility({
      venueId: 'v1',
      guestId: 'g1',
      entries: [{ key: 'got_the_recommendation', eligibleAt: REC_ELIGIBLE, rearm: true }],
    })

    expect(result).toEqual({ kind: 'recorded', keys: ['got_the_recommendation'] })
    expect(currentState.upsertCalls).toEqual([])
    expect(currentState.updateCalls).toStrictEqual([
      {
        payload: { eligible_at: REC_ANCHOR },
        filters: [
          ['eq', ['venue_id', 'v1']],
          ['eq', ['guest_id', 'g1']],
          ['eq', ['intention_key', 'got_the_recommendation']],
          // Strictly older only: repeating the re-arm, or a row the prompt that
          // asked about this arming already moved to it, matches nothing.
          ['lt', ['eligible_at', REC_ANCHOR]],
        ],
      },
    ])
  })

  it('inserts new eligibility and re-arms existing rows in the same turn', async () => {
    const result = await recordIntentionEligibility({
      venueId: 'v1',
      guestId: 'g1',
      entries: [
        { key: 'learn_name', eligibleAt: NAME_ELIGIBLE, rearm: false },
        { key: 'got_the_recommendation', eligibleAt: REC_ELIGIBLE, rearm: true },
      ],
    })

    expect(result).toEqual({ kind: 'recorded', keys: ['learn_name', 'got_the_recommendation'] })
    expect(currentState.upsertCalls.flatMap((c) => c.payload.map((row) => row.intention_key))).toEqual([
      'learn_name',
    ])
    expect(currentState.updateCalls.map((c) => c.filters[2])).toEqual([
      ['eq', ['intention_key', 'got_the_recommendation']],
    ])
  })

  it('returns failed when a re-arm write errors', async () => {
    currentState = newSupabaseState({ updateError: { message: 'db down' } })
    const result = await recordIntentionEligibility({
      venueId: 'v1',
      guestId: 'g1',
      entries: [{ key: 'got_the_recommendation', eligibleAt: REC_ELIGIBLE, rearm: true }],
    })
    expect(result).toEqual({ kind: 'failed', error: 'db down' })
  })

  it('returns failed without throwing when the write errors', async () => {
    currentState = newSupabaseState({ upsertError: { message: 'db down' } })
    const result = await recordIntentionEligibility({
      venueId: 'v1',
      guestId: 'g1',
      entries: [{ key: 'learn_name', eligibleAt: NAME_ELIGIBLE, rearm: false }],
    })
    expect(result).toEqual({ kind: 'failed', error: 'db down' })
  })
})

describe('recordIntentionPrompts', () => {
  it('short-circuits with no_open_intentions and never calls the classifier', async () => {
    const result = await recordIntentionPrompts({ ...base, openIntentions: [] })
    expect(result).toEqual({ kind: 'no_open_intentions' })
    expect(classifyIntentionPromptsMock).not.toHaveBeenCalled()
  })

  // TAC-380 trap 2. The pre-040 write was an upsert with ignoreDuplicates, i.e.
  // ON CONFLICT DO NOTHING. With an eligibility row already present that write
  // no-ops, prompted_at is never stamped, and the intention is re-asked every
  // turn. The stamp must be an UPDATE guarded on prompted_at IS NULL.
  it('ensures the row, then stamps prompted_at with an UPDATE guarded on prompted_at IS NULL (trap 2)', async () => {
    classifyIntentionPromptsMock.mockResolvedValue(raised(['learn_name']))

    const result = await recordIntentionPrompts(base)

    expect(result).toEqual({ kind: 'recorded', raisedKeys: ['learn_name'], classifierAttempts: 1 })
    expect(currentState.upsertCalls).toStrictEqual([
      {
        payload: [
          buildEligibilityRow({ venueId: 'v1', guestId: 'g1', key: 'learn_name', eligibleAt: NAME_ELIGIBLE }),
        ],
        options: { onConflict: 'guest_id,intention_key', ignoreDuplicates: true },
      },
    ])
    expect(currentState.updateCalls).toHaveLength(1)
    expect(currentState.updateCalls[0].payload).toStrictEqual({
      prompted_at: NOW.toISOString(),
      message_id: 'm1',
      prompt_source: 'classified',
    })
    expect(currentState.updateCalls[0].filters).toEqual(stampFilters(['learn_name']))
  })

  // The other half of trap 2: no upsert may carry a prompted_at value. If the
  // stamp ever moves back into an ignoreDuplicates upsert, this fails.
  it('never stamps prompted_at through an upsert', async () => {
    classifyIntentionPromptsMock.mockResolvedValue(raised(['learn_name', 'are_they_local']))

    await recordIntentionPrompts(base)

    const upsertedRows = currentState.upsertCalls.flatMap((c) => c.payload)
    expect(upsertedRows.length).toBeGreaterThan(0)
    for (const row of upsertedRows) {
      expect(row.prompted_at).toBeNull()
    }
  })

  it('passes key+description pairs sourced from INTENTION_DEFINITIONS to the classifier', async () => {
    classifyIntentionPromptsMock.mockResolvedValue(raised([]))

    await recordIntentionPrompts(base)

    const callArgs = classifyIntentionPromptsMock.mock.calls[0]?.[0] as
      | { openIntentions?: { key: string; description: string }[] }
      | undefined
    expect(callArgs?.openIntentions?.map((o) => o.key)).toEqual(['learn_name', 'are_they_local'])
    for (const o of callArgs?.openIntentions ?? []) {
      expect(o.description.trim().length).toBeGreaterThan(0)
    }
  })

  it('stamps every raised key in one guarded update', async () => {
    classifyIntentionPromptsMock.mockResolvedValue(raised(['learn_name', 'are_they_local']))

    const result = await recordIntentionPrompts(base)

    expect(result.kind).toBe('recorded')
    expect(currentState.updateCalls).toHaveLength(1)
    expect(currentState.updateCalls[0].filters).toEqual(stampFilters(['learn_name', 'are_they_local']))
  })

  // Event-armed intentions re-arm, so the stamp records WHICH arming it closed.
  // The guard makes the stamp and the re-arm write safe in either order on the
  // same turn, and stops a prompt from a superseded arming closing a newer one.
  it('stamps an event-armed intention with its own anchor, guarded against a newer arming', async () => {
    classifyIntentionPromptsMock.mockResolvedValue(raised(['got_the_recommendation']))

    const result = await recordIntentionPrompts({ ...base, openIntentions: [REC_OPEN] })

    expect(result).toEqual({ kind: 'recorded', raisedKeys: ['got_the_recommendation'], classifierAttempts: 1 })
    expect(currentState.updateCalls).toStrictEqual([
      {
        payload: {
          prompted_at: NOW.toISOString(),
          message_id: 'm1',
          prompt_source: 'classified',
          eligible_at: REC_ANCHOR,
        },
        filters: anchoredStampFilters('got_the_recommendation', REC_ANCHOR),
      },
    ])
  })

  it('stamps first-contact and event-armed intentions separately when one send raises both', async () => {
    classifyIntentionPromptsMock.mockResolvedValue(raised(['learn_name', 'got_the_recommendation']))

    await recordIntentionPrompts({ ...base, openIntentions: [twoOpen[0], REC_OPEN] })

    expect(currentState.updateCalls.map((c) => c.filters)).toEqual([
      stampFilters(['learn_name']),
      anchoredStampFilters('got_the_recommendation', REC_ANCHOR),
    ])
  })

  it('closes an event-armed intention pessimistically under the same anchor guard', async () => {
    classifyIntentionPromptsMock.mockResolvedValue({ ok: false, error: 'anthropic timeout' })

    await recordIntentionPrompts({ ...base, openIntentions: [REC_OPEN] })

    expect(currentState.updateCalls).toHaveLength(1)
    expect(currentState.updateCalls[0].payload.prompt_source).toBe('pessimistic')
    expect(currentState.updateCalls[0].payload.eligible_at).toBe(REC_ANCHOR)
    expect(currentState.updateCalls[0].filters).toEqual(anchoredStampFilters('got_the_recommendation', REC_ANCHOR))
  })

  it('writes nothing when the classifier raises nothing', async () => {
    classifyIntentionPromptsMock.mockResolvedValue(raised([]))

    const result = await recordIntentionPrompts(base)

    expect(result).toEqual({ kind: 'nothing_raised' })
    expect(currentState.upsertCalls).toEqual([])
    expect(currentState.updateCalls).toEqual([])
  })

  it('filters out a classifier-returned key that was not rendered', async () => {
    classifyIntentionPromptsMock.mockResolvedValue(raised(['learn_name', 'some_future_key']))

    const result = await recordIntentionPrompts({ ...base, openIntentions: [twoOpen[0]] })

    expect(result).toEqual({ kind: 'recorded', raisedKeys: ['learn_name'], classifierAttempts: 1 })
  })

  // Ruling 4: retry once, then close pessimistically. The read in
  // build-runtime-context already fails closed; before this ticket the write
  // failed open, which is the asymmetry.
  it('pins CLASSIFIER_ATTEMPTS at 2 — one retry, per ruling 4', () => {
    expect(CLASSIFIER_ATTEMPTS).toBe(2)
  })

  it('retries a failed classifier call once, then records normally', async () => {
    classifyIntentionPromptsMock
      .mockResolvedValueOnce({ ok: false, error: 'anthropic timeout' })
      .mockResolvedValueOnce(raised(['learn_name']))

    const result = await recordIntentionPrompts(base)

    expect(result).toEqual({ kind: 'recorded', raisedKeys: ['learn_name'], classifierAttempts: 2 })
    expect(classifyIntentionPromptsMock).toHaveBeenCalledTimes(2)
    expect(currentState.updateCalls[0].payload.prompt_source).toBe('classified')
  })

  it('closes every rendered intention pessimistically after the retry also fails', async () => {
    classifyIntentionPromptsMock.mockResolvedValue({ ok: false, error: 'anthropic timeout' })

    const result = await recordIntentionPrompts(base)

    expect(result).toEqual({
      kind: 'closed_pessimistically',
      closedKeys: ['learn_name', 'are_they_local'],
      classifierError: 'anthropic timeout',
    })
    expect(classifyIntentionPromptsMock).toHaveBeenCalledTimes(CLASSIFIER_ATTEMPTS)
    expect(currentState.updateCalls).toHaveLength(1)
    expect(currentState.updateCalls[0].payload).toStrictEqual({
      prompted_at: NOW.toISOString(),
      message_id: 'm1',
      prompt_source: 'pessimistic',
    })
    expect(currentState.updateCalls[0].filters).toEqual(stampFilters(['learn_name', 'are_they_local']))
  })

  it('treats a thrown classifier error as a failure, not a crash', async () => {
    classifyIntentionPromptsMock.mockRejectedValue(new Error('unexpected'))

    const result = await recordIntentionPrompts(base)

    expect(result).toEqual({
      kind: 'closed_pessimistically',
      closedKeys: ['learn_name', 'are_they_local'],
      classifierError: 'unexpected',
    })
  })

  it('returns write_failed, and never stamps, when ensuring the row fails', async () => {
    currentState = newSupabaseState({ upsertError: { message: 'db down' } })
    classifyIntentionPromptsMock.mockResolvedValue(raised(['learn_name']))

    const result = await recordIntentionPrompts(base)

    expect(result).toEqual({
      kind: 'write_failed',
      keys: ['learn_name'],
      source: 'classified',
      error: 'db down',
    })
    expect(currentState.updateCalls).toEqual([])
  })

  it('returns write_failed when the stamp fails', async () => {
    currentState = newSupabaseState({ updateError: { message: 'db down' } })
    classifyIntentionPromptsMock.mockResolvedValue(raised(['learn_name']))

    const result = await recordIntentionPrompts(base)

    expect(result).toEqual({
      kind: 'write_failed',
      keys: ['learn_name'],
      source: 'classified',
      error: 'db down',
    })
  })

  // The only remaining path to a genuine re-ask: the classifier failed twice
  // AND the pessimistic write failed too.
  it('returns write_failed with source pessimistic when the pessimistic write fails', async () => {
    currentState = newSupabaseState({ updateError: { message: 'db down' } })
    classifyIntentionPromptsMock.mockResolvedValue({ ok: false, error: 'anthropic timeout' })

    const result = await recordIntentionPrompts(base)

    expect(result).toEqual({
      kind: 'write_failed',
      keys: ['learn_name', 'are_they_local'],
      source: 'pessimistic',
      error: 'db down',
    })
  })
})

// The claim that the re-arm write and the anchored stamp are safe in either
// order on the same turn, checked against an in-memory row rather than only by
// pinning the filter shapes each write sends. The evaluator implements exactly
// the filters record.ts uses, and throws on anything else.
describe('re-arm and stamp, applied to a row in either order', () => {
  type Row = Record<string, string | null>

  const time = (v: string) => Date.parse(v)

  function matches(row: Row, [method, args]: Filter): boolean {
    const [column, value] = args as [string, unknown]
    switch (method) {
      case 'eq':
      case 'is':
        return row[column] === value
      case 'in':
        return (value as unknown[]).includes(row[column])
      case 'lt':
        return row[column] !== null && time(row[column] as string) < time(value as string)
      case 'lte':
        return row[column] !== null && time(row[column] as string) <= time(value as string)
      case 'or':
        return (args[0] as string).split(',').some((clause) => {
          const [col, op, ...rest] = clause.split('.')
          const v = rest.join('.')
          if (op === 'is' && v === 'null') return row[col] === null
          if (op === 'lt') return row[col] !== null && time(row[col] as string) < time(v)
          throw new Error(`unsupported or clause in test evaluator: ${clause}`)
        })
      default:
        throw new Error(`unsupported filter in test evaluator: ${method}`)
    }
  }

  function applyUpdates(row: Row): Row {
    let next = { ...row }
    for (const call of currentState.updateCalls) {
      if (call.filters.every((f) => matches(next, f))) next = { ...next, ...(call.payload as Row) }
    }
    return next
  }

  // The earlier arming, asked about and answered.
  const OLD_ARMING_AT = '2026-09-10T08:00:00.000Z'
  const ROW: Row = {
    venue_id: 'v1',
    guest_id: 'g1',
    intention_key: 'got_the_recommendation',
    eligible_at: OLD_ARMING_AT,
    prompted_at: '2026-09-10T09:00:00.000Z',
    prompt_source: 'classified',
    message_id: 'm-old',
  }

  async function rearm(row: Row): Promise<Row> {
    currentState = newSupabaseState()
    await recordIntentionEligibility({
      venueId: 'v1',
      guestId: 'g1',
      entries: [{ key: 'got_the_recommendation', eligibleAt: REC_ELIGIBLE, rearm: true }],
    })
    return applyUpdates(row)
  }

  async function stamp(row: Row, intention: OpenIntention, messageId: string): Promise<Row> {
    currentState = newSupabaseState()
    classifyIntentionPromptsMock.mockResolvedValue(raised([intention.key]))
    await recordIntentionPrompts({ ...base, messageId, openIntentions: [intention] })
    return applyUpdates(row)
  }

  const askedAboutNewArming = {
    eligible_at: REC_ANCHOR,
    prompted_at: NOW.toISOString(),
    message_id: 'm-new',
  }

  it('re-arm first: the row keeps its old prompt until the stamp closes the new arming', async () => {
    const rearmed = await rearm(ROW)
    expect(rearmed).toMatchObject({ eligible_at: REC_ANCHOR, prompted_at: ROW.prompted_at, message_id: 'm-old' })

    expect(await stamp(rearmed, REC_OPEN, 'm-new')).toMatchObject(askedAboutNewArming)
  })

  it('stamp first: same end state, and the late re-arm reopens nothing', async () => {
    const stamped = await stamp(ROW, REC_OPEN, 'm-new')
    expect(stamped).toMatchObject(askedAboutNewArming)

    expect(await rearm(stamped)).toEqual(stamped)
  })

  it('a stamp from the superseded arming cannot close the re-armed one', async () => {
    const rearmed = await rearm(ROW)
    const stale: OpenIntention = { ...REC_OPEN, eligibleAt: new Date(OLD_ARMING_AT) }

    expect(await stamp(rearmed, stale, 'm-stale')).toEqual(rearmed)
  })

  it('a second stamp on the same arming keeps the first prompt', async () => {
    const first = await stamp(ROW, REC_OPEN, 'm-first')

    expect(await stamp(first, REC_OPEN, 'm-second')).toEqual(first)
  })

  it('from a row that ran out unraised: the re-arm reopens it and the stamp closes it', async () => {
    const ranOut: Row = { ...ROW, prompted_at: null, prompt_source: null, message_id: null }
    const rearmed = await rearm(ranOut)
    expect(rearmed).toMatchObject({ eligible_at: REC_ANCHOR, prompted_at: null })

    expect(await stamp(rearmed, REC_OPEN, 'm-new')).toMatchObject(askedAboutNewArming)
  })

  it('repeating a re-arm changes nothing', async () => {
    const once = await rearm(ROW)

    expect(await rearm(once)).toEqual(once)
  })
})
