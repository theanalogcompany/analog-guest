// TAC-575 PR 5: who moves when a scan day counts as a visit.
//
// READ-ONLY. No model call, no send, no write: it calls the recognition
// READERS (loadSignals, computeRelationshipStrength) and never
// computeGuestState, which is the one that persists a band.
//
// For every guest at one venue it reads the 90-day visit count and the
// relationship score twice, once counting visits from orders alone (how it was)
// and once with scan days merged in (how it is), and prints the guests for whom
// either the count or the band the score falls in differs.
//
// THE TWO ARMS DIFFER IN ONE THING, the `includeScanVisits` argument, and are
// read back to back for the same guest, so a difference is the scans and not a
// message that arrived between two runs.
//
// "BAND" HERE IS WHAT THE SCORE EVALUATES TO, not what `guest_states` holds. A
// guest's stored band moves only when a turn recomputes it, so a guest listed
// as changing band has not changed yet: they will on their next turn.
//
// WHAT WOULD MAKE THIS WRONG: it reconciles each guest's "after" count against
// an independent count of their distinct order days and scan days, computed
// here from the raw rows, and fails the run on any disagreement.
//
//   npx tsx --env-file=.env.local scripts/measurement/scan-visits-before-after.ts
//   MEASURE_VENUE=<slug> to read another venue.

import { formatInTimeZone } from 'date-fns-tz'
import { createAdminClient } from '@/lib/db/admin'
import { computeRelationshipStrength } from '@/lib/recognition'
import { loadThresholds } from '@/lib/recognition/compute-state'
import { evaluateState } from '@/lib/recognition/evaluate-state'
import {
  loadSignals,
  VISIT_LOOKBACK_DAYS,
} from '@/lib/recognition/load-signals'
import { createRunLog } from './run-log'

const MS_PER_DAY = 24 * 60 * 60 * 1000

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const db = createAdminClient()

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, name, timezone')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  const thresholds = await loadThresholds(venue.id)
  if (!thresholds.ok) throw new Error(`thresholds: ${thresholds.error}`)

  const { data: guests, error: guestsError } = await db
    .from('guests')
    .select('id, created_via, created_at')
    .eq('venue_id', venue.id)
    .order('created_at', { ascending: true })
  if (guestsError || !guests) throw new Error('guests unreadable')
  // One unpaginated read. At the API's row cap the list would be cut short
  // while still printing a guest count, so refuse rather than report a part.
  if (guests.length >= 1000) {
    throw new Error(
      `${guests.length} guests: at the row cap, so this list may be truncated. Paginate before trusting it.`,
    )
  }

  const log = createRunLog({
    name: 'tac575-scan-visits-before-after',
    meta: {
      arm: 'orders-only vs orders+scans',
      venue: venueSlug,
      venueName: venue.name,
      guests: guests.length,
      lookbackDays: VISIT_LOOKBACK_DAYS,
      readOnly: true,
    },
  })

  const sinceIso = new Date(
    Date.now() - VISIT_LOOKBACK_DAYS * MS_PER_DAY,
  ).toISOString()
  const dayOf = (iso: string): string =>
    formatInTimeZone(iso, venue.timezone, 'yyyy-MM-dd')

  let countChanged = 0
  let bandChanged = 0
  let mismatches = 0
  const rows: string[] = []

  for (const guest of guests) {
    const args = { guestId: guest.id, venueId: venue.id }
    const [before, after, scoreBefore, scoreAfter] = await Promise.all([
      loadSignals({ ...args, includeScanVisits: false }),
      loadSignals(args),
      computeRelationshipStrength({ ...args, includeScanVisits: false }),
      computeRelationshipStrength(args),
    ])
    if (!before.ok || !after.ok || !scoreBefore.ok || !scoreAfter.ok) {
      throw new Error(`guest ${guest.id}: recognition read failed; run void`)
    }

    // The independent count: distinct local days across this guest's live
    // orders and their scans, from the raw rows.
    const [{ data: orders }, { data: scans }] = await Promise.all([
      db
        .from('transactions')
        .select('occurred_at')
        .eq('venue_id', venue.id)
        .eq('guest_id', guest.id)
        .is('retracted_at', null)
        .gte('occurred_at', sinceIso),
      db
        .from('instagram_scan_arrivals')
        .select('scanned_at')
        .eq('venue_id', venue.id)
        .eq('guest_id', guest.id)
        .gte('scanned_at', sinceIso),
    ])
    if (!orders || !scans) {
      throw new Error(`guest ${guest.id}: raw rows unreadable; run void`)
    }
    const days = new Set<string>()
    for (const o of orders) days.add(dayOf(o.occurred_at))
    for (const s of scans) days.add(dayOf(s.scanned_at))
    if (guest.created_via === 'qr_scan' && guest.created_at >= sinceIso) {
      days.add(dayOf(guest.created_at))
    }
    // A guest whose only day is today counts zero (visitDaysThatCount), so
    // the independent count applies the same rule from its own day set.
    const today = dayOf(new Date().toISOString())
    const expectedVisits = [...days].some((d) => d < today) ? days.size : 0
    const reconciles = expectedVisits === after.data.visitsLast90Days
    if (!reconciles) mismatches += 1

    const bandBefore = evaluateState(scoreBefore.data.score, thresholds.data)
    const bandAfter = evaluateState(scoreAfter.data.score, thresholds.data)
    const unit = {
      guestId: guest.id,
      visitsBefore: before.data.visitsLast90Days,
      visitsAfter: after.data.visitsLast90Days,
      independentDayCount: expectedVisits,
      reconciles,
      scoreBefore: scoreBefore.data.score,
      scoreAfter: scoreAfter.data.score,
      bandBefore,
      bandAfter,
    }
    log.appendUnit(unit)

    const visitsMoved = unit.visitsBefore !== unit.visitsAfter
    if (visitsMoved) countChanged += 1
    if (bandBefore !== bandAfter) bandChanged += 1
    if (visitsMoved || bandBefore !== bandAfter || !reconciles) {
      rows.push(
        `| ${guest.id.slice(0, 8)} | ${unit.visitsBefore} | ${unit.visitsAfter} | ${unit.scoreBefore} | ${unit.scoreAfter} | ${bandBefore} | ${bandAfter} |${reconciles ? '' : ' DOES NOT RECONCILE'}`,
      )
    }
  }

  console.log(`[tac575] venue=${venueSlug} guests=${guests.length}`)
  console.log(`[tac575] visit count changed: ${countChanged}`)
  console.log(`[tac575] band changed: ${bandChanged}`)
  console.log(`[tac575] reconciliation mismatches: ${mismatches}`)
  console.log(
    '| guest | visits before | visits after | score before | score after | band before | band after |',
  )
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of rows) console.log(row)
  console.log(`[tac575] run log: ${log.path}`)
  if (mismatches > 0) {
    console.error('[tac575] FAIL: the after-count disagrees with the raw rows')
    process.exit(1)
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
