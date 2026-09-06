# Operator Conversations Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new operator-facing endpoints — `GET /api/operator/conversations` (list every guest conversation across the operator's allowed venues) and `GET /api/operator/guests/:guestId/thread` (full thread for one guest) — so the sibling `analog-operator` app's new Conversations tab has something real to call.

**Architecture:** One new Postgres RPC (`list_operator_conversations`) does the guest+last-message+recognition-state join in a single round trip, mirroring the existing `list_operator_queue` RPC (migration 018). A thin `lib/operator/conversations.ts` projects RPC rows into the wire shape. The per-guest thread endpoint reuses the existing per-message thread endpoint's message-fetch logic via a small extraction (`fetchThreadMessagesForGuest`) out of `lib/operator/thread.ts`, so both thread endpoints share one query path instead of duplicating it. Both routes use the same inline `verifyOperatorRequest` + Contract-shaped-error-body pattern as the existing `/api/operator/messages/[id]/thread` route (not the legacy `withOperatorAuth` HOF).

**Tech Stack:** Next.js App Router route handlers, Supabase (Postgres + `@supabase/supabase-js` admin client), Vitest.

**Spec:** `analog-operator/docs/superpowers/specs/2026-09-05-conversations-tab-design.md` — the "Cross-repo Contract" and "`analog-guest` implementation" sections are what this plan implements. Read that spec's Contract section before starting; this plan's request/response shapes are transcribed from it and must not drift.

## Global Constraints

- Auth: inline `verifyOperatorRequest` (from `@/lib/auth`), NOT `withOperatorAuth` — error bodies must be exactly `{"error":"unauthorized"}` (401) / `{"error":"not_found"}` (404) / `{"error":"internal_error"}` (500), matching the existing `/api/operator/messages/[id]/thread` route.
- Both "resource doesn't exist" and "resource exists outside the operator's allowlist" collapse to the same 404 — never leak existence.
- Empty `allowedVenueIds` on the list endpoint returns `200 { "conversations": [] }`, not an error.
- `conversationCount` / `firstConversationAt` / `lastMessageAt` / `lastMessagePreview` all exclude empty-body messages (`body <> ''`), matching the existing `loadGuestThread` convention.
- 200-row soft cap on the conversations list, matching the existing queue's cap.
- No production deploy as part of this plan. The migration must be applied to a real Supabase database before curl-verification is possible — that step is manual and requires explicit user action (see Task 8).
- Test runner is Vitest (`npm test` = `vitest run`), not Jest — this is a different repo from `analog-operator`.

---

## Task 1: Migration — `list_operator_conversations` RPC

**Files:**
- Create: `db/migrations/033_operator_conversations.sql`

**Interfaces:**
- Produces: a Postgres function `public.list_operator_conversations(venue_ids uuid[])` returning one row per guest with columns `guest_id, venue_id, venue_slug, venue_timezone, agent_name, guest_first_name, guest_last_name, guest_phone, recognition_state, last_message_at, last_message_direction, last_message_body, conversation_count, first_conversation_at`. Task 2 calls this via `supabase.rpc('list_operator_conversations', { venue_ids })`.

There's no automated SQL test for this in the existing codebase (`list_operator_queue` in migration 018 has none either — it's exercised only through the TS-layer mocked tests in Task 2, and through manual curl verification in Task 8). This task is: write the file, then a manual apply step.

- [ ] **Step 1: Write the migration file**

