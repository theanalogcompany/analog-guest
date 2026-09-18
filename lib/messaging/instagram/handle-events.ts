// TAC-468: save the events in a verified Instagram delivery.
//
// Mirrors the Sendblue inbound path (app/api/webhooks/sendblue/route.ts) step
// for step: find the venue, find or create the guest, skip a message already
// saved (by provider_message_id), insert. The route then hands a new guest
// message to the agent, which for Instagram is switched off (agent-gate.ts).
//
// What each kind writes:
//   message   inbound row, status 'received'. Creates the guest if absent.
//   postback  inbound row, body = the icebreaker's title. Creates the guest if
//             absent. Saved even with no title: TAC-469 computes the 24-hour
//             reply window from the newest inbound Instagram row, and a
//             postback opens that window as much as a message does.
//   echo      outbound row, status 'sent', shaped like sendReaction's outbound
//             insert (lib/messaging/expressions.ts), the one other outbound row
//             written outside the agent: no review_state, no generated_by.
//             Never creates a guest (ruled 2026-09-18): an echo is the venue's
//             activity, and staff messaging a supplier from the venue account
//             must not create a "guest".
//   read      nothing. There is no column for read state (no read_at, and
//             messages_status_check has no 'read'), so the receipt is matched
//             to its row and logged (ruled 2026-09-18, option C). Never creates
//             a guest either.
//
// Every insert names `channel: 'instagram'`. messages.channel defaults to
// 'text' (migration 048) until TAC-472 removes the default, so an Instagram row
// that omitted it would be recorded as a text message with no error at all.
//
// Two deliberate differences from Sendblue:
//   - A delivery holds many events. Each is handled on its own, in order, and a
//     failure or a throw in one never stops the rest.
//   - When two first contacts from a new guest race, the losing guest insert
//     gets 23505 and re-reads the winner's row. Sendblue logs that insert as
//     failed and loses the message.
//
// Nothing here logs an IGSID, a mid, message text, or a referral value
// (TAC-458): the outcome carries our own row IDs, and logInstagramOutcome is
// the only thing that writes it to a log line.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

import {
  parseInstagramDelivery,
  type InstagramEchoEvent,
  type InstagramHandledEvent,
  type InstagramMessageEvent,
  type InstagramPostbackEvent,
  type InstagramReadEvent,
  type InstagramUnhandledReason,
} from './parse-events'

type AdminSupabaseClient = SupabaseClient<Database>
type MessageInsert = Database['public']['Tables']['messages']['Insert']
type GuestInsert = Database['public']['Tables']['guests']['Insert']

const UNIQUE_VIOLATION = '23505'

export type InstagramFailureStage =
  | 'venue_lookup'
  | 'guest_lookup'
  | 'guest_insert'
  | 'message_lookup'
  | 'message_insert'
  | 'read_lookup'
  | 'unexpected'

export type InstagramEventOutcome =
  | { status: 'unhandled'; reason: InstagramUnhandledReason; fields: string[] }
  | {
      status: 'persisted'
      kind: 'message' | 'postback' | 'echo'
      venueId: string
      guestId: string
      messageId: string
      guestCreated: boolean
      hasReferral: boolean
    }
  | {
      status: 'duplicate'
      kind: 'message' | 'postback' | 'echo'
      venueId: string
      /** The row already saved, or null when only a 23505 said so. */
      messageId: string | null
    }
  /** A read receipt. `messageId` is the row that was read, or null if we don't have it. */
  | { status: 'read'; venueId: string; guestId: string; messageId: string | null }
  | {
      status: 'skipped'
      kind: InstagramHandledEvent['kind']
      reason: 'venue_not_found' | 'unknown_guest'
    }
  | {
      status: 'failed'
      kind: InstagramHandledEvent['kind']
      stage: InstagramFailureStage
      error: string
      code: string | null
    }

type Failure = { stage: InstagramFailureStage; error: string; code: string | null }
type Step<T> = { ok: true; value: T } | { ok: false; failure: Failure }

function fail(stage: InstagramFailureStage, error: { message: string; code?: string } | null): Failure {
  return { stage, error: error?.message ?? 'no row returned', code: error?.code ?? null }
}

function failedOutcome(kind: InstagramHandledEvent['kind'], failure: Failure): InstagramEventOutcome {
  return { status: 'failed', kind, ...failure }
}

async function findVenue(
  supabase: AdminSupabaseClient,
  accountId: string,
  cache: Map<string, string | null>,
): Promise<Step<string | null>> {
  const cached = cache.get(accountId)
  if (cached !== undefined) return { ok: true, value: cached }

  const { data, error } = await supabase
    .from('venues')
    .select('id')
    .eq('instagram_account_id', accountId)
    .maybeSingle()
  // A failed lookup is not cached, so the next event in the delivery retries.
  if (error) return { ok: false, failure: fail('venue_lookup', error) }

  const venueId = data?.id ?? null
  cache.set(accountId, venueId)
  return { ok: true, value: venueId }
}

