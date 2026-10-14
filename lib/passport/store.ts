// TAC-586: the reads and writes behind a passport stamp.
//
// THE INSERT IS THE CLAIM (migration 085). Two runners that both see one bound
// payment both try to insert; `passport_stamps_transaction_key` lets exactly
// one through and the other reads `already_stamped` before rendering or
// sending anything. A collision on `seq` or on (page, slot) is a different
// outcome, `conflict`: another purchase by the same guest claimed that
// position first, and the caller re-reads and places again.
//
// A STAMP'S TIME IS READ, NEVER STORED (TAC-587). Every stamp prints its
// purchase's local time, and a spread re-draws the earlier stamps on its two
// pages, so each prior stamp is loaded with its transaction's `occurred_at`,
// embedded through the `transaction_id` foreign key.
//
// Every query is scoped on venue AND guest, never on an id alone, per
// .claude/rules/errors-as-values.md. Never throws: supabase-js throws on some
// transport failures, so each function catches.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import {
  parseLineItemNames,
  parsePassportSettings,
  type PassportSettings,
} from '@/lib/schemas'

import { isStampKind, type StampKind } from './decide'

type AdminSupabaseClient = SupabaseClient<Database>
type StampInsert = Database['public']['Tables']['passport_stamps']['Insert']

export type StoreResult<T> =
  { ok: true; data: T } | { ok: false; error: string }

const PG_UNIQUE_VIOLATION = '23505'
const TRANSACTION_KEY = 'passport_stamps_transaction_key'

export type StoredStamp = {
  id: string
  seq: number
  kind: StampKind
  label: string | null
  stampedOn: string
  page: number
  slot: number
  dx: number
  dy: number
  rotation: number
  textureSeed: number
  transactionId: string
  /** The purchase's instant; the stamp prints it in the venue's timezone. */
  occurredAt: Date
}

export type StampContext = {
  venue: {
    status: string | null
    /** venues.hold_all_outbound: the venue reviews every outbound by hand. */
    holdAllOutbound: boolean
    timezone: string
    /** Null when unset or unusable: the caller fails closed. */
    passport: PassportSettings | null
  }
  guest: { optedOut: boolean }
  transaction: { occurredAt: Date; lineItemNames: string[] }
  /** This guest's stamps at this venue, oldest first. */
  prior: StoredStamp[]
  /** The ARRIVED stamp's purchase's items: the first things discovered. */
  arrivedLineItemNames: string[]
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const STAMP_COLUMNS =
  'id, seq, kind, label, stamped_on, page, slot, dx, dy, rotation, texture_seed, transaction_id, transaction:transactions!inner(occurred_at)'

type StampRow = Pick<
  Database['public']['Tables']['passport_stamps']['Row'],
  | 'id'
  | 'seq'
  | 'kind'
  | 'label'
  | 'stamped_on'
  | 'page'
  | 'slot'
  | 'dx'
  | 'dy'
  | 'rotation'
  | 'texture_seed'
  | 'transaction_id'
> & { transaction: { occurred_at: string } }

function toStored(row: StampRow): StoredStamp | string {
  if (!isStampKind(row.kind)) return `unknown stamp kind on ${row.id}`
  const occurredAt = new Date(row.transaction.occurred_at)
  if (Number.isNaN(occurredAt.getTime()))
    return `occurred_at unreadable on ${row.id}`
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    label: row.label,
    stampedOn: row.stamped_on,
    page: row.page,
    slot: row.slot,
    dx: row.dx,
    dy: row.dy,
    rotation: Number(row.rotation),
    textureSeed: row.texture_seed,
    transactionId: row.transaction_id,
    occurredAt,
  }
}

export async function loadPriorStamps(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
): Promise<StoreResult<StoredStamp[]>> {
  try {
    const { data, error } = await supabase
      .from('passport_stamps')
      .select(STAMP_COLUMNS)
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .order('seq', { ascending: true })
    if (error) return { ok: false, error: error.message }
    const out: StoredStamp[] = []
    for (const row of data ?? []) {
      const stored = toStored(row)
      // A kind outside the check constraint cannot be stored, and every
      // purchase has an instant: either one missing is reported, not skipped.
      if (typeof stored === 'string') return { ok: false, error: stored }
      out.push(stored)
    }
    return { ok: true, data: out }
  } catch (e) {
    return { ok: false, error: message(e) }
  }
}

