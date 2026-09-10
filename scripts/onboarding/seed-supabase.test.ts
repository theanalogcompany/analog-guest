/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/rag', () => ({
  ingestCorpusEntry: vi.fn(),
  ingestKnowledgeCorpusEntry: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { ingestCorpusEntry, ingestKnowledgeCorpusEntry } from '@/lib/rag'
import type { BrandPersona, VenueInfo } from '@/lib/schemas'
import type { ParsedVenueSpec } from './parse-venue-spec'
import { seedVenue } from './seed-supabase'

const EXISTING_VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NEW_VENUE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const CONFIG_STORE_TABLES = ['venue_configs', 'mechanics', 'voice_corpus', 'knowledge_corpus'] as const

const brandPersona: BrandPersona = {
  tone: 'warm',
  formality: 'warm',
  speakerFraming: 'venue',
  signaturePhrases: [],
  bannedTopics: [],
  emojiPolicy: 'never',
  lengthGuide: 'short',
  voiceAntiPatterns: [],
  voiceTouchstones: [],
}

const venueInfo: VenueInfo = {
  address: { line1: '123 Main St', city: 'Testville', region: 'CA', postalCode: '90210' },
  contact: {},
  hours: {},
  menu: { highlights: [], items: [] },
  staff: [],
  currentContext: [],
}

function baseParsed(overrides: Partial<ParsedVenueSpec> = {}): ParsedVenueSpec {
  return {
    slug: 'test-venue',
    name: 'Test Venue',
    timezone: 'America/Los_Angeles',
    brandPersona,
    venueInfo,
    mechanics: [],
    voiceCorpus: [],
    knowledgeCorpus: [],
    ...overrides,
  }
}

interface MockState {
  existingVenue: { id: string; slug: string } | null
  checkError: { message: string } | null
  // TAC-343 (plan review): narrowed force only ever deletes config-store
  // tables, keyed by venue_id — never the venues row itself.
  configDeleteCalls: Array<{ table: string; venueId: string }>
  configDeleteError: { table: string; message: string } | null
  hasGuests: boolean
  hasMessages: boolean
  guestsCheckError: { message: string } | null
  messagesCheckError: { message: string } | null
  insertedVenueId: string
  venueInsertError: { message: string } | null
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    existingVenue: null,
    checkError: null,
    configDeleteCalls: [],
    configDeleteError: null,
    hasGuests: false,
    hasMessages: false,
    guestsCheckError: null,
    messagesCheckError: null,
    insertedVenueId: NEW_VENUE_ID,
    venueInsertError: null,
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (table: string) => {
      if (table === 'venues') {
        return {
          select: (_cols: string) => ({
            eq: (_f: string, _v: string) => ({
              maybeSingle: async () => {
                if (state.checkError) return { data: null, error: state.checkError }
                return { data: state.existingVenue, error: null }
              },
            }),
          }),
          insert: (_row: Record<string, unknown>) => ({
            select: (_cols: string) => ({
              single: async () => {
                if (state.venueInsertError) {
                  return { data: null, error: state.venueInsertError }
                }
                return { data: { id: state.insertedVenueId }, error: null }
              },
            }),
          }),
        }
      }
      if (table === 'guests') {
        return {
          select: (_cols: string) => ({
            eq: (_f: string, _v: string) => ({
              limit: async (_n: number) => {
                if (state.guestsCheckError) return { data: null, error: state.guestsCheckError }
                return { data: state.hasGuests ? [{ id: 'guest-1' }] : [], error: null }
              },
            }),
          }),
        }
      }
      if (table === 'messages') {
        return {
          select: (_cols: string) => ({
            eq: (_f: string, _v: string) => ({
              limit: async (_n: number) => {
                if (state.messagesCheckError) return { data: null, error: state.messagesCheckError }
                return { data: state.hasMessages ? [{ id: 'message-1' }] : [], error: null }
              },
            }),
          }),
        }
      }
      // Config stores — venue_configs / mechanics / voice_corpus /
      // knowledge_corpus. `insert(...)` is awaited directly in some call
      // sites (venue_configs, mechanics) and chained with `.select('id')` in
      // others (voice_corpus, knowledge_corpus), so the returned builder must
      // be thenable AND expose `.select()`, matching the real Supabase
      // query-builder shape. `delete().eq('venue_id', id)` is the narrowed
      // --force path.
      return {
        insert: (_row: unknown) => {
          const resolved = Promise.resolve({ data: [], error: null })
          return {
            then: resolved.then.bind(resolved),
            catch: resolved.catch.bind(resolved),
            select: (_cols: string) => Promise.resolve({ data: [], error: null }),
          }
        },
        delete: () => ({
          eq: async (_f: string, v: unknown) => {
            state.configDeleteCalls.push({ table, venueId: String(v) })
            if (state.configDeleteError && state.configDeleteError.table === table) {
              return { error: { message: state.configDeleteError.message } }
            }
            return { error: null }
          },
        }),
      }
    },
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(ingestCorpusEntry).mockReset()
  vi.mocked(ingestKnowledgeCorpusEntry).mockReset()
})

