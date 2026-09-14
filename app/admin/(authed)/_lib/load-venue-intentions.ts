import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'
import {
  INTENTION_DEFINITIONS,
  type IntentionKey,
} from '@/lib/agent/intentions/definitions'
import { deriveOpenIntentions } from '@/lib/agent/intentions/derive'
import { guestNameWithPhone } from './guest-name'

// TAC-381: which intentions are OPEN right now for the guests of one venue.
//
// Distinct from load-intention-prompts.ts, which reads guest_intention_prompts
// — and a row THERE means the intention was already raised and is closed
// forever for that guest, i.e. the inverse of the question this file answers.
// Both are rendered on the venue page, as two separate blocks.
//
// The open set is DERIVED, never stored. This file loads the facts and hands
// them to the real deriveOpenIntentions (pure, lib/agent/intentions/derive.ts)
// rather than restating the open/closed rule — so a change to what "open"
// means reaches this page without anyone remembering to mirror it.
//
// NOT on the agent's hot path. Runs on one admin page render.

/**
 * How far back the guest cohort reaches: the longest window any definition
 * declares. Computed from INTENTION_DEFINITIONS, never a literal — a new
 * intention with a longer window would otherwise be silently truncated out of
 * the cohort here while being genuinely open in the agent.
 */
export function maxIntentionWindowMs(): number {
  return Math.max(...INTENTION_DEFINITIONS.map((d) => d.expiresAfterMs))
}

/**
 * Cap on the guest cohort scanned. A safety belt, not a product decision: the
 * cohort is already bounded to guests created inside the longest intention
 * window, which at pilot volume is a handful of rows.
 */
export const INTENTION_COHORT_LIMIT = 500

export interface VenueOpenIntentionRow {
  guestId: string
  guestLabel: string
  guestCreatedAt: string
  /** Keys open for this guest. Never empty — a guest with none is dropped. */
  openKeys: IntentionKey[]
}

export interface VenueOpenIntentions {
  rows: VenueOpenIntentionRow[]
  /** True when the cohort hit its cap, so the list may be incomplete. */
  cohortTruncated: boolean
  /**
   * True when a supporting read failed and the derivation ran degraded.
   *
   * The page says so rather than presenting a short list as complete: this
   * function fails CLOSED (see below), so a degraded run UNDER-reports, and an
   * unlabelled empty list would read as "nothing open" — which is exactly the
   * invisibility this surface exists to remove.
   */
  degraded: boolean
}

interface GuestRow {
  id: string
  first_name: string | null
  last_name: string | null
  phone_number: string
  created_at: string
  created_via: string
}

export const loadVenueOpenIntentions = cache(_loadVenueOpenIntentions)