```sql
-- ============================================================================
-- migration 033: operator conversations list RPC
-- ============================================================================
-- Powers GET /api/operator/conversations (cross-repo sibling: analog-operator
-- Conversations tab). Returns one row per guest with any non-empty-body
-- message at one of the operator's allowed venues, most-recently-active
-- first, capped at 200 rows — same soft cap as list_operator_queue
-- (migration 018).
--
-- conversation_count / first_conversation_at are NOT stored facts — they're
-- computed here as "distinct venue-local calendar days with activity" per
-- the design spec (analog-operator's
-- docs/superpowers/specs/2026-09-05-conversations-tab-design.md). Recomputing
-- per request is fine at pilot scale; if this ever needs to be fast at
-- volume, materializing it is a follow-up.
--
-- agent_name: venue_configs.brand_persona->>'voiceName' if set, else the
-- venue's display name — same fallback documented on BrandPersonaSchema
-- (lib/schemas/brand-persona.ts).
--
-- recognition_state: guest_states row where exited_at IS NULL, scoped to
-- BOTH guest_id and venue_id (a guest can in principle appear at more than
-- one venue). Same source as list_operator_queue.
--
-- Column citations (same sources list_operator_queue's own comment cites):
--   guests         — first_name, last_name, phone_number. db/types.ts.
--   guest_states   — guest_id, venue_id, state, exited_at. db/types.ts.
--   venues         — slug, name, timezone. db/types.ts.
--   venue_configs  — venue_id, brand_persona (jsonb). db/types.ts:1254.
--   messages       — venue_id, guest_id, direction, body, created_at.

create or replace function public.list_operator_conversations(
  venue_ids uuid[]
)
returns table(
  guest_id uuid,
  venue_id uuid,
  venue_slug text,
  venue_timezone text,
  agent_name text,
  guest_first_name text,
  guest_last_name text,
  guest_phone text,
  recognition_state text,
  last_message_at timestamptz,
  last_message_direction text,
  last_message_body text,
  conversation_count bigint,
  first_conversation_at timestamptz
)
language sql
stable
as $function$
  with scoped_messages as (
    select m.venue_id, m.guest_id, m.direction, m.body, m.created_at
    from messages m
    where m.venue_id = any(venue_ids)
      and m.body <> ''
  ),
  last_message as (
    select distinct on (guest_id, venue_id)
      guest_id, venue_id, direction, body, created_at
    from scoped_messages
    order by guest_id, venue_id, created_at desc
  ),
  conversation_days as (
    select
      sm.guest_id,
      sm.venue_id,
      count(distinct date_trunc('day', sm.created_at at time zone coalesce(v.timezone, 'UTC'))) as day_count,
      min(sm.created_at) as first_at
    from scoped_messages sm
    join venues v on v.id = sm.venue_id
    group by sm.guest_id, sm.venue_id
  )
  select
    lm.guest_id,
    lm.venue_id,
    v.slug as venue_slug,
    v.timezone as venue_timezone,
    coalesce(vc.brand_persona ->> 'voiceName', v.name) as agent_name,
    g.first_name as guest_first_name,
    g.last_name as guest_last_name,
    g.phone_number as guest_phone,
    gs.state as recognition_state,
    lm.created_at as last_message_at,
    lm.direction as last_message_direction,
    lm.body as last_message_body,
    cd.day_count as conversation_count,
    cd.first_at as first_conversation_at
  from last_message lm
  join venues v on v.id = lm.venue_id
  join guests g on g.id = lm.guest_id
  join conversation_days cd
    on cd.guest_id = lm.guest_id and cd.venue_id = lm.venue_id
  left join venue_configs vc on vc.venue_id = lm.venue_id
  left join guest_states gs
    on gs.guest_id = lm.guest_id
   and gs.venue_id = lm.venue_id
   and gs.exited_at is null
  order by lm.created_at desc
  limit 200;
$function$;

-- ============================================================================
-- end of migration
-- ============================================================================
```

- [ ] **Step 2: Commit the migration file**

```bash
git add db/migrations/033_operator_conversations.sql
git commit -m "add list_operator_conversations RPC (migration 033)"
```

- [ ] **Step 3 (⚠️ MANUAL — do not run automatically):** This migration must be applied to the project's actual Supabase database before Task 8's curl verification can run. This repo has no local Supabase stack (`db:types` points at a hosted project id) — applying a migration means running SQL against shared infrastructure. **Stop here and apply it yourself** (Supabase dashboard SQL editor, or however you normally run migrations against this project), confirming with Jaipal which project/branch to target if there's any doubt. Do not let an executing agent run this against the database on its own judgment.

---

## Task 2: `lib/operator/conversations.ts` — RPC projection layer

**Files:**
- Create: `lib/operator/conversations.ts`
- Test: `lib/operator/conversations.test.ts`

**Interfaces:**
- Consumes: `createAdminClient` from `@/lib/db/admin` (existing).
- Produces: `type ConversationSummary`, `type ListOperatorConversationsResult`, `function listOperatorConversations(allowedVenueIds: string[]): Promise<ListOperatorConversationsResult>` — Task 5 (the route) calls this.

- [ ] **Step 1: Write the failing test**

