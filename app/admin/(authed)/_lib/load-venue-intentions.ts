import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'
import {
  INTENTION_DEFINITIONS,
  isIntentionKey,
  type IntentionKey,
  rearmsOnNewerEvent,
} from '@/lib/agent/intentions/definitions'
import {
  buildSatisfactionFacts,
  deriveIntentionState,
  type IntentionStateEntry,
} from '@/lib/agent/intentions/derive'
import { GuestContextSchema, toParsedGuestContext } from '@/lib/schemas/guest-context'
import { guestNameWithPhone } from './guest-name'

// TAC-381, reworked by TAC-380: which intentions are OPEN right now for the
// guests of one venue.
//
// Distinct from load-intention-prompts.ts, which reads the PROMPTED rows of
// guest_intention_prompts: intentions already raised and closed (for good, unless
// a newer event re-arms an event-armed one). Both
// render on the venue page, as two separate blocks.
//
// Since migration 040, "open" starts from a recorded ELIGIBILITY row
// (prompted_at null), i.e. an intention a live inbound turn saw arm and pass its
// gate. This file reads those rows, loads the satisfaction facts, and hands both
// to deriveIntentionState (lib/agent/intentions/derive.ts), the same core the
// agent uses, rather than restating what "open" means.
//
// What this deliberately does NOT reproduce, because each needs a live turn:
//   - arming and gating for an intention with no row yet. Eligibility is only
//     observed on an inbound turn, so an intention whose gate opened since the
//     guest last texted isn't open here until they text again. Re-arming is the
//     same: a newer recommendation or order re-arms its intention on the guest's
//     next inbound, not here.
//   - the unanswered-prompt brake, the mid-conversation hold on event-armed
//     intentions, current-turn menu suppression, and opt_out /
//     pending-question suppression. Those decide what RENDERS on a turn, not
//     what is open.
// The page copy says so.
//
// NOT on the agent's hot path. Runs on one admin page render.

/**
 * How far back the eligibility scan reaches: the longest window any definition
 * declares. Computed from INTENTION_DEFINITIONS, never a literal — a new
 * intention with a longer window would otherwise be silently truncated out of
 * the scan here while being genuinely open in the agent.
 */
export function maxIntentionWindowMs(): number {
  return Math.max(...INTENTION_DEFINITIONS.map((d) => d.expiresAfterMs))
}

/**
 * Cap on eligibility rows scanned. A safety belt, not a product decision: the
 * scan is already bounded to rows that became eligible inside the longest
 * window, which at pilot volume is a handful.
 */
export const INTENTION_COHORT_LIMIT = 500

export interface VenueOpenIntentionRow {
  guestId: string
  guestLabel: string
  guestCreatedAt: string
  /** Keys open for this guest, in priority order. Never empty — a guest with none is dropped. */
  openKeys: IntentionKey[]
}

