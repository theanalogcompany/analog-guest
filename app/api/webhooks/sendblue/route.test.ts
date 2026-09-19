// TAC-492: pins how the Sendblue inbound route decides a new guest's
// created_via, before the Instagram route starts setting 'qr_scan' too.
//
// Written and run green against the route as it stood, in its own commit
// before any Instagram change, so it records existing behaviour rather than
// agreeing with new code. The route had no tests at all while it was enrolling
// guests. Nothing here changes it: the Instagram path is a separate resolver
// and must never share this one.
//
// It drives the real POST with the real signature check (a test secret in the
// env and the matching header), so only the store, the agent hand-off, the
// tap reconciler and waitUntil are stood in for. The store is local to this
// file: the Instagram test store answers only the Instagram handler's queries
// and knows no venue_configs table, and widening it would change a helper
// other tests rely on.
//
// Every guest row is pinned whole with toEqual. created_via is the field under
// test, and a partial match would pass a row that gained or lost a column.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST } from './route'

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  handleInbound: vi.fn(),
  waitUntil: vi.fn(),
  reconcileTapFromInbound: vi.fn(),
}))

vi.mock('@/lib/db/admin', () => ({ createAdminClient: mocks.createAdminClient }))
vi.mock('@/lib/agent', () => ({ handleInbound: mocks.handleInbound }))
vi.mock('@vercel/functions', () => ({ waitUntil: mocks.waitUntil }))
vi.mock('@/lib/pos/reconcile-tap', () => ({ reconcileTapFromInbound: mocks.reconcileTapFromInbound }))

const SECRET = 'test-signing-secret'
const NOW = '2026-09-18T08:00:00.000Z'
const VENUE_ID = 'venue-1'
const VENUE_NUMBER = '+15550009999'
const GUEST_NUMBER = '+15550001234'
const ENROLLMENT = "Hi Le Mil's!"

type Table = 'venues' | 'guests' | 'venue_configs' | 'messages'
type Row = { id: string; [column: string]: unknown }
type StoreError = { message: string; code?: string }

// Answers only the query shapes the inbound path sends:
//   from(t).select(cols).eq(...)...maybeSingle()
//   from(t).insert(row).select(cols).single()
// Anything else is undefined on it and throws, so an unexpected write fails.
// A maybeSingle matching more than one row returns PostgREST's PGRST116, as
// the Instagram test store does: with the neighbouring venue every test seeds
// (useStore), a lookup that lost its venue filter errors instead of quietly
// taking the first row.
function createStore(seed: Partial<Record<Table, Row[]>>) {
  const tables: Record<Table, Row[]> = {
    venues: [...(seed.venues ?? [])],
    guests: [...(seed.guests ?? [])],
    venue_configs: [...(seed.venue_configs ?? [])],
    messages: [...(seed.messages ?? [])],
  }
  const reads: Array<{ table: Table; filters: Array<[string, unknown]> }> = []
  const inserts: Array<{ table: Table; row: Record<string, unknown> }> = []
  const failures = new Map<Table, StoreError>()
  let nextId = 1

  function project(row: Row, columns: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const column of columns.split(',').map((c) => c.trim())) out[column] = row[column] ?? null
    return out
  }

  const client = {
    from(table: Table) {
      if (!(table in tables)) throw new Error(`store: unexpected table ${table}`)
      return {
        select(columns: string) {
          const filters: Array<[string, unknown]> = []
          const builder = {
            eq(column: string, value: unknown) {
              filters.push([column, value])
              return builder
            },
            async maybeSingle() {
              reads.push({ table, filters: [...filters] })
              const failure = failures.get(table)
              if (failure) {
                failures.delete(table)
                return { data: null, error: failure }
              }
              const matches = tables[table].filter((r) => filters.every(([c, v]) => r[c] === v))
              if (matches.length > 1) {
                return { data: null, error: { code: 'PGRST116', message: 'multiple rows returned' } }
              }
              const [row] = matches
              return { data: row ? project(row, columns) : null, error: null }
            },
          }
          return builder
        },
        insert(row: Record<string, unknown>) {
          return {
            select(columns: string) {
              return {
                async single() {
                  inserts.push({ table, row })
                  const stored: Row = { id: `${table}-${nextId++}`, ...row }
                  tables[table].push(stored)
                  return { data: project(stored, columns), error: null }
                },
              }
            },
          }
        },
      }
    },
  }

  return {
    client,
    tables,
    reads,
    inserted: (table: Table) => inserts.filter((i) => i.table === table).map((i) => i.row),
    failNextRead: (table: Table, error: StoreError) => failures.set(table, error),
  }
}