export async function loadStampContext(
  supabase: AdminSupabaseClient,
  input: { venueId: string; guestId: string; transactionId: string },
): Promise<StoreResult<StampContext>> {
  try {
    const [venue, config, guest, transaction, prior] = await Promise.all([
      supabase
        .from('venues')
        .select('status, timezone, hold_all_outbound')
        .eq('id', input.venueId)
        .maybeSingle(),
      supabase
        .from('venue_configs')
        .select('venue_info')
        .eq('venue_id', input.venueId)
        .maybeSingle(),
      supabase
        .from('guests')
        .select('opted_out_at')
        .eq('id', input.guestId)
        .eq('venue_id', input.venueId)
        .maybeSingle(),
      // Scoped on the guest too: the bind that called us has just attributed
      // this purchase to them, and a row that says otherwise is not theirs to
      // stamp.
      supabase
        .from('transactions')
        .select('occurred_at, raw_data')
        .eq('id', input.transactionId)
        .eq('venue_id', input.venueId)
        .eq('guest_id', input.guestId)
        .maybeSingle(),
      loadPriorStamps(supabase, input.venueId, input.guestId),
    ])
    if (venue.error)
      return { ok: false, error: `venue: ${venue.error.message}` }
    if (!venue.data) return { ok: false, error: 'venue: not found' }
    if (config.error)
      return { ok: false, error: `venue_configs: ${config.error.message}` }
    if (guest.error)
      return { ok: false, error: `guest: ${guest.error.message}` }
    if (!guest.data)
      return { ok: false, error: 'guest: not found at this venue' }
    if (transaction.error)
      return { ok: false, error: `transaction: ${transaction.error.message}` }
    if (!transaction.data)
      return {
        ok: false,
        error: 'transaction: not found for this guest at this venue',
      }
    if (!prior.ok) return { ok: false, error: `prior stamps: ${prior.error}` }

    const occurredAt = new Date(transaction.data.occurred_at)
    if (Number.isNaN(occurredAt.getTime()))
      return { ok: false, error: 'transaction: occurred_at unreadable' }

    const venueInfo = config.data?.venue_info
    const passportRaw =
      venueInfo !== null &&
      typeof venueInfo === 'object' &&
      !Array.isArray(venueInfo)
        ? (venueInfo as Record<string, unknown>).passport
        : undefined

    let arrivedLineItemNames: string[] = []
    const arrived = prior.data.find((stamp) => stamp.kind === 'arrived')
    if (arrived !== undefined) {
      const arrivedTxn = await supabase
        .from('transactions')
        .select('raw_data')
        .eq('id', arrived.transactionId)
        .eq('venue_id', input.venueId)
        .maybeSingle()
      if (arrivedTxn.error)
        return {
          ok: false,
          error: `arrived transaction: ${arrivedTxn.error.message}`,
        }
      arrivedLineItemNames = parseLineItemNames(arrivedTxn.data?.raw_data)
    }

    return {
      ok: true,
      data: {
        venue: {
          status: venue.data.status,
          holdAllOutbound: venue.data.hold_all_outbound === true,
          timezone: venue.data.timezone,
          passport: parsePassportSettings(passportRaw),
        },
        guest: { optedOut: guest.data.opted_out_at !== null },
        transaction: {
          occurredAt,
          lineItemNames: parseLineItemNames(transaction.data.raw_data),
        },
        prior: prior.data,
        arrivedLineItemNames,
      },
    }
  } catch (e) {
    return { ok: false, error: message(e) }
  }
}

export type InsertStampOutcome =
  | { status: 'inserted'; id: string }
  /** This purchase already has its stamp: the claim was lost or redelivered. */
  | { status: 'already_stamped' }
  /** The seq or (page, slot) was taken by a concurrent stamp: re-read and place again. */
  | { status: 'conflict' }

export async function insertStamp(
  supabase: AdminSupabaseClient,
  row: StampInsert,
): Promise<StoreResult<InsertStampOutcome>> {
  try {
    const { data, error } = await supabase
      .from('passport_stamps')
      .insert(row)
      .select('id')
      .single()
    if (!error && data)
      return { ok: true, data: { status: 'inserted', id: data.id } }
    if (!error) return { ok: false, error: 'insert returned no row' }
    if (error.code !== PG_UNIQUE_VIOLATION)
      return { ok: false, error: error.message }
    return {
      ok: true,
      data: {
        status: error.message.includes(TRANSACTION_KEY)
          ? 'already_stamped'
          : 'conflict',
      },
    }
  } catch (e) {
    return { ok: false, error: message(e) }
  }
}

async function updateStamp(
  supabase: AdminSupabaseClient,
  scope: { id: string; venueId: string; guestId: string },
  patch: Database['public']['Tables']['passport_stamps']['Update'],
): Promise<StoreResult<null>> {
  try {
    const { data, error } = await supabase
      .from('passport_stamps')
      .update(patch)
      .eq('id', scope.id)
      .eq('venue_id', scope.venueId)
      .eq('guest_id', scope.guestId)
      .select('id')
    if (error) return { ok: false, error: error.message }
    if ((data ?? []).length !== 1)
      return { ok: false, error: `updated ${(data ?? []).length} rows, not 1` }
    return { ok: true, data: null }
  } catch (e) {
    return { ok: false, error: message(e) }
  }
}

export function recordImagePaths(
  supabase: AdminSupabaseClient,
  scope: { id: string; venueId: string; guestId: string },
  paths: { stamp: string; spread: string },
): Promise<StoreResult<null>> {
  return updateStamp(supabase, scope, {
    stamp_image_path: paths.stamp,
    spread_image_path: paths.spread,
  })
}

/** Written only once BOTH images reached the guest. */
export function markStampSent(
  supabase: AdminSupabaseClient,
  scope: { id: string; venueId: string; guestId: string },
  sentAt: Date,
): Promise<StoreResult<null>> {
  return updateStamp(supabase, scope, { sent_at: sentAt.toISOString() })
}