export interface VenueOpenIntentions {
  rows: VenueOpenIntentionRow[]
  /** True when the eligibility scan hit its cap, so the list may be incomplete. */
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

export const loadVenueOpenIntentions = cache(_loadVenueOpenIntentions)

async function _loadVenueOpenIntentions(
  venueId: string,
  now: Date,
): Promise<VenueOpenIntentions> {
  const supabase = createAdminClient()
  const cutoffIso = new Date(now.getTime() - maxIntentionWindowMs()).toISOString()

  // TAC-380 trap 1, admin edition. Two reads, because an open intention is two
  // shapes of row. Unprompted rows are eligibility rows. A re-armed event-armed
  // row keeps its last prompt as evidence for the brake, so it carries a
  // prompted_at, and it is open while that prompt predates its eligible_at.
  // PostgREST can't compare two columns, so that test runs in JS
  // (deriveIntentionState), on prompted rows of the re-armable keys only.
  // Reading every prompted row as open would list every intention already asked
  // as still being pursued.
  const rearmableKeys = INTENTION_DEFINITIONS.filter((d) => rearmsOnNewerEvent(d.armsOn)).map(
    (d) => d.key,
  )
  const [eligibilityResult, rearmedResult] = await Promise.all([
    supabase
      .from('guest_intention_prompts')
      .select('guest_id, intention_key, eligible_at')
      .eq('venue_id', venueId)
      .is('prompted_at', null)
      .gte('eligible_at', cutoffIso)
      .order('eligible_at', { ascending: false })
      .limit(INTENTION_COHORT_LIMIT + 1),
    supabase
      .from('guest_intention_prompts')
      .select('guest_id, intention_key, eligible_at, prompted_at')
      .eq('venue_id', venueId)
      .in('intention_key', rearmableKeys)
      .not('prompted_at', 'is', null)
      .gte('eligible_at', cutoffIso)
      .order('eligible_at', { ascending: false })
      .limit(INTENTION_COHORT_LIMIT + 1),
  ])

  if (eligibilityResult.error) {
    console.warn(
      `[loadVenueOpenIntentions] guest_intention_prompts query failed: ${eligibilityResult.error.message}`,
    )
    return { rows: [], cohortTruncated: false, degraded: true }
  }

  let degraded = false
  // Fails closed: a re-armed intention that can't be read is left out, and
  // `degraded` says the list is short.
  if (rearmedResult.error) {
    console.warn(
      `[loadVenueOpenIntentions] re-armed guest_intention_prompts query failed: ${rearmedResult.error.message}`,
    )
    degraded = true
  }

  const eligibilityRows = eligibilityResult.data ?? []
  const rearmedRows = rearmedResult.error ? [] : (rearmedResult.data ?? [])
  const cohortTruncated =
    eligibilityRows.length > INTENTION_COHORT_LIMIT || rearmedRows.length > INTENTION_COHORT_LIMIT

  // Grouped by guest, in first-seen order.
  const entriesByGuest = new Map<string, Map<IntentionKey, IntentionStateEntry>>()
  const addEntry = (guestId: string, key: string, entry: IntentionStateEntry) => {
    // A retired definition's key (the orphaned invite_contact_save row) is a
    // real value in this bare-text column. It just isn't an intention any more.
    if (!isIntentionKey(key)) return
    const entries = entriesByGuest.get(guestId) ?? new Map<IntentionKey, IntentionStateEntry>()
    entries.set(key, entry)
    entriesByGuest.set(guestId, entries)
  }
  for (const row of eligibilityRows.slice(0, INTENTION_COHORT_LIMIT)) {
    if (row.eligible_at === null) continue
    addEntry(row.guest_id, row.intention_key, {
      eligibleAt: new Date(row.eligible_at),
      promptedAt: null,
    })
  }
  for (const row of rearmedRows.slice(0, INTENTION_COHORT_LIMIT)) {
    if (row.eligible_at === null || row.prompted_at === null) continue
    addEntry(row.guest_id, row.intention_key, {
      eligibleAt: new Date(row.eligible_at),
      promptedAt: new Date(row.prompted_at),
    })
  }

  const guestIds = [...entriesByGuest.keys()]
  if (guestIds.length === 0) {
    return { rows: [], cohortTruncated, degraded }
  }

  const [guestsResult, txResult] = await Promise.all([
    supabase
      .from('guests')
      .select('id, first_name, last_name, phone_number, created_at, context')
      .eq('venue_id', venueId)
      .in('id', guestIds),
    supabase
      .from('transactions')
      .select('guest_id')
      .eq('venue_id', venueId)
      .in('guest_id', guestIds),
  ])

  // No labels and no name / home-base facts without this read, so fail closed
  // to an empty, labelled-degraded list rather than guess at either.
  if (guestsResult.error) {
    console.warn(`[loadVenueOpenIntentions] guests query failed: ${guestsResult.error.message}`)
    return { rows: [], cohortTruncated, degraded: true }
  }

  // FAIL CLOSED, matching the agent: an unreadable transactions list is treated
  // as "we have heard what they ordered", which closes understand_order rather
  // than asserting it is still open. It under-reports, and says so via
  // `degraded`.
  //
  // NOTE the shape of that guarantee, because it is not structural: it holds
  // because every isSatisfied reads this fact POSITIVELY. A future definition
  // written `isSatisfied: (f) => !f.hasQualifyingTransaction` would fail OPEN
  // here under unchanged code.
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
    // above already excludes nulls, so this is the type being honest rather
    // than a live branch.
    for (const row of txResult.data ?? []) {
      if (row.guest_id !== null) hasTransaction.add(row.guest_id)
    }
  }

  const guestsById = new Map((guestsResult.data ?? []).map((g) => [g.id, g] as const))
  const rows: VenueOpenIntentionRow[] = []
  for (const guestId of guestIds) {
    const guest = guestsById.get(guestId)
    // The guests read is scoped to this venue, so a row it didn't return is not
    // this venue's guest to show.
    if (!guest) continue
    const parsedContext = GuestContextSchema.safeParse(guest.context)
    const context = toParsedGuestContext(parsedContext.success ? parsedContext.data : {}, now)
    const open = deriveIntentionState({
      entries: entriesByGuest.get(guestId) ?? new Map<IntentionKey, IntentionStateEntry>(),
      facts: buildSatisfactionFacts({
        hasQualifyingTransaction: hasTransaction.has(guestId),
        firstName: guest.first_name,
        homeBase: context.guest_details?.home_base,
      }),
      now,
    })
    if (open.length === 0) continue
    rows.push({
      guestId,
      guestLabel: guestNameWithPhone({
        firstName: guest.first_name,
        lastName: guest.last_name,
        phoneNumber: guest.phone_number,
      }),
      guestCreatedAt: guest.created_at,
      openKeys: open.map((o) => o.key),
    })
  }

  return { rows, cohortTruncated, degraded }
}