```ts
// lib/operator/conversations.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listOperatorConversations } from './conversations'

const rpcMock = vi.fn()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}))

beforeEach(() => {
  rpcMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

const RAW_ROW = {
  guest_id: '00000000-0000-0000-0000-000000000001',
  venue_id: '00000000-0000-0000-0000-00000000000a',
  venue_slug: 'mock-sextant',
  venue_timezone: 'America/Los_Angeles',
  agent_name: 'Sana',
  guest_first_name: 'Maya',
  guest_last_name: 'R.',
  guest_phone: '+15551110001',
  recognition_state: 'returning',
  last_message_at: '2026-09-05T21:39:00.000Z',
  last_message_direction: 'outbound',
  last_message_body: 'Done — got you down for two at 7:30.',
  conversation_count: 4,
  first_conversation_at: '2026-06-10T18:00:00.000Z',
}

describe('listOperatorConversations', () => {
  it('returns ok:true with an empty array and skips the RPC when allowedVenueIds is empty', async () => {
    const result = await listOperatorConversations([])
    expect(result).toEqual({ ok: true, conversations: [] })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('calls the RPC with venue_ids and projects rows to camelCase', async () => {
    rpcMock.mockResolvedValueOnce({ data: [RAW_ROW], error: null })
    const result = await listOperatorConversations(['00000000-0000-0000-0000-00000000000a'])
    expect(rpcMock).toHaveBeenCalledWith('list_operator_conversations', {
      venue_ids: ['00000000-0000-0000-0000-00000000000a'],
    })
    expect(result).toEqual({
      ok: true,
      conversations: [
        {
          guestId: '00000000-0000-0000-0000-000000000001',
          venueId: '00000000-0000-0000-0000-00000000000a',
          venueSlug: 'mock-sextant',
          venueTimezone: 'America/Los_Angeles',
          agentName: 'Sana',
          name: 'Maya R.',
          phoneFallback: '+15551110001',
          recognitionState: 'returning',
          lastMessageAt: '2026-09-05T21:39:00.000Z',
          lastMessageDirection: 'outbound',
          lastMessagePreview: 'Done — got you down for two at 7:30.',
          conversationCount: 4,
          firstConversationAt: '2026-06-10T18:00:00.000Z',
        },
      ],
    })
  })

  it('composes name from first+last, null when both are absent', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ ...RAW_ROW, guest_first_name: null, guest_last_name: null }],
      error: null,
    })
    const result = await listOperatorConversations(['v1'])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.conversations[0].name).toBeNull()
  })

  it('normalizes an unrecognized recognition_state to null', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ ...RAW_ROW, recognition_state: 'something_unexpected' }],
      error: null,
    })
    const result = await listOperatorConversations(['v1'])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.conversations[0].recognitionState).toBeNull()
  })

  it('drops a row with an invalid last_message_direction', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ ...RAW_ROW, last_message_direction: 'sideways' }],
      error: null,
    })
    const result = await listOperatorConversations(['v1'])
    expect(result).toEqual({ ok: true, conversations: [] })
  })

  it('returns ok:false on RPC error', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } })
    const result = await listOperatorConversations(['v1'])
    expect(result).toEqual({ ok: false, error: 'connection lost' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/operator/conversations.test.ts`
Expected: FAIL — `Cannot find module './conversations'` (or similar).

- [ ] **Step 3: Write the implementation**

```ts
// lib/operator/conversations.ts
// Powers GET /api/operator/conversations. Projects list_operator_conversations
// RPC rows (migration 033) into the wire shape locked by the Contract in
// analog-operator's docs/superpowers/specs/2026-09-05-conversations-tab-design.md.

import { createAdminClient } from '@/lib/db/admin'

export type GuestRecognitionState = 'new' | 'returning' | 'regular' | 'raving_fan'

export interface ConversationSummary {
  guestId: string
  venueId: string
  venueSlug: string
  venueTimezone: string | null
  agentName: string
  name: string | null
  phoneFallback: string
  recognitionState: GuestRecognitionState | null
  lastMessageAt: string
  lastMessageDirection: 'inbound' | 'outbound'
  lastMessagePreview: string
  conversationCount: number
  firstConversationAt: string
}

export type ListOperatorConversationsResult =
  | { ok: true; conversations: ConversationSummary[] }
  | { ok: false; error: string }

const RECOGNITION_STATE_VALUES: ReadonlySet<string> = new Set([
  'new',
  'returning',
  'regular',
  'raving_fan',
])

function normalizeRecognitionState(s: string | null): GuestRecognitionState | null {
  if (s === null) return null
  return RECOGNITION_STATE_VALUES.has(s) ? (s as GuestRecognitionState) : null
}

function composeName(first: string | null, last: string | null): string | null {
  const parts = [first, last].filter((p): p is string => !!p && p.trim().length > 0)
  return parts.length > 0 ? parts.join(' ') : null
}

interface RawConversationRow {
  guest_id: string
  venue_id: string
  venue_slug: string
  venue_timezone: string | null
  agent_name: string
  guest_first_name: string | null
  guest_last_name: string | null
  guest_phone: string
  recognition_state: string | null
  last_message_at: string
  last_message_direction: string
  last_message_body: string
  conversation_count: number
  first_conversation_at: string
}

export async function listOperatorConversations(
  allowedVenueIds: string[],
): Promise<ListOperatorConversationsResult> {
  if (allowedVenueIds.length === 0) {
    return { ok: true, conversations: [] }
  }

  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('list_operator_conversations', {
    venue_ids: allowedVenueIds,
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  const conversations: ConversationSummary[] = []
  for (const row of (data ?? []) as RawConversationRow[]) {
    if (row.last_message_direction !== 'inbound' && row.last_message_direction !== 'outbound') {
      continue
    }
    conversations.push({
      guestId: row.guest_id,
      venueId: row.venue_id,
      venueSlug: row.venue_slug,
      venueTimezone: row.venue_timezone,
      agentName: row.agent_name,
      name: composeName(row.guest_first_name, row.guest_last_name),
      phoneFallback: row.guest_phone,
      recognitionState: normalizeRecognitionState(row.recognition_state),
      lastMessageAt: row.last_message_at,
      lastMessageDirection: row.last_message_direction,
      lastMessagePreview: row.last_message_body,
      conversationCount: row.conversation_count,
      firstConversationAt: row.first_conversation_at,
    })
  }

  return { ok: true, conversations }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/operator/conversations.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/operator/conversations.ts lib/operator/conversations.test.ts
git commit -m "add listOperatorConversations projection layer"
```

