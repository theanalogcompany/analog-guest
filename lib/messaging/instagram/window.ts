// TAC-469: Instagram's 24-hour reply window.
//
// An app may message a person on Instagram only within 24 hours of that
// person's last message. Outside it Meta refuses the send (code 10, subcode
// 2534022), and nothing reopens the window except the guest acting again: no
// message tags, no one-time notifications, no templates.
//
// This is a GUARD, not a router (TAC-469). An agent reply answers an inbound
// message, so the window is open by definition when it sends; this catches the
// cases where that assumption fails, such as a delayed run or an operator
// approving a day-old card. Scheduled follow-ups never reach it: on Instagram
// they are operator tasks, not sends.
//
// Instagram-only. SMS has no window, and nothing outside the Instagram arms may
// import this module (window-import-guard.test.ts enforces it). Putting it in
// shared code and making SMS "always open" is the shortcut TAC-469 forbids.
//
// THE CLOCK IS META'S. The window runs from `provider_sent_at`, the
// `messaging[]` item's own timestamp (TAC-479, migration 049), never from
// `created_at`, which is when our webhook received the event. The two were
// 1.8s and 2.3s apart in production (2026-09-18), and a redelivery can land
// far later. That gap is removed by reading Meta's time, not covered by the
// margin below.
//
// The window runs from the newest guest action that has a Meta time: a message
// or an icebreaker postback, the two kinds the webhook saves as inbound rows.
// A row saved without one (every row before migration 049) is skipped, which
// is the safe direction: the true close is at least as late as the one
// computed from an older action. A guest action the handler does not save (a
// reaction, a story reply) may extend Meta's window without extending ours;
// that is the safe direction too.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

type AdminSupabaseClient = SupabaseClient<Database>

export const INSTAGRAM_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The gate closes this long before Meta's window does.
 *
 * A JUDGMENT, NOT A MEASUREMENT. What it has to cover is what reading Meta's
 * time leaves over: clock skew between our servers and Meta's (both on NTP,
 * well under a second) and the time between this check and Meta receiving the
 * send (bounded by INSTAGRAM_SEND_TIMEOUT_MS, 10 seconds). About 11 seconds in
 * all; 5 minutes is roughly 25 times that and costs 0.35% of the window. The
 * rest of it is for what nobody has measured: exactly where Meta draws its own
 * edge.
 *
 * What would show it wrong: Meta refusing a send with subcode 2534022 that this
 * gate passed. The send-failure event records `windowRemainingMs` for exactly
 * that. TAC-486's countdown should read this constant, so the bar reaches zero
 * before Meta's window closes.
 */
export const INSTAGRAM_WINDOW_MARGIN_MS = 5 * 60 * 1000

export type InstagramWindowState =
  | {
      open: true
      /** When Meta's window closes: the last guest action plus 24 hours. */
      closesAt: Date
      /** Milliseconds until Meta's window closes, margin not subtracted. */
      remainingMs: number
    }
  | {
      open: false
      reason: 'no_guest_action' | 'closed'
      closesAt: Date | null
      /** Milliseconds until Meta's window closes; negative once it has; null with no guest action. */
      remainingMs: number | null
    }

/** Pure. Open until INSTAGRAM_WINDOW_MARGIN_MS before Meta's window closes. */
export function instagramWindowState(lastGuestActionAt: Date | null, now: Date): InstagramWindowState {
  if (lastGuestActionAt === null) {
    return { open: false, reason: 'no_guest_action', closesAt: null, remainingMs: null }
  }
  const closesAt = new Date(lastGuestActionAt.getTime() + INSTAGRAM_WINDOW_MS)
  const remainingMs = closesAt.getTime() - now.getTime()
  if (remainingMs > INSTAGRAM_WINDOW_MARGIN_MS) return { open: true, closesAt, remainingMs }
  return { open: false, reason: 'closed', closesAt, remainingMs }
}

/**
 * The newest Meta time among this guest's Instagram inbound rows, or null when
 * none has one. A failed read is returned as an error, not as null: null means
 * "the window is closed", and a read that failed has not shown that.
 */
export async function loadLastGuestActionAt(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
): Promise<{ ok: true; value: Date | null } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('messages')
    .select('provider_sent_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('direction', 'inbound')
    .eq('channel', 'instagram')
    .not('provider_sent_at', 'is', null)
    .order('provider_sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data || typeof data.provider_sent_at !== 'string') return { ok: true, value: null }
  const at = new Date(data.provider_sent_at)
  return Number.isNaN(at.getTime()) ? { ok: true, value: null } : { ok: true, value: at }
}
