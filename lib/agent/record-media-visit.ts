// TAC-584: a visit seen in a guest's photo, video or story.
//
// A story tagging the venue with its drinks in frame is the strongest sign of
// a visit there is, and until this file nothing recorded it. When the
// describe step says an attachment clearly shows the venue
// (evidencesVisit), this writes one `transactions` row for that guest, with
// the drinks the picture unmistakably shows as its line items, or none.
//
// WHY THIS IS NOT extractReportedOrder. That path (TAC-323, TAC-325) works for
// an Instagram guest as far as it goes: nothing in it needs a phone number.
// But it reads the guest's WORDS. Its prefilter and its model call both take
// the message body, a media-only turn returns before it is reached, and it
// writes nothing when no item resolves. A photo has no words and may show the
// venue with no nameable drink. So this is a sibling that shares that file's
// pieces (the line-item shape, the menu price estimate, the last-visit cache
// update) and takes its input from the describe step instead.
//
// THE ROW.
//   source       'guest_media' (migration 081). The guest reported nothing; a
//                model looked at a picture. Recognition counts it like any
//                other row; the value is what lets a wrong one be found.
//   external_id  the message's id. With the table's own unique
//                (venue_id, source, external_id) that makes this idempotent
//                per message: a redelivery or a retried turn writes nothing.
//   occurred_at  when the message arrived, precision 'approximate'. A picture
//                proves a day at best, and not always that: a photo of last
//                week's visit sent today is stamped today (a known limit,
//                stated on the ticket). 'approximate' is also what keeps the
//                post-visit follow-ups from firing off a guess
//                (detectPostVisitReason), ruled on the plan.
//   raw_data     the line items in the shape the self-report path writes, so
//                every reader of visit history parses them unchanged, plus
//                `venue_local_date`, which the one-per-day index reads.
//
// ONE PER GUEST PER VENUE-LOCAL DAY, and never a second row beside another
// source's. Two readers count raw rows, not days (the v2 engine's visit count
// and the intentions' repeat-visit fact), so a photo of a drink the guest
// also told us about, or paid for by card, must not make that day count
// twice:
//   - a same-day photo row or ongoing self-report row gains the new item
//     names (name-only, as the self-report merge is) and nothing else;
//   - a same-day row of any other source (a POS receipt, the enrollment
//     report) is better evidence than a picture and is left alone;
//   - otherwise a row is inserted, and migration 081's partial unique index
//     is the backstop if two photos race.
//
// IT SHIPS IN SHADOW MODE (owner ruling 2026-10-11). Whether a picture is
// evidence of a visit is a model's call, and nobody has yet read a week of
// those calls. So unless the venue's `record_media_visits` is true
// (migration 081, false everywhere at merge), the decision is computed,
// stored on the attachment (`description_meta.visit`) and logged, and nothing
// is written to `transactions` or to `guests.last_visit_at`. Everything below
// about the row describes what is written once a venue is switched on.
//
// A VISIT WITH NO ITEMS IS A VISIT, AND IS NOT AN ORDER. It counts toward
// recognition. It must not close "what did you get?": isItemlessMediaVisit is
// what build-runtime-context uses to keep that intention open.
//
// CORRECTING A WRONG ONE is the Command Center's delete, which accepts this
// source. The guest cannot retract it by text: the retraction path
// (retract-reported-visit.ts) offers only what a guest reported, and migration
// 072's CHECK is not widened for a writer that does not exist.
//
// FAILS TO A VALUE AND NEVER THROWS. It runs in waitUntil beside the turn. A
// failure costs the visit and nothing else, and is logged.

import type { Json } from '@/db/types'
import { createAdminClient } from '@/lib/db/admin'
import { toJson } from '@/lib/db/json'
import { logger } from '@/lib/observability/logger'
import type { MenuItem } from '@/lib/schemas'
import {
  type AttachmentDescriptionMeta,
  type RecordedVisitDecision,
  type VisitDecision,
  evidencesVisit,
  nameableItems,
} from '@/lib/schemas/attachment-description'