---

## Task 3: Extract `fetchThreadMessagesForGuest` from `lib/operator/thread.ts`

Refactor only — no behavior change. `loadGuestThread`'s existing tests must still pass unmodified, since the mocked call sequence against `createAdminClient()` doesn't change (same two `.from('messages')`-shaped queries happen, just issued from two functions instead of one).

**Files:**
- Modify: `lib/operator/thread.ts`
- Test: `lib/operator/thread.test.ts` (existing — must still pass, no edits expected)

**Interfaces:**
- Produces: `export async function fetchThreadMessagesForGuest(supabase: ReturnType<typeof createAdminClient>, venueId: string, guestId: string): Promise<{ ok: true; messages: ThreadMessage[] } | { ok: false; error: string }>` — Task 4 imports this.

- [ ] **Step 1: Run the existing test suite first to establish a passing baseline**

Run: `npx vitest run lib/operator/thread.test.ts`
Expected: PASS (existing suite, before any change)

- [ ] **Step 2: Extract the fetch+project block into a new exported function**

In `lib/operator/thread.ts`, replace the body of `loadGuestThread` from the `// ---- 2. fetch the most-recent N non-empty-body messages...` comment onward with a call to a new exported function that does the same work:

```ts
// Add this function to lib/operator/thread.ts, above loadGuestThread:

/**
 * Fetches up to THREAD_MESSAGE_LIMIT non-empty-body messages for a resolved
 * (venueId, guestId) pair, oldest→newest. Shared by loadGuestThread (keyed
 * off a messageId, resolves venue/guest first) and loadGuestThreadByGuestId
 * (lib/operator/guest-thread.ts, keyed directly off guestId) so both thread
 * endpoints run the identical query instead of drifting independently.
 */
export async function fetchThreadMessagesForGuest(
  supabase: ReturnType<typeof createAdminClient>,
  venueId: string,
  guestId: string,
): Promise<{ ok: true; messages: ThreadMessage[] } | { ok: false; error: string }> {
  const { data: rows, error: threadErr } = await supabase
    .from('messages')
    .select('id, body, direction, created_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .neq('body', '')
    .order('created_at', { ascending: false })
    .limit(THREAD_MESSAGE_LIMIT)

  if (threadErr) {
    return { ok: false, error: threadErr.message }
  }

  const recentDesc = rows ?? []
  const messages: ThreadMessage[] = []
  for (let i = recentDesc.length - 1; i >= 0; i--) {
    const r = recentDesc[i]!
    if (r.direction !== 'inbound' && r.direction !== 'outbound') continue
    messages.push({
      id: r.id,
      direction: r.direction,
      body: r.body,
      createdAt: r.created_at,
    })
  }

  return { ok: true, messages }
}
```

Then update `loadGuestThread` to call it instead of duplicating the query:

```ts
export async function loadGuestThread(
  input: LoadGuestThreadInput,
): Promise<LoadGuestThreadResult> {
  if (input.allowedVenueIds.length === 0) {
    return { ok: false, errorCode: 'out_of_allowlist' }
  }

  const supabase = createAdminClient()

  const { data: row, error: lookupErr } = await supabase
    .from('messages')
    .select('venue_id, guest_id')
    .eq('id', input.messageId)
    .maybeSingle()

  if (lookupErr) {
    return { ok: false, errorCode: 'db_error', error: lookupErr.message }
  }
  if (!row) {
    return { ok: false, errorCode: 'message_not_found' }
  }
  if (!input.allowedVenueIds.includes(row.venue_id)) {
    return { ok: false, errorCode: 'out_of_allowlist' }
  }

  const result = await fetchThreadMessagesForGuest(supabase, row.venue_id, row.guest_id)
  if (!result.ok) {
    return { ok: false, errorCode: 'db_error', error: result.error }
  }
  return { ok: true, messages: result.messages }
}
```

(Leave `createAdminClient`, `THREAD_MESSAGE_LIMIT`, `ThreadMessage`, and the existing type exports exactly as they are — only the query body moves.)

- [ ] **Step 3: Run the existing test suite to confirm no regression**