function venueInfo(qrEnrollmentMessage?: string): Record<string, unknown> {
  return {
    address: { line1: '1 Main St', city: 'Oakland', region: 'CA', postalCode: '94607' },
    ...(qrEnrollmentMessage === undefined ? {} : { qrEnrollmentMessage }),
  }
}

const VENUE: Row = { id: VENUE_ID, messaging_phone_number: VENUE_NUMBER }

function configRow(info: unknown): Row {
  return { id: 'config-1', venue_id: VENUE_ID, venue_info: info }
}

// Another venue on its own number, with its own QR message and a guest who
// has the same phone number. Seeded into every test, so both lookups have to
// be scoped to the venue: the guest lookup, or this venue's guest would be
// found and nobody enrolled; the config lookup, or two rows match and the
// scan reads as a failed lookup.
const NEIGHBOUR_ID = 'venue-2'
const NEIGHBOUR_ROWS: Partial<Record<Table, Row[]>> = {
  venues: [{ id: NEIGHBOUR_ID, messaging_phone_number: '+15550008888' }],
  venue_configs: [{ id: 'config-2', venue_id: NEIGHBOUR_ID, venue_info: venueInfo('Hi neighbour!') }],
  guests: [{ id: 'guest-elsewhere', venue_id: NEIGHBOUR_ID, phone_number: GUEST_NUMBER, created_via: 'qr_scan' }],
}

function inbound(content: string | null, handle = 'handle-1'): Request {
  const payload = {
    accountEmail: 'ops@example.com',
    content,
    media_url: '',
    number: GUEST_NUMBER,
    from_number: GUEST_NUMBER,
    to_number: VENUE_NUMBER,
    is_outbound: false,
    message_handle: handle,
    status: 'RECEIVED',
  }
  return new Request('https://webhooks.example.com/api/webhooks/sendblue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sb-signing-secret': SECRET },
    body: JSON.stringify(payload),
  })
}

function newGuestRow(createdVia: 'qr_scan' | 'inbound_message'): Record<string, unknown> {
  return {
    venue_id: VENUE_ID,
    phone_number: GUEST_NUMBER,
    created_via: createdVia,
    first_contacted_at: NOW,
    last_inbound_at: NOW,
    last_interaction_at: NOW,
  }
}

let store: ReturnType<typeof createStore>

function useStore(seed: Partial<Record<Table, Row[]>>): void {
  const tables: Table[] = ['venues', 'guests', 'venue_configs', 'messages']
  store = createStore(
    Object.fromEntries(tables.map((t) => [t, [...(NEIGHBOUR_ROWS[t] ?? []), ...(seed[t] ?? [])]])),
  )
  mocks.createAdminClient.mockReturnValue(store.client)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  vi.stubEnv('SENDBLUE_SIGNING_SECRET', SECRET)
  mocks.handleInbound.mockReturnValue(Promise.resolve())
  mocks.reconcileTapFromInbound.mockReturnValue(Promise.resolve())
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  mocks.createAdminClient.mockReset()
  mocks.handleInbound.mockReset()
  mocks.waitUntil.mockReset()
  mocks.reconcileTapFromInbound.mockReset()
})

