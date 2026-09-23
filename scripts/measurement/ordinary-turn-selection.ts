// TAC-519: select the real Le Mil's turns on which intentions actually reached
// the prompt, so the ordinary-turn arms replay production rather than invented
// scenarios.
//
// READ-ONLY. Every statement here is a SELECT. Nothing in this file writes, and
// the one write anywhere on the measurement path is not this file's:
// buildRuntimeContext runs computeGuestState, which persists a `guest_states`
// row when a guest's recognition BAND changes. It does not fire for a guest
// whose band is stable. The caller reports the row count before and after so
// the claim is checked rather than asserted (the shape TAC-423's harness used).
//
// WHAT "a turn that rendered intentions" MEANS. messages.rendered_intentions
// (migration 045) is written on every send path and TAC-436 ruling 4 added the
// auto-send half explicitly as AUDIT so a query could prove what rendered. A
// non-empty array on an outbound row is therefore unambiguous evidence that the
// block reached the model on that turn. NULL and [] are not: NULL covers rows
// predating the write on that path, blank knowledge-gap cards, and every
// non-first bubble of a split response, and [] conflates "nothing rendered"
// with "the QR opener turn, where the block rendered but the recordable set is
// forced empty". Only the non-empty rows are used.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { OpenIntention } from '@/lib/agent/intentions/derive'
import { parseRenderedIntentionsForRecording } from '@/lib/agent/intentions/rendered'
import { parseMessageChannel } from '@/lib/schemas/message-channel'
import type { MessageChannel } from '@/lib/schemas/message-channel'

export interface OrdinaryTurn {
  /** The outbound row that carried the rendered set. */
  outboundId: string
  /** The inbound this turn replies to. Its body is the prompt's guest message. */
  inboundId: string
  inboundBody: string
  inboundChannel: MessageChannel | null
  inboundProviderMessageId: string
  inboundReceivedAt: Date
  /** TAC-518: the stored referral source, passed through rather than assumed. */
  inboundReferralSource: string | null
  /** THIS TURN'S OWN GUEST. Never collapsed onto one guest (2026-09-23 ruling). */
  guestId: string
  /** The category the live classifier gave that turn, for reporting only. */
  category: string | null
  /** What production actually rendered, parsed back into the runtime shape. */
  rendered: OpenIntention[]
}

/** Why a candidate row could not be replayed. Reported, never silently dropped. */
export interface OrdinaryTurnSkip {
  outboundId: string
  reason:
    | 'no_reply_to_message_id'
    | 'inbound_not_found'
    | 'inbound_body_empty'
    | 'no_live_intention_keys'
}

export interface OrdinaryTurnSelection {
  turns: OrdinaryTurn[]
  skipped: OrdinaryTurnSkip[]
  /** Outbound rows whose rendered_intentions was a non-empty array. */
  candidates: number
}

/**
 * Every outbound row at this venue whose `rendered_intentions` is a non-empty
 * array, newest first, resolved back to the inbound it answered.
 *
 * Two SELECTs, not a join: PostgREST cannot self-join `messages` on
 * `reply_to_message_id` without a declared relationship, and the second read is
 * a single `in` over at most a few dozen ids.
 */
export async function selectOrdinaryTurns(
  supabase: SupabaseClient,
  venueId: string,
  sinceIso: string,
): Promise<OrdinaryTurnSelection> {
  const { data: outbound, error } = await supabase
    .from('messages')
    .select('id, guest_id, reply_to_message_id, category, rendered_intentions, created_at')
    .eq('venue_id', venueId)
    .eq('direction', 'outbound')
    .not('rendered_intentions', 'is', null)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`outbound select failed: ${error.message}`)

  // jsonb_array_length is not expressible through PostgREST's filter grammar,
  // so the non-empty test is applied here rather than in SQL. The `is not null`
  // filter above is what keeps the row count small enough for that to be fine.
  const withRendered = (outbound ?? []).filter(
    (r) => Array.isArray(r.rendered_intentions) && r.rendered_intentions.length > 0,
  )

  const skipped: OrdinaryTurnSkip[] = []
  const inboundIds: string[] = []
  for (const row of withRendered) {
    if (!row.reply_to_message_id) {
      skipped.push({ outboundId: row.id, reason: 'no_reply_to_message_id' })
      continue
    }
    inboundIds.push(row.reply_to_message_id)
  }

  const inboundById = new Map<
    string,
    {
      id: string
      body: string
      provider_message_id: string | null
      created_at: string
      channel: string | null
      referral_source: string | null
    }
  >()
  if (inboundIds.length > 0) {
    const { data: inbound, error: inErr } = await supabase
      .from('messages')
      .select('id, body, provider_message_id, created_at, channel, referral_source')
      .in('id', inboundIds)
    if (inErr) throw new Error(`inbound select failed: ${inErr.message}`)
    for (const row of inbound ?? []) inboundById.set(row.id, row)
  }

  const turns: OrdinaryTurn[] = []
  for (const row of withRendered) {
    if (!row.reply_to_message_id) continue
    const inbound = inboundById.get(row.reply_to_message_id)
    if (!inbound) {
      skipped.push({ outboundId: row.id, reason: 'inbound_not_found' })
      continue
    }
    if (inbound.body.trim().length === 0) {
      // A media-only or reaction inbound. The prompt would carry no guest
      // message, which is not the turn shape this measures.
      skipped.push({ outboundId: row.id, reason: 'inbound_body_empty' })
      continue
    }
    // Reuses the production read side, so a retired key or an unparseable
    // anchor is dropped here exactly as dispatch drops it.
    const rendered = parseRenderedIntentionsForRecording(row.rendered_intentions)
    if (rendered.length === 0) {
      skipped.push({ outboundId: row.id, reason: 'no_live_intention_keys' })
      continue
    }
    turns.push({
      outboundId: row.id,
      inboundId: inbound.id,
      inboundBody: inbound.body,
      inboundChannel: parseMessageChannel(inbound.channel),
      inboundProviderMessageId: inbound.provider_message_id ?? `measurement-${inbound.id}`,
      inboundReceivedAt: new Date(inbound.created_at),
      inboundReferralSource: inbound.referral_source,
      guestId: row.guest_id,
      category: row.category,
      rendered,
    })
  }

  return { turns, skipped, candidates: withRendered.length }
}