Run: `npx vitest run lib/operator/thread.test.ts`
Expected: PASS — same test count as Step 1, unmodified.

- [ ] **Step 4: Commit**

```bash
git add lib/operator/thread.ts
git commit -m "extract fetchThreadMessagesForGuest from loadGuestThread"
```

---

## Task 4: `lib/operator/guest-thread.ts` — thread lookup keyed by guestId

**Files:**
- Create: `lib/operator/guest-thread.ts`
- Test: `lib/operator/guest-thread.test.ts`

**Interfaces:**
- Consumes: `fetchThreadMessagesForGuest` from `./thread` (Task 3).
- Produces: `type LoadGuestThreadByGuestIdResult`, `function loadGuestThreadByGuestId(input: { guestId: string; allowedVenueIds: string[] }): Promise<LoadGuestThreadByGuestIdResult>` — Task 6's route calls this.

- [ ] **Step 1: Write the failing test**

```ts
// lib/operator/guest-thread.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadGuestThreadByGuestId } from './guest-thread'

const VENUE_A = '00000000-0000-0000-0000-00000000000a'
const VENUE_B = '00000000-0000-0000-0000-00000000000b'
const GUEST_X = '00000000-0000-0000-0000-000000000001'

let nextGuestLookup: { data: unknown; error: { message: string } | null } = {
  data: null,
  error: null,
}
let nextThreadRows: { data: unknown; error: { message: string } | null } = {
  data: [],
  error: null,
}

const limitMock = vi.fn(() => Promise.resolve(nextThreadRows))
const orderMock = vi.fn(() => ({ limit: limitMock }))
const neqMock = vi.fn(() => ({ order: orderMock }))
const eqGuestMock = vi.fn(() => ({ neq: neqMock }))
const eqVenueMock = vi.fn(() => ({ eq: eqGuestMock }))
const maybeSingleMock = vi.fn(() => Promise.resolve(nextGuestLookup))
const eqIdMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }))

const selectMock = vi.fn((cols: string) => {
  if (cols === 'venue_id') return { eq: eqIdMock }
  return { eq: eqVenueMock }
})
const fromMock = vi.fn(() => ({ select: selectMock }))

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({ from: fromMock }),
}))

beforeEach(() => {
  nextGuestLookup = { data: null, error: null }
  nextThreadRows = { data: [], error: null }
  fromMock.mockClear()
  selectMock.mockClear()
  eqIdMock.mockClear()
  maybeSingleMock.mockClear()
  eqVenueMock.mockClear()
  eqGuestMock.mockClear()
  neqMock.mockClear()
  orderMock.mockClear()
  limitMock.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('loadGuestThreadByGuestId', () => {
  it('short-circuits to out_of_allowlist when allowedVenueIds is empty', async () => {
    const result = await loadGuestThreadByGuestId({ guestId: GUEST_X, allowedVenueIds: [] })
    expect(result).toEqual({ ok: false, errorCode: 'out_of_allowlist' })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('returns guest_not_found when the guest lookup returns no row', async () => {
    nextGuestLookup = { data: null, error: null }
    const result = await loadGuestThreadByGuestId({
      guestId: GUEST_X,
      allowedVenueIds: [VENUE_A],
    })
    expect(result).toEqual({ ok: false, errorCode: 'guest_not_found' })
    expect(eqIdMock).toHaveBeenCalledWith('id', GUEST_X)
  })

  it('returns out_of_allowlist when the guest exists at a venue outside the allowlist', async () => {
    nextGuestLookup = { data: { venue_id: VENUE_B }, error: null }
    const result = await loadGuestThreadByGuestId({
      guestId: GUEST_X,
      allowedVenueIds: [VENUE_A],
    })
    expect(result).toEqual({ ok: false, errorCode: 'out_of_allowlist' })
    expect(eqVenueMock).not.toHaveBeenCalled()
  })

  it('returns the thread for a guest inside the allowlist', async () => {
    nextGuestLookup = { data: { venue_id: VENUE_A }, error: null }
    nextThreadRows = {
      data: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          body: 'hey!',
          direction: 'inbound',
          created_at: '2026-09-05T18:00:00.000Z',
        },
      ],
      error: null,
    }
    const result = await loadGuestThreadByGuestId({
      guestId: GUEST_X,
      allowedVenueIds: [VENUE_A],
    })
    expect(result).toEqual({
      ok: true,
      messages: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          direction: 'inbound',
          body: 'hey!',
          createdAt: '2026-09-05T18:00:00.000Z',
        },
      ],
    })
    expect(eqGuestMock).toHaveBeenCalledWith('guest_id', GUEST_X)
  })

  it('returns db_error when the guest lookup errors', async () => {
    nextGuestLookup = { data: null, error: { message: 'connection lost' } }
    const result = await loadGuestThreadByGuestId({
      guestId: GUEST_X,
      allowedVenueIds: [VENUE_A],
    })
    expect(result).toEqual({ ok: false, errorCode: 'db_error', error: 'connection lost' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/operator/guest-thread.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// lib/operator/guest-thread.ts
// Powers GET /api/operator/guests/:guestId/thread. Same windowing/filtering
// as loadGuestThread (lib/operator/thread.ts) via the shared
// fetchThreadMessagesForGuest helper — the only difference is the lookup
// key: guestId directly, instead of resolving (venue_id, guest_id) from a
// messageId first.

import { createAdminClient } from '@/lib/db/admin'
import type { ThreadMessage } from '@/lib/schemas'

import { fetchThreadMessagesForGuest } from './thread'

export interface LoadGuestThreadByGuestIdInput {
  guestId: string
  allowedVenueIds: string[]
}

export type LoadGuestThreadByGuestIdErrorCode =
  | 'guest_not_found'
  | 'out_of_allowlist'
  | 'db_error'

export type LoadGuestThreadByGuestIdResult =
  | { ok: true; messages: ThreadMessage[] }
  | { ok: false; errorCode: LoadGuestThreadByGuestIdErrorCode; error?: string }

export async function loadGuestThreadByGuestId(
  input: LoadGuestThreadByGuestIdInput,
): Promise<LoadGuestThreadByGuestIdResult> {
  if (input.allowedVenueIds.length === 0) {
    return { ok: false, errorCode: 'out_of_allowlist' }
  }

  const supabase = createAdminClient()

  const { data: row, error: lookupErr } = await supabase
    .from('guests')
    .select('venue_id')
    .eq('id', input.guestId)
    .maybeSingle()

  if (lookupErr) {
    return { ok: false, errorCode: 'db_error', error: lookupErr.message }
  }
  if (!row) {
    return { ok: false, errorCode: 'guest_not_found' }
  }
  if (!input.allowedVenueIds.includes(row.venue_id)) {
    return { ok: false, errorCode: 'out_of_allowlist' }
  }

  const result = await fetchThreadMessagesForGuest(supabase, row.venue_id, input.guestId)
  if (!result.ok) {
    return { ok: false, errorCode: 'db_error', error: result.error }
  }
  return { ok: true, messages: result.messages }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/operator/guest-thread.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/operator/guest-thread.ts lib/operator/guest-thread.test.ts
git commit -m "add loadGuestThreadByGuestId"
```