async function findGuest(
  supabase: AdminSupabaseClient,
  venueId: string,
  igsid: string,
): Promise<Step<string | null>> {
  const { data, error } = await supabase
    .from('guests')
    .select('id')
    .eq('venue_id', venueId)
    .eq('instagram_scoped_id', igsid)
    .maybeSingle()
  if (error) return { ok: false, failure: fail('guest_lookup', error) }
  return { ok: true, value: data?.id ?? null }
}

async function findOrCreateGuest(
  supabase: AdminSupabaseClient,
  venueId: string,
  igsid: string,
): Promise<Step<{ guestId: string; created: boolean }>> {
  const existing = await findGuest(supabase, venueId, igsid)
  if (!existing.ok) return existing
  if (existing.value !== null) return { ok: true, value: { guestId: existing.value, created: false } }

  const nowIso = new Date().toISOString()
  // No phone_number: an Instagram guest has none, and migration 048's
  // guests_must_have_identity accepts the IGSID instead. created_via is always
  // 'inbound_message' (ruled 2026-09-18): a referral ref alone can't tell a QR
  // sign at the counter from a link shared online.
  const guest: GuestInsert = {
    venue_id: venueId,
    instagram_scoped_id: igsid,
    created_via: 'inbound_message',
    first_contacted_at: nowIso,
    last_inbound_at: nowIso,
    last_interaction_at: nowIso,
  }
  const { data, error } = await supabase.from('guests').insert(guest).select('id').single()
  if (!error && data) return { ok: true, value: { guestId: data.id, created: true } }

  if (error?.code === UNIQUE_VIOLATION) {
    // Another delivery created this guest between our read and our insert.
    const winner = await findGuest(supabase, venueId, igsid)
    if (!winner.ok) return winner
    if (winner.value !== null) return { ok: true, value: { guestId: winner.value, created: false } }
  }
  return { ok: false, failure: fail('guest_insert', error) }
}

async function findMessageId(supabase: AdminSupabaseClient, mid: string): Promise<Step<string | null>> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('provider_message_id', mid)
    .maybeSingle()
  if (error) return { ok: false, failure: fail('message_lookup', error) }
  return { ok: true, value: data?.id ?? null }
}

function inboundInsert(
  event: InstagramMessageEvent | InstagramPostbackEvent,
  venueId: string,
  guestId: string,
): MessageInsert {
  const isMessage = event.kind === 'message'
  return {
    venue_id: venueId,
    guest_id: guestId,
    channel: 'instagram',
    direction: 'inbound',
    status: 'received',
    body: (isMessage ? event.text : event.title) ?? '',
    media_urls: isMessage ? event.mediaUrls : [],
    provider_message_id: event.mid,
    referral_ref: event.referral?.ref ?? null,
    referral_source: event.referral?.source ?? null,
  }
}

function echoInsert(event: InstagramEchoEvent, venueId: string, guestId: string): MessageInsert {
  return {
    venue_id: venueId,
    guest_id: guestId,
    channel: 'instagram',
    direction: 'outbound',
    status: 'sent',
    body: event.text ?? '',
    media_urls: event.mediaUrls,
    provider_message_id: event.mid,
    sent_at: new Date().toISOString(),
  }
}

async function insertMessage(
  supabase: AdminSupabaseClient,
  event: InstagramMessageEvent | InstagramPostbackEvent | InstagramEchoEvent,
  venueId: string,
  guest: { guestId: string; created: boolean },
): Promise<InstagramEventOutcome> {
  const existing = await findMessageId(supabase, event.mid)
  if (!existing.ok) return failedOutcome(event.kind, existing.failure)
  if (existing.value !== null) {
    return { status: 'duplicate', kind: event.kind, venueId, messageId: existing.value }
  }

  const row =
    event.kind === 'echo'
      ? echoInsert(event, venueId, guest.guestId)
      : inboundInsert(event, venueId, guest.guestId)
  const { data, error } = await supabase.from('messages').insert(row).select('id').single()
  if (error?.code === UNIQUE_VIOLATION) {
    // Meta delivered the same event twice at once; the other copy saved it.
    return { status: 'duplicate', kind: event.kind, venueId, messageId: null }
  }
  if (error || !data) return failedOutcome(event.kind, fail('message_insert', error))

  return {
    status: 'persisted',
    kind: event.kind,
    venueId,
    guestId: guest.guestId,
    messageId: data.id,
    guestCreated: guest.created,
    hasReferral: event.kind !== 'echo' && event.referral !== null,
  }
}