describe('Sendblue inbound: a new guest who sends the venue QR message', () => {
  it('is created as qr_scan when the body is exactly the stored message', async () => {
    useStore({ venues: [VENUE], venue_configs: [configRow(venueInfo(ENROLLMENT))] })
    const response = await POST(inbound(ENROLLMENT))

    expect(response.status).toBe(200)
    expect(store.inserted('guests')).toEqual([newGuestRow('qr_scan')])
  })

  it('trims both the body and the stored message before comparing', async () => {
    useStore({ venues: [VENUE], venue_configs: [configRow(venueInfo(`  ${ENROLLMENT} `))] })
    await POST(inbound(`\n${ENROLLMENT}  `))

    expect(store.inserted('guests')).toEqual([newGuestRow('qr_scan')])
  })

  // The whole row as the route writes it today. It names no channel, relying
  // on messages.channel's 'text' default; TAC-472 changes that on purpose, and
  // this assertion should change with it.
  it('saves the message row as the route writes it today', async () => {
    useStore({ venues: [VENUE], venue_configs: [configRow(venueInfo(ENROLLMENT))] })
    await POST(inbound(ENROLLMENT))

    const guest = store.tables.guests.find((g) => g.venue_id === VENUE_ID)
    expect(store.inserted('messages')).toEqual([
      {
        venue_id: VENUE_ID,
        guest_id: guest?.id,
        direction: 'inbound',
        status: 'received',
        body: ENROLLMENT,
        media_urls: [],
        provider_message_id: 'handle-1',
      },
    ])
    expect(mocks.handleInbound).toHaveBeenCalledWith(store.tables.messages[0]?.id)
  })
})

describe('Sendblue inbound: a new guest who sends anything else', () => {
  it.each<[string, string]>([
    ['different punctuation', "Hi Le Mil's"],
    ['different case', "hi le mil's!"],
    ['the message inside a longer one', `${ENROLLMENT} can I get a latte`],
    ['an ordinary first text', 'are you open today?'],
  ])('is created as inbound_message for %s', async (_case, body) => {
    useStore({ venues: [VENUE], venue_configs: [configRow(venueInfo(ENROLLMENT))] })
    await POST(inbound(body))

    expect(store.inserted('guests')).toEqual([newGuestRow('inbound_message')])
  })

  it('is created as inbound_message when the venue has no QR message stored', async () => {
    useStore({ venues: [VENUE], venue_configs: [configRow(venueInfo())] })
    await POST(inbound(ENROLLMENT))

    expect(store.inserted('guests')).toEqual([newGuestRow('inbound_message')])
  })

  // Both blank, so they are equal once trimmed: only the route's two blank
  // guards keep this from reading as a scan.
  it('is created as inbound_message when the stored QR message and the body are both blank', async () => {
    useStore({ venues: [VENUE], venue_configs: [configRow(venueInfo('   '))] })
    await POST(inbound('   '))

    expect(store.inserted('guests')).toEqual([newGuestRow('inbound_message')])
  })

  it('is created as inbound_message when venue_info does not parse', async () => {
    useStore({ venues: [VENUE], venue_configs: [configRow({ qrEnrollmentMessage: ENROLLMENT })] })
    await POST(inbound(ENROLLMENT))

    expect(store.inserted('guests')).toEqual([newGuestRow('inbound_message')])
  })

  it('is created as inbound_message when the venue has no config row', async () => {
    useStore({ venues: [VENUE] })
    await POST(inbound(ENROLLMENT))

    expect(store.inserted('guests')).toEqual([newGuestRow('inbound_message')])
  })

  it('is created as inbound_message when the config lookup fails', async () => {
    useStore({ venues: [VENUE], venue_configs: [configRow(venueInfo(ENROLLMENT))] })
    store.failNextRead('venue_configs', { message: 'connection reset' })
    await POST(inbound(ENROLLMENT))

    expect(store.inserted('guests')).toEqual([newGuestRow('inbound_message')])
  })
})

describe('Sendblue inbound: a guest the venue already has', () => {
  it('is never re-labelled, and the QR message is not even looked up', async () => {
    const existing: Row = { id: 'guest-1', venue_id: VENUE_ID, phone_number: GUEST_NUMBER, created_via: 'inbound_message' }
    useStore({ venues: [VENUE], guests: [existing], venue_configs: [configRow(venueInfo(ENROLLMENT))] })
    await POST(inbound(ENROLLMENT))

    expect(store.inserted('guests')).toEqual([])
    expect(store.reads.some((r) => r.table === 'venue_configs')).toBe(false)
    expect(store.tables.guests.filter((g) => g.venue_id === VENUE_ID)).toEqual([existing])
    expect(store.inserted('messages')).toMatchObject([{ guest_id: 'guest-1', body: ENROLLMENT }])
  })
})