---

## Task 5: Export new symbols from `lib/operator/index.ts`

**Files:**
- Modify: `lib/operator/index.ts`

**Interfaces:**
- Consumes: `listOperatorConversations` (Task 2), `loadGuestThreadByGuestId` (Task 4).
- Produces: both re-exported from `@/lib/operator` — Tasks 6 and 7's routes import from there, matching how the existing routes import `loadGuestThread` from `@/lib/operator` rather than `@/lib/operator/thread`.

- [ ] **Step 1: Add the exports**

Append to `lib/operator/index.ts`:

```ts
export {
  type ConversationSummary,
  type GuestRecognitionState as ConversationRecognitionState,
  type ListOperatorConversationsResult,
  listOperatorConversations,
} from './conversations'

export {
  type LoadGuestThreadByGuestIdErrorCode,
  type LoadGuestThreadByGuestIdInput,
  type LoadGuestThreadByGuestIdResult,
  loadGuestThreadByGuestId,
} from './guest-thread'
```

(`GuestRecognitionState` is aliased on export because `./queue` already exports a type of that exact name — both describe the same four-value enum, but re-exporting two same-named types from one barrel file is a TS error. `ConversationRecognitionState` is only used at the type level by anything importing from the barrel; the route handlers in Tasks 6–7 don't need to reference it directly.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/operator/index.ts
git commit -m "export conversations + guest-thread from lib/operator barrel"
```

---

## Task 6: Route — `GET /api/operator/conversations`

**Files:**
- Create: `app/api/operator/conversations/route.ts`
- Test: `app/api/operator/conversations/route.test.ts`

**Interfaces:**
- Consumes: `verifyOperatorRequest`, `AuthError` from `@/lib/auth`; `listOperatorConversations` from `@/lib/operator`.

- [ ] **Step 1: Write the failing test**

```ts
// app/api/operator/conversations/route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const listMock = vi.fn()
vi.mock('@/lib/operator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operator')>('@/lib/operator')
  return {
    ...actual,
    listOperatorConversations: (...args: unknown[]) => listMock(...args),
  }
})

import { GET } from './route'

const VENUE_A = '00000000-0000-0000-0000-00000000000a'

function makeRequest(): Request {
  return new Request('https://example.test/api/operator/conversations', {
    method: 'GET',
    headers: { authorization: 'Bearer fake-jwt' },
  })
}