describe('seedVenue — already-seeded guard (TAC-343 Phase 0b)', () => {
  it('refuses when a venue with the slug already exists and force is not passed', async () => {
    const state = newState({ existingVenue: { id: EXISTING_VENUE_ID, slug: 'test-venue' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    await expect(
      seedVenue({ parsed: baseParsed(), messagingPhoneNumber: null, menuItems: [] }),
    ).rejects.toThrow(/already exists/)

    expect(state.configDeleteCalls).toEqual([])
  })

  it('refusal message points at --force rather than a manual Studio delete', async () => {
    const state = newState({ existingVenue: { id: EXISTING_VENUE_ID, slug: 'test-venue' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    await expect(
      seedVenue({ parsed: baseParsed(), messagingPhoneNumber: null, menuItems: [] }),
    ).rejects.toThrow(/--force/)
  })

  it('refusal covers every store, not only menu.items — nothing is written before the guard', async () => {
    const state = newState({ existingVenue: { id: EXISTING_VENUE_ID, slug: 'test-venue' } })
    const mock = makeSupabaseMock(state)
    const fromSpy = vi.fn(mock.from)
    vi.mocked(createAdminClient).mockReturnValue({
      from: fromSpy,
    } as unknown as ReturnType<typeof createAdminClient>)

    await expect(
      seedVenue({
        parsed: baseParsed({ mechanics: [{ type: 'perk', name: 'Perk', trigger: {} }] }),
        messagingPhoneNumber: null,
        menuItems: [],
      }),
    ).rejects.toThrow(/already exists/)

    // Only the existence check itself touches the venues table; no other
    // table (guests, messages, venue_configs, mechanics, voice_corpus,
    // knowledge_corpus) is ever reached because the guard throws before any
    // insert or delete.
    expect(fromSpy).toHaveBeenCalledTimes(1)
    expect(fromSpy).toHaveBeenCalledWith('venues')
  })

  it('does not refuse and does not delete when no venue with the slug exists', async () => {
    const state = newState({ existingVenue: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await seedVenue({
      parsed: baseParsed(),
      messagingPhoneNumber: null,
      menuItems: [],
    })

    expect(result.venueId).toBe(NEW_VENUE_ID)
    expect(state.configDeleteCalls).toEqual([])
  })
})

describe('seedVenue — narrowed --force (TAC-343 plan review)', () => {
  it('deletes and rewrites config stores only, reuses the existing venue id, and never touches the venues row', async () => {
    const state = newState({ existingVenue: { id: EXISTING_VENUE_ID, slug: 'test-venue' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await seedVenue({
      parsed: baseParsed(),
      messagingPhoneNumber: null,
      menuItems: [],
      force: true,
    })

    // Reuses the EXISTING venue id — force never inserts a fresh venues row.
    expect(result.venueId).toBe(EXISTING_VENUE_ID)

    // Exactly the four config-store tables were deleted, scoped to the
    // existing venue id. No delete call for 'venues' (or any other table)
    // appears here at all — only these four tables ever call `.delete()`.
    expect(state.configDeleteCalls).toEqual(
      CONFIG_STORE_TABLES.map((table) => ({ table, venueId: EXISTING_VENUE_ID })),
    )

    expect(warnSpy).toHaveBeenCalled()
    const warnedText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warnedText).toContain('--force')
    expect(warnedText).toContain('test-venue')
    expect(warnedText).toContain('untouched')

    warnSpy.mockRestore()
  })

  it('refuses outright when the venue has guests, even with force, and deletes nothing', async () => {
    const state = newState({
      existingVenue: { id: EXISTING_VENUE_ID, slug: 'test-venue' },
      hasGuests: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      seedVenue({
        parsed: baseParsed(),
        messagingPhoneNumber: null,
        menuItems: [],
        force: true,
      }),
    ).rejects.toThrow(/guest history/)

    expect(state.configDeleteCalls).toEqual([])
  })

  it('refuses outright when the venue has messages, even with force, and deletes nothing', async () => {
    const state = newState({
      existingVenue: { id: EXISTING_VENUE_ID, slug: 'test-venue' },
      hasMessages: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      seedVenue({
        parsed: baseParsed(),
        messagingPhoneNumber: null,
        menuItems: [],
        force: true,
      }),
    ).rejects.toThrow(/guest history/)

    expect(state.configDeleteCalls).toEqual([])
  })

  it('surfaces a clear error if a config-store delete itself fails, without inserting anything', async () => {
    const state = newState({
      existingVenue: { id: EXISTING_VENUE_ID, slug: 'test-venue' },
      configDeleteError: { table: 'mechanics', message: 'fk violation' },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      seedVenue({
        parsed: baseParsed(),
        messagingPhoneNumber: null,
        menuItems: [],
        force: true,
      }),
    ).rejects.toThrow(/fk violation/)
  })

  it('guest/message check failures surface as errors rather than silently proceeding', async () => {
    const state = newState({
      existingVenue: { id: EXISTING_VENUE_ID, slug: 'test-venue' },
      guestsCheckError: { message: 'connection lost' },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      seedVenue({
        parsed: baseParsed(),
        messagingPhoneNumber: null,
        menuItems: [],
        force: true,
      }),
    ).rejects.toThrow(/connection lost/)

    expect(state.configDeleteCalls).toEqual([])
  })
})
