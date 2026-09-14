import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'
import { guestNameWithPhone } from './guest-name'

// TAC-379: recorded intention prompts for the read-only /admin/intentions
// viewer. Mirrors load-venues.ts's shape — one query, allowlist-scoped the
// same way (an empty allowedVenueIds means analog-admin scope and sees
// everything), degrade-gracefully to [] with a console.warn rather than
// throwing, so a DB hiccup costs the recorded-prompts half of the page and
// leaves the definitions half (a static import) intact.
//
// The guest + venue joins ride PostgREST embedded relations in a single
// round trip rather than an N+1 lookup per row, same as
// lib/operator/heads-up-queue.ts. Both FKs are NOT NULL (migration 035), so
// `!inner` cannot silently drop a row.
//
// This is NOT on the agent's hot path. It runs on one admin page render.

export interface IntentionPromptRow {
  id: string
  /**
   * Raw `guest_intention_prompts.intention_key`. Deliberately NOT narrowed to
   * IntentionKey and deliberately NOT filtered against INTENTION_DEFINITIONS:
   * the column is bare `text` with no FK (migration 035), so a renamed or
   * removed definition leaves orphan history behind. Dropping those rows here
   * would hide the exact thing this page exists to show. The viewer marks
   * them unrecognized instead.
   */
  intentionKey: string
  promptedAt: string
  /**
   * Null when no message row is linked. Migration 035 is ON DELETE SET NULL,
   * so a deleted message is the likely cause, but the column alone cannot
   * prove that — the viewer says only what is true.
   */
  messageId: string | null
  guestLabel: string
  venueName: string
}

/**
 * Bounded read. Stated on the page rather than applied silently, per the
 * TAC-316 lesson: a cap nobody can see reads as "this is all there is."
 */
export const RECORDED_PROMPTS_LIMIT = 200

export interface IntentionPromptsPage {
  rows: IntentionPromptRow[]
  /**
   * True only when a row beyond the cap actually exists.
   *
   * We fetch RECORDED_PROMPTS_LIMIT + 1 and drop the extra rather than
   * comparing `rows.length` to the cap, because that comparison cannot tell
   * exactly-200 from more-than-200 — and the page states this as fact to the
   * reader. Claiming "older prompts exist" on a total of exactly 200 would be
   * the same quiet misreport this surface exists to avoid.
   */
  hasMore: boolean
}

interface JoinedGuestShape {
  first_name: string | null
  last_name: string | null
  phone_number: string
}

interface JoinedVenueShape {
  name: string
}

/** PostgREST returns a to-one embed as an object, but has returned arrays; normalize both. */
function firstOrNull<T>(raw: T | T[] | null): T | null {
  return Array.isArray(raw) ? (raw[0] ?? null) : raw
}

export const loadIntentionPrompts = cache(_loadIntentionPrompts)

async function _loadIntentionPrompts(allowedVenueIds: string[]): Promise<IntentionPromptsPage> {
  const supabase = createAdminClient()
  let query = supabase
    .from('guest_intention_prompts')
    .select(
      'id, intention_key, prompted_at, message_id, guest:guests!inner(first_name, last_name, phone_number), venue:venues!inner(name)',
    )
    .order('prompted_at', { ascending: false })
    .limit(RECORDED_PROMPTS_LIMIT + 1)
  if (allowedVenueIds.length > 0) {
    query = query.in('venue_id', allowedVenueIds)
  }

  const { data, error } = await query
  if (error) {
    console.warn('[loadIntentionPrompts] guest_intention_prompts query failed', error.message)
    return { rows: [], hasMore: false }
  }

  const all = data ?? []
  const hasMore = all.length > RECORDED_PROMPTS_LIMIT
  const rows = all.slice(0, RECORDED_PROMPTS_LIMIT).map((row) => {
    const guest = firstOrNull(row.guest as JoinedGuestShape | JoinedGuestShape[] | null)
    const venue = firstOrNull(row.venue as JoinedVenueShape | JoinedVenueShape[] | null)
    return {
      id: row.id,
      intentionKey: row.intention_key,
      promptedAt: row.prompted_at,
      messageId: row.message_id,
      guestLabel: guest
        ? guestNameWithPhone({
            firstName: guest.first_name,
            lastName: guest.last_name,
            phoneNumber: guest.phone_number,
          })
        : '(unknown guest)',
      venueName: venue?.name ?? '(unknown venue)',
    }
  })

  return { rows, hasMore }
}