beforeEach(() => {
  verifyMock.mockReset()
  verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: [VENUE_A] })
  listMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/operator/conversations', () => {
  it("returns 401 {error:'unauthorized'} when AuthError is thrown", async () => {
    const { AuthError } = await import('@/lib/auth/types')
    verifyMock.mockRejectedValueOnce(new AuthError(401, 'invalid or expired token'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(listMock).not.toHaveBeenCalled()
  })

  it("returns 500 {error:'internal_error'} when the helper fails", async () => {
    listMock.mockResolvedValueOnce({ ok: false, error: 'connection lost' })
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it('returns {conversations: [...]} threading allowedVenueIds into the helper', async () => {
    listMock.mockResolvedValueOnce({
      ok: true,
      conversations: [
        {
          guestId: 'g1',
          venueId: VENUE_A,
          venueSlug: 'mock-sextant',
          venueTimezone: 'America/Los_Angeles',
          agentName: 'Sana',
          name: 'Maya R.',
          phoneFallback: '+15551110001',
          recognitionState: 'returning',
          lastMessageAt: '2026-09-05T21:39:00.000Z',
          lastMessageDirection: 'outbound',
          lastMessagePreview: 'Done — got you down for two at 7:30.',
          conversationCount: 4,
          firstConversationAt: '2026-06-10T18:00:00.000Z',
        },
      ],
    })
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conversations).toHaveLength(1)
    expect(body.conversations[0].guestId).toBe('g1')
    expect(listMock).toHaveBeenCalledWith([VENUE_A])
  })

  it('returns {conversations: []} for an operator with no venue grants', async () => {
    verifyMock.mockResolvedValueOnce({ operatorId: 'op-2', allowedVenueIds: [] })
    listMock.mockResolvedValueOnce({ ok: true, conversations: [] })
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ conversations: [] })
    expect(listMock).toHaveBeenCalledWith([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/operator/conversations/route.test.ts`
Expected: FAIL — `./route` not found.

- [ ] **Step 3: Write the implementation**

```ts
// app/api/operator/conversations/route.ts
// GET /api/operator/conversations — lists every guest conversation across
// the operator's allowed venues (cross-repo sibling: analog-operator
// Conversations tab). Contract-conformance auth pattern matches
// app/api/operator/messages/[id]/thread/route.ts: inline
// verifyOperatorRequest, sanitized error bodies, not withOperatorAuth.

import { NextResponse } from 'next/server'

import { AuthError, verifyOperatorRequest } from '@/lib/auth'
import { listOperatorConversations } from '@/lib/operator'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  let operator
  try {
    operator = await verifyOperatorRequest(request)
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    throw err
  }

  const result = await listOperatorConversations(operator.allowedVenueIds)
  if (!result.ok) {
    console.warn(
      `[/api/operator/conversations] listOperatorConversations failed error=${result.error}`,
    )
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }

  return NextResponse.json({ conversations: result.conversations })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/operator/conversations/route.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/operator/conversations/route.ts app/api/operator/conversations/route.test.ts
git commit -m "add GET /api/operator/conversations"
```

---

## Task 7: Route — `GET /api/operator/guests/:guestId/thread`

**Files:**
- Create: `app/api/operator/guests/[guestId]/thread/route.ts`
- Test: `app/api/operator/guests/[guestId]/thread/route.test.ts`

**Interfaces:**
- Consumes: `verifyOperatorRequest`, `AuthError` from `@/lib/auth`; `loadGuestThreadByGuestId` from `@/lib/operator`.

- [ ] **Step 1: Write the failing test**

```ts
// app/api/operator/guests/[guestId]/thread/route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const loadMock = vi.fn()
vi.mock('@/lib/operator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operator')>('@/lib/operator')
  return {
    ...actual,
    loadGuestThreadByGuestId: (...args: unknown[]) => loadMock(...args),
  }
})

import { GET } from './route'

const VALID_GUEST_ID = '550e8400-e29b-41d4-a716-446655440000'
const VENUE_A = '00000000-0000-0000-0000-00000000000a'

function makeRequest(): Request {
  return new Request(
    `https://example.test/api/operator/guests/${VALID_GUEST_ID}/thread`,
    { method: 'GET', headers: { authorization: 'Bearer fake-jwt' } },
  )
}

function params(guestId = VALID_GUEST_ID): { params: Promise<{ guestId: string }> } {
  return { params: Promise.resolve({ guestId }) }
}

beforeEach(() => {
  verifyMock.mockReset()
  verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: [VENUE_A] })
  loadMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/operator/guests/[guestId]/thread', () => {
  it("returns 401 {error:'unauthorized'} when AuthError is thrown", async () => {
    const { AuthError } = await import('@/lib/auth/types')
    verifyMock.mockRejectedValueOnce(new AuthError(401, 'invalid or expired token'))
    const res = await GET(makeRequest(), params())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(loadMock).not.toHaveBeenCalled()
  })

  it("returns 404 not_found when guestId is not a uuid (no helper call)", async () => {
    const res = await GET(makeRequest(), params('not-a-uuid'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(loadMock).not.toHaveBeenCalled()
  })

  it('returns 404 not_found when helper reports guest_not_found', async () => {
    loadMock.mockResolvedValueOnce({ ok: false, errorCode: 'guest_not_found' })
    const res = await GET(makeRequest(), params())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('returns 404 not_found when helper reports out_of_allowlist', async () => {
    loadMock.mockResolvedValueOnce({ ok: false, errorCode: 'out_of_allowlist' })
    const res = await GET(makeRequest(), params())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it("returns 500 {error:'internal_error'} on db_error", async () => {
    loadMock.mockResolvedValueOnce({ ok: false, errorCode: 'db_error', error: 'timeout' })
    const res = await GET(makeRequest(), params())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it('returns {messages: [...]} threading allowedVenueIds into the helper', async () => {
    loadMock.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          direction: 'inbound',
          body: 'hey!',
          createdAt: '2026-09-05T18:00:00.000Z',
        },
      ],
    })
    const res = await GET(makeRequest(), params())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      messages: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          direction: 'inbound',
          body: 'hey!',
          createdAt: '2026-09-05T18:00:00.000Z',
        },
      ],
    })
    expect(loadMock).toHaveBeenCalledWith({
      guestId: VALID_GUEST_ID,
      allowedVenueIds: [VENUE_A],
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "app/api/operator/guests/[guestId]/thread/route.test.ts"`
Expected: FAIL — `./route` not found.

- [ ] **Step 3: Write the implementation**

```ts
// app/api/operator/guests/[guestId]/thread/route.ts
// GET /api/operator/guests/:guestId/thread — full thread for one guest,
// keyed directly by guestId (unlike the sibling
// /api/operator/messages/[id]/thread, most guests here have no pending
// draft to key off). Same Contract shape and same 200-most-recent,
// oldest→newest windowing.

import { NextResponse } from 'next/server'

import { AuthError, verifyOperatorRequest } from '@/lib/auth'
import { loadGuestThreadByGuestId } from '@/lib/operator'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  ctx: { params: Promise<{ guestId: string }> },
): Promise<Response> {
  let operator
  try {
    operator = await verifyOperatorRequest(request)
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    throw err
  }

  const { guestId } = await ctx.params
  if (!UUID_RE.test(guestId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const result = await loadGuestThreadByGuestId({
    guestId,
    allowedVenueIds: operator.allowedVenueIds,
  })

  if (!result.ok) {
    switch (result.errorCode) {
      case 'guest_not_found':
      case 'out_of_allowlist':
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
      case 'db_error':
      default:
        console.warn(
          `[/api/operator/guests/:guestId/thread] loadGuestThreadByGuestId failed errorCode=${result.errorCode} error=${result.error ?? '<no detail>'}`,
        )
        return NextResponse.json({ error: 'internal_error' }, { status: 500 })
    }
  }

  return NextResponse.json({ messages: result.messages })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "app/api/operator/guests/[guestId]/thread/route.test.ts"`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add "app/api/operator/guests/[guestId]/thread/route.ts" "app/api/operator/guests/[guestId]/thread/route.test.ts"
git commit -m "add GET /api/operator/guests/:guestId/thread"
```

---

## Task 8: Full test suite + manual curl verification

**Files:** none new — verification only.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS, including all existing tests (no regressions from Task 3's refactor) plus the new tests from Tasks 2, 4, 6, 7.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3 (⚠️ MANUAL — requires Task 1 Step 3 to be done first):** Start the dev server (`npm run dev`) and curl-verify both endpoints against the literal Contract, using a real operator bearer JWT:

```bash
curl -s -H "Authorization: Bearer <real-operator-jwt>" \
  http://localhost:3000/api/operator/conversations | jq .

curl -s -H "Authorization: Bearer <real-operator-jwt>" \
  http://localhost:3000/api/operator/guests/<a-real-guest-id>/thread | jq .
```

Confirm: the conversations response matches the shape in the spec's Contract section field-for-field (including that `agentName` falls back to the venue name when no `voiceName` is configured), and the guest-thread response matches the existing per-message thread endpoint's shape. **This step needs a person with real credentials and a running dev server — don't fabricate or skip it.** Per the repo's cross-repo rules, `analog-operator`'s live-mode client code must not be written until this step has actually passed.

- [ ] **Step 4: Report back**

Tell Jaipal these two endpoints are built, tested, and ready for curl verification (or, if Step 3 already ran, that it passed) — this unblocks Task 9+ in the `analog-operator` conversations-tab plan (the live-mode wiring tasks specifically; the fixture-mode tasks in that plan don't depend on this).