import {
  type ResolvedReportedItem,
  advanceLastVisit,
  buildStoredLineItems,
  computeAmountCents,
  dropAlreadyRecordedItems,
  parseStoredLineItems,
  resolveReportedItems,
  sameVenueLocalDay,
  venueLocalDayKey,
} from './extract-reported-order'

export const GUEST_MEDIA_SOURCE = 'guest_media'

/** The sources whose same-day row a photo's items may be added to. */
const MERGEABLE_SOURCES: readonly string[] = [
  GUEST_MEDIA_SOURCE,
  'guest_reported_ongoing',
]

// A day either side of the message, so the venue-local day is covered
// whatever the venue's offset from UTC.
const SAME_DAY_LOOKAROUND_MS = 36 * 60 * 60 * 1000

/** One described attachment, as far as a visit is concerned. */
export type MediaVisitEvidence = {
  attachmentId: string
  meta: AttachmentDescriptionMeta | null
}

/** A transaction row already on this guest's record near the message. */
export type ExistingVisitRow = {
  id: string
  source: string
  external_id: string | null
  occurred_at: string
  raw_data: unknown
}

export type MediaVisitPlan =
  /** Nothing in the picture ties it to the venue. Nothing is written. */
  | { action: 'none' }
  /** This message's visit is already recorded. */
  | { action: 'exists'; reason: 'same_message' | 'same_day_other_source' }
  /** A same-day row already carries every drink this picture shows. */
  | { action: 'exists'; reason: 'no_new_items'; transactionId: string }
  | {
      action: 'merge'
      transactionId: string
      rawData: Record<string, Json>
      amountCents: number | null
      itemCount: number
      addedItemCount: number
    }
  | {
      action: 'insert'
      amountCents: number | null
      itemCount: number
      rawData: Record<string, Json>
    }

export interface PlanMediaVisitInput {
  messageId: string
  occurredAtIso: string
  timezone: string
  evidence: readonly MediaVisitEvidence[]
  menuItems: readonly MenuItem[]
  /** This guest's un-retracted rows near the message, any order. */
  existing: readonly ExistingVisitRow[]
}

/**
 * The drinks a visit carries: every unmistakable item on any attachment that
 * is itself evidence of the visit, resolved against the menu exactly as a
 * self-reported order is. One of each: a picture does not say how many.
 */
export function mediaVisitItems(
  evidence: readonly MediaVisitEvidence[],
  menuItems: readonly MenuItem[],
): ResolvedReportedItem[] {
  const menuNames = menuItems.map((item) => item.name)
  const names: string[] = []
  for (const { meta } of evidence) {
    if (meta === null || meta.outcome !== 'described') continue
    if (!evidencesVisit(meta)) continue
    for (const name of nameableItems(meta, menuNames)) {
      if (!names.includes(name)) names.push(name)
    }
  }
  return resolveReportedItems(
    names.map((name) => ({ name, quantity: 1 })),
    menuItems,
  )
}

function asRecord(value: unknown): Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {}
}

/**
 * What to write for this message, if anything. Pure, and what the harness
 * runs. The rules are in this file's header.
 */