async function _loadVenueOpenIntentions(
  venueId: string,
  now: Date,
): Promise<VenueOpenIntentions> {
  const supabase = createAdminClient()
  const cutoffIso = new Date(now.getTime() - maxIntentionWindowMs()).toISOString()

  // Deliberately NOT filtered on created_via = 'qr_scan', even though that
  // would shrink the cohort. The origin gate is deriveOpenIntentions's own
  // first line; encoding it here too means a future intention that drops the
  // gate renders nothing on this page, with no error to point at. One place
  // decides eligibility. The cost is a few extra rows scanned on an admin
  // page render.
  const { data: guestData, error: guestError } = await supabase
    .from('guests')
    .select('id, first_name, last_name, phone_number, created_at, created_via')
    .eq('venue_id', venueId)
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: false })
    .limit(INTENTION_COHORT_LIMIT + 1)

  if (guestError) {
    console.warn(`[loadVenueOpenIntentions] guests query failed: ${guestError.message}`)
    return { rows: [], cohortTruncated: false, degraded: true }
  }

  const allGuests = (guestData ?? []) as GuestRow[]
  const cohortTruncated = allGuests.length > INTENTION_COHORT_LIMIT
  const guests = allGuests.slice(0, INTENTION_COHORT_LIMIT)
  if (guests.length === 0) {
    return { rows: [], cohortTruncated: false, degraded: false }
  }

  const guestIds = guests.map((g) => g.id)
  const [promptsResult, txResult] = await Promise.all([
    supabase
      .from('guest_intention_prompts')
      .select('guest_id, intention_key')
      .eq('venue_id', venueId)
      .in('guest_id', guestIds),
    supabase
      .from('transactions')
      .select('guest_id')
      .eq('venue_id', venueId)
      .in('guest_id', guestIds),
  ])

  let degraded = false

  // FAIL CLOSED, matching build-runtime-context.ts: a broken prompts read is
  // modelled as "everything already prompted", so every intention derives
  // closed. The agent fails this way so a hiccup can never re-ask a guest
  // something they were already asked; this page fails the same way so it can
  // never claim an intention is open when the record saying otherwise simply
  // did not load. It under-reports, and says that it did via `degraded`.
  const promptedByGuest = new Map<string, Set<IntentionKey>>()
  const ALL_KEYS = new Set<IntentionKey>(INTENTION_DEFINITIONS.map((d) => d.key))
  if (promptsResult.error) {
    console.warn(
      `[loadVenueOpenIntentions] guest_intention_prompts query failed: ${promptsResult.error.message}. Failing closed.`,
    )
    degraded = true
    for (const id of guestIds) promptedByGuest.set(id, ALL_KEYS)
  } else {
    for (const row of promptsResult.data ?? []) {
      const set = promptedByGuest.get(row.guest_id) ?? new Set<IntentionKey>()
      // Asserted, not validated — deliberately. intention_key is bare text
      // with no FK (migration 035), so an orphan key from a removed definition
      // can land here; it is harmless, because this set is only ever read via
      // .has(def.key) against live definitions. Contrast load-intention-
      // prompts.ts, which refuses to narrow the same column because it RENDERS
      // the value and an orphan is exactly what it needs to show.
      set.add(row.intention_key as IntentionKey)
      promptedByGuest.set(row.guest_id, set)
    }
  }

  // Fails closed too, by a different route: an unreadable transactions list is
  // treated as "we have heard what they ordered", which closes
  // learn_first_order rather than asserting it is still open.
  //
  // NOTE the shape of that guarantee, because it is not structural: it holds
  // because every isSatisfied reads this fact POSITIVELY. A future definition
  // written `isSatisfied: (f) => !f.hasQualifyingTransaction` would fail OPEN
  // here under unchanged code. Adding a new FIELD to
  // IntentionSatisfactionFacts is safe (it breaks derive.ts at tsc, which
  // breaks this call site); inverting an existing one is not.
  const hasTransaction = new Set<string>()
  if (txResult.error) {
    console.warn(
      `[loadVenueOpenIntentions] transactions query failed: ${txResult.error.message}. Failing closed.`,
    )
    degraded = true
    for (const id of guestIds) hasTransaction.add(id)
  } else {
    // transactions.guest_id is nullable — a POS row stays unmatched until a
    // card fingerprint or tap resolves it (migration 030). The .in() filter
    // above already excludes nulls, so this guard is the type being honest
    // rather than a live branch; it is a guard, not a cast.
    for (const row of txResult.data ?? []) {
      if (row.guest_id !== null) hasTransaction.add(row.guest_id)
    }
  }

  const rows: VenueOpenIntentionRow[] = []
  for (const g of guests) {
    // applyCurrentTurnSuppression is deliberately NOT applied: it is scoped to
    // one inbound message's body, and there is no current turn here.
    const open = deriveOpenIntentions({
      createdVia: g.created_via,
      guestCreatedAt: new Date(g.created_at),
      now,
      hasQualifyingTransaction: hasTransaction.has(g.id),
      promptedKeys: promptedByGuest.get(g.id) ?? new Set<IntentionKey>(),
    })
    if (open.length === 0) continue
    rows.push({
      guestId: g.id,
      guestLabel: guestNameWithPhone({
        firstName: g.first_name,
        lastName: g.last_name,
        phoneNumber: g.phone_number,
      }),
      guestCreatedAt: g.created_at,
      openKeys: open.map((o) => o.key),
    })
  }

  return { rows, cohortTruncated, degraded }
}