async function matchRead(
  supabase: AdminSupabaseClient,
  event: InstagramReadEvent,
  venueId: string,
  guestId: string,
): Promise<InstagramEventOutcome> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('provider_message_id', event.mid)
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .maybeSingle()
  if (error) return failedOutcome('read', fail('read_lookup', error))
  return { status: 'read', venueId, guestId, messageId: data?.id ?? null }
}

async function handleEvent(
  supabase: AdminSupabaseClient,
  event: InstagramHandledEvent,
  venueCache: Map<string, string | null>,
): Promise<InstagramEventOutcome> {
  const venue = await findVenue(supabase, event.accountId, venueCache)
  if (!venue.ok) return failedOutcome(event.kind, venue.failure)
  if (venue.value === null) return { status: 'skipped', kind: event.kind, reason: 'venue_not_found' }
  const venueId = venue.value

  // Only a guest's own action creates a guest.
  if (event.kind === 'message' || event.kind === 'postback') {
    const guest = await findOrCreateGuest(supabase, venueId, event.guestIgsid)
    if (!guest.ok) return failedOutcome(event.kind, guest.failure)
    return insertMessage(supabase, event, venueId, guest.value)
  }

  const guest = await findGuest(supabase, venueId, event.guestIgsid)
  if (!guest.ok) return failedOutcome(event.kind, guest.failure)
  if (guest.value === null) return { status: 'skipped', kind: event.kind, reason: 'unknown_guest' }

  if (event.kind === 'echo') {
    return insertMessage(supabase, event, venueId, { guestId: guest.value, created: false })
  }
  return matchRead(supabase, event, venueId, guest.value)
}

/**
 * Save every event in a verified delivery and report what happened to each,
 * in delivery order. Never throws: a throw while handling one event becomes a
 * `failed` outcome for that event, and the rest are still handled.
 */
export async function processInstagramDelivery(
  parsed: unknown,
  supabase: AdminSupabaseClient,
): Promise<InstagramEventOutcome[]> {
  const venueCache = new Map<string, string | null>()
  const outcomes: InstagramEventOutcome[] = []

  for (const event of parseInstagramDelivery(parsed)) {
    if (event.kind === 'unhandled') {
      outcomes.push({ status: 'unhandled', reason: event.reason, fields: event.fields })
      continue
    }
    try {
      outcomes.push(await handleEvent(supabase, event, venueCache))
    } catch (e) {
      outcomes.push(
        failedOutcome(event.kind, {
          stage: 'unexpected',
          error: e instanceof Error ? e.message : String(e),
          code: null,
        }),
      )
    }
  }
  return outcomes
}

/**
 * One log line per outcome. The only place an outcome reaches a log, so the
 * TAC-458 rule (no IGSID, mid, text or referral value) is held here: every
 * field below is our own row ID, a count, a flag, or a name.
 */
export function logInstagramOutcome(outcome: InstagramEventOutcome): void {
  switch (outcome.status) {
    case 'unhandled':
      console.warn('instagram webhook: event not handled; acknowledged', {
        event: 'instagram_event_unhandled',
        reason: outcome.reason,
        fields: outcome.fields,
      })
      return
    case 'persisted':
      console.log('instagram webhook: event saved', {
        event: 'instagram_event_persisted',
        kind: outcome.kind,
        venueId: outcome.venueId,
        guestId: outcome.guestId,
        messageId: outcome.messageId,
        guestCreated: outcome.guestCreated,
        hasReferral: outcome.hasReferral,
      })
      return
    case 'duplicate':
      console.log('instagram webhook: event already saved', {
        event: 'instagram_event_duplicate',
        kind: outcome.kind,
        venueId: outcome.venueId,
        messageId: outcome.messageId,
      })
      return
    case 'read':
      console.log('instagram webhook: read receipt', {
        event: 'instagram_read_receipt',
        venueId: outcome.venueId,
        guestId: outcome.guestId,
        matched: outcome.messageId !== null,
        messageId: outcome.messageId,
      })
      return
    case 'skipped':
      // venue_not_found: no venue has this account in venues.instagram_account_id.
      // The account ID is not logged (TAC-458); read it from a delivery's
      // entry.id when mapping the venue.
      console.warn('instagram webhook: event skipped', {
        event: 'instagram_event_skipped',
        kind: outcome.kind,
        reason: outcome.reason,
      })
      return
    case 'failed':
      console.error('instagram webhook: event not saved; acknowledged anyway', {
        event: 'instagram_event_persist_failed',
        kind: outcome.kind,
        stage: outcome.stage,
        error: outcome.error,
        code: outcome.code,
      })
      return
  }
}