export function planMediaVisit(input: PlanMediaVisitInput): MediaVisitPlan {
  const evidencing = input.evidence.filter(
    ({ meta }) =>
      meta !== null && meta.outcome === 'described' && evidencesVisit(meta),
  )
  if (evidencing.length === 0) return { action: 'none' }

  if (
    input.existing.some(
      (row) =>
        row.source === GUEST_MEDIA_SOURCE &&
        row.external_id === input.messageId,
    )
  ) {
    return { action: 'exists', reason: 'same_message' }
  }

  const items = mediaVisitItems(evidencing, input.menuItems)
  const sameDay = input.existing.filter((row) =>
    sameVenueLocalDay(row.occurred_at, input.occurredAtIso, input.timezone),
  )
  // A photo row first, then an ongoing self-report: the photo row is this
  // file's own, and at most one exists for the day.
  const mergeTarget =
    sameDay.find((row) => row.source === GUEST_MEDIA_SOURCE) ??
    sameDay.find((row) => MERGEABLE_SOURCES.includes(row.source))
  if (mergeTarget !== undefined) {
    const existingRaw = asRecord(mergeTarget.raw_data)
    const existingParsed = parseStoredLineItems(mergeTarget.raw_data)
    const toAdd = dropAlreadyRecordedItems(items, existingParsed)
    if (toAdd.length === 0) {
      return {
        action: 'exists',
        reason: 'no_new_items',
        transactionId: mergeTarget.id,
      }
    }
    const existingLineItems: Json[] = Array.isArray(existingRaw.line_items)
      ? existingRaw.line_items
      : []
    const merged = [...existingLineItems, ...buildStoredLineItems(toAdd)]
    return {
      action: 'merge',
      transactionId: mergeTarget.id,
      rawData: { ...existingRaw, line_items: merged },
      amountCents: computeAmountCents([...existingParsed, ...toAdd]),
      itemCount: merged.length,
      addedItemCount: toAdd.length,
    }
  }
  if (sameDay.length > 0) {
    return { action: 'exists', reason: 'same_day_other_source' }
  }

  return {
    action: 'insert',
    // No items is "no amount known", never a $0 visit.
    amountCents: items.length > 0 ? computeAmountCents(items) : null,
    itemCount: items.length,
    rawData: {
      pos_provider: GUEST_MEDIA_SOURCE,
      amount_source: 'menu_estimate',
      venue_local_date: venueLocalDayKey(
        input.timezone,
        new Date(input.occurredAtIso),
      ),
      attachment_ids: toJson(evidencing.map((e) => e.attachmentId)),
      line_items: buildStoredLineItems(items),
    },
  }
}

/**
 * A photo visit that names no drink. A visit, and not an order: it must not
 * satisfy "have we heard what they got".
 */
export function isItemlessMediaVisit(row: {
  source: string
  raw_data: unknown
}): boolean {
  return (
    row.source === GUEST_MEDIA_SOURCE &&
    parseStoredLineItems(row.raw_data).length === 0
  )
}

/** Whether a decision is acted on, or only recorded. */
export type MediaVisitMode = 'shadow' | 'live'

export type RecordMediaVisitOutcome =
  | { kind: 'no_evidence' }
  /** Decided and recorded on the attachment, and NOT written: the venue's setting is off. */
  | { kind: 'shadow'; decision: VisitDecision; items: string[] }
  | { kind: 'already_recorded'; reason: string }
  | { kind: 'recorded'; transactionId: string; itemCount: number }
  | { kind: 'merged'; transactionId: string; addedItemCount: number }
  | { kind: 'failed'; error: string }

export interface RecordMediaVisitInput {
  venue: { id: string; timezone: string; menuItems: readonly MenuItem[] }
  guestId: string
  /** The message the attachments are on. */
  messageId: string
  /** When that message arrived. */
  receivedAt: Date
  evidence: readonly MediaVisitEvidence[]
}

type GuestVisitCache = {
  last_visit_at: string | null
  last_visit_precision: string | null
}

type InsertResult =
  { ok: true; id: string } | { ok: false; code?: string; error: string }

/** Everything this file reaches outside itself, so the harness can stand in for it. */
export type MediaVisitDeps = {
  /** The venue's `record_media_visits`. A failed read is `shadow`. */
  loadMode: (venueId: string) => Promise<MediaVisitMode>
  loadExisting: (input: RecordMediaVisitInput) => Promise<ExistingVisitRow[]>
  loadGuestCache: (guestId: string) => Promise<GuestVisitCache | null>
  /** Put the decision on each evidencing attachment's `description_meta`. */
  saveDecision: (
    evidence: readonly MediaVisitEvidence[],
    decision: RecordedVisitDecision,
  ) => Promise<void>
  insert: (
    input: RecordMediaVisitInput,
    plan: Extract<MediaVisitPlan, { action: 'insert' }>,
    occurredAtIso: string,
  ) => Promise<InsertResult>
  merge: (plan: Extract<MediaVisitPlan, { action: 'merge' }>) => Promise<void>
  advanceLastVisit: (
    input: RecordMediaVisitInput,
    cache: GuestVisitCache | null,
    occurredAtIso: string,
  ) => Promise<void>
  log: (fields: Record<string, unknown>) => void
}

function defaultDeps(): MediaVisitDeps {
  // Made on first use, not here: a caller that replaces every dependency (the
  // harness) must not need a database to construct the ones it never calls.
  let client: ReturnType<typeof createAdminClient> | null = null
  const db = () => (client ??= createAdminClient())
  return {
    async loadMode(venueId) {
      // Its own query, on purpose: see migration 081's header. A column that
      // is not there yet, or any other failure, reads as off.
      const { data, error } = await db()
        .from('venues')
        .select('record_media_visits')
        .eq('id', venueId)
        .maybeSingle()
      return !error && data?.record_media_visits === true ? 'live' : 'shadow'
    },
    async loadExisting(input) {
      const at = input.receivedAt.getTime()
      const { data, error } = await db()
        .from('transactions')
        .select('id, source, external_id, occurred_at, raw_data')
        .eq('venue_id', input.venue.id)
        .eq('guest_id', input.guestId)
        .is('retracted_at', null)
        .gte('occurred_at', new Date(at - SAME_DAY_LOOKAROUND_MS).toISOString())
        .lte('occurred_at', new Date(at + SAME_DAY_LOOKAROUND_MS).toISOString())
        .order('occurred_at', { ascending: false })
        .limit(50)
      if (error) throw new Error(error.message)
      return data ?? []
    },
    async loadGuestCache(guestId) {
      const { data, error } = await db()
        .from('guests')
        .select('last_visit_at, last_visit_precision')
        .eq('id', guestId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return data
    },
    async saveDecision(evidence, decision) {
      for (const { attachmentId, meta } of evidence) {
        if (meta === null || meta.outcome !== 'described') continue
        const { error } = await db()
          .from('message_attachments')
          .update({ description_meta: toJson({ ...meta, visit: decision }) })
          .eq('id', attachmentId)
        if (error) throw new Error(error.message)
      }
    },
    async insert(input, plan, occurredAtIso) {
      const { data, error } = await db()
        .from('transactions')
        .insert({
          venue_id: input.venue.id,
          guest_id: input.guestId,
          source: GUEST_MEDIA_SOURCE,
          amount_cents: plan.amountCents,
          item_count: plan.itemCount,
          occurred_at: occurredAtIso,
          occurred_at_precision: 'approximate',
          external_id: input.messageId,
          matched_at: null,
          match_method: null,
          raw_data: plan.rawData,
        })
        .select('id')
        .single()
      if (error || !data) {
        return {
          ok: false,
          code: error?.code,
          error: error?.message ?? 'insert returned no row',
        }
      }
      return { ok: true, id: data.id }
    },
    async merge(plan) {
      const { error } = await db()
        .from('transactions')
        .update({
          raw_data: plan.rawData,
          item_count: plan.itemCount,
          amount_cents: plan.amountCents,
        })
        .eq('id', plan.transactionId)
      if (error) throw new Error(error.message)
    },
    advanceLastVisit: (input, cache, occurredAtIso) =>
      advanceLastVisit(
        db(),
        input.guestId,
        cache?.last_visit_at ?? null,
        cache?.last_visit_precision ?? null,
        occurredAtIso,
        'approximate',
        input.venue.timezone,
      ),
    log: (fields) => logger.info('[agent] media visit decision', fields),
  }
}

function hasEvidence(evidence: readonly MediaVisitEvidence[]): boolean {
  return evidence.some(
    ({ meta }) =>
      meta !== null && meta.outcome === 'described' && evidencesVisit(meta),
  )
}

/**
 * Decide the visit this message's media is evidence of, record the decision,
 * and write the visit only where the venue's setting says to. Never throws.
 *
 * SHADOW BY DEFAULT (owner ruling 2026-10-11). Unless the venue's
 * `record_media_visits` is true, this computes exactly what it would write,
 * puts that on each evidencing attachment's `description_meta.visit`, emits
 * one structured log line, and stops. No `transactions` row, no change to
 * `guests.last_visit_at`. The decision is the same code path either way
 * (planMediaVisit), so what is reviewed in shadow is what will run live.
 */
export async function recordMediaVisit(
  input: RecordMediaVisitInput,
  overrides: Partial<MediaVisitDeps> = {},
): Promise<RecordMediaVisitOutcome> {
  try {
    // Decided before any read: most media is not a visit.
    if (!hasEvidence(input.evidence)) return { kind: 'no_evidence' }

    const deps: MediaVisitDeps = { ...defaultDeps(), ...overrides }
    const occurredAtIso = input.receivedAt.toISOString()
    const [mode, existing, cache] = await Promise.all([
      deps.loadMode(input.venue.id),
      deps.loadExisting(input),
      deps.loadGuestCache(input.guestId),
    ])

    const plan = planMediaVisit({
      messageId: input.messageId,
      occurredAtIso,
      timezone: input.venue.timezone,
      evidence: input.evidence,
      menuItems: input.venue.menuItems,
      existing,
    })
    if (plan.action === 'none') return { kind: 'no_evidence' }

    const items = mediaVisitItems(input.evidence, input.venue.menuItems).map(
      (item) => item.name,
    )
    const decision: RecordedVisitDecision = {
      mode,
      decision: plan.action,
      ...(plan.action === 'exists' ? { reason: plan.reason } : {}),
      items,
      decidedAt: new Date().toISOString(),
    }
    deps.log({
      event: 'media_visit_decision',
      mode,
      decision: plan.action,
      reason: plan.action === 'exists' ? plan.reason : null,
      venueId: input.venue.id,
      guestId: input.guestId,
      messageId: input.messageId,
      attachmentIds: input.evidence.map((e) => e.attachmentId),
      items,
      occurredAt: occurredAtIso,
    })
    // The record of the decision is the point of shadow mode, so a failure
    // to write it is reported; it does not stop a live visit being written.
    await deps.saveDecision(input.evidence, decision).catch((e: unknown) => {
      logger.warn('[agent] media visit decision not saved on the attachment', {
        messageId: input.messageId,
        error: e instanceof Error ? e.message : String(e),
      })
    })

    if (mode === 'shadow') {
      return { kind: 'shadow', decision: plan.action, items }
    }
    if (plan.action === 'exists') {
      return { kind: 'already_recorded', reason: plan.reason }
    }
    if (plan.action === 'merge') {
      await deps.merge(plan)
      return {
        kind: 'merged',
        transactionId: plan.transactionId,
        addedItemCount: plan.addedItemCount,
      }
    }

    const inserted = await deps.insert(input, plan, occurredAtIso)
    if (!inserted.ok) {
      // 23505: this message's row, or another photo's row for the same day,
      // landed first. Either way the day's visit is on record; the items a
      // racing photo would have added are the cost, as on the self-report
      // path (migration 047's header accepts the same race).
      if (inserted.code === '23505') {
        return { kind: 'already_recorded', reason: 'lost_race' }
      }
      return { kind: 'failed', error: inserted.error }
    }
    await deps.advanceLastVisit(input, cache, occurredAtIso)
    return {
      kind: 'recorded',
      transactionId: inserted.id,
      itemCount: plan.itemCount,
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    logger.warn('[agent] media visit not recorded', {
      guestId: input.guestId,
      messageId: input.messageId,
      error,
    })
    return { kind: 'failed', error }
  }
}
