import { createAdminClient } from '@/lib/db/admin'
import type { GuestState, RecognitionResult } from './types'

/**
 * Write a state transition for a guest at a venue.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS. Performs three
 * sequential operations: (1) close the current state row by setting
 * exited_at = now(), skipped if fromState is null (no prior row), (2)
 * insert the new state row with entered_at = now() and exited_at = null,
 * (3) insert an engagement_events row of type 'state_transition' with
 * { from, to, reason } in the data payload.
 *
 * Best-effort sequential. The function returns a failure result only if the
 * close-or-insert state writes themselves fail; an audit-event failure is
 * logged with a structured payload but still returns ok: true so the caller
 * sees the persisted state truth.
 *
 * TODO: switch to a Postgres function for atomic state transitions if we
 * observe inconsistent state rows in production.
 */
export async function transitionState({
  guestId,
  venueId,
  fromState,
  toState,
  reason,
}: {
  guestId: string
  venueId: string
  fromState: GuestState | null
  toState: GuestState
  reason: string
}): Promise<RecognitionResult<void>> {
  const supabase = createAdminClient()
  const now = new Date().toISOString()

  if (fromState !== null) {
    const { error: closeError } = await supabase
      .from('guest_states')
      .update({ exited_at: now })
      .eq('guest_id', guestId)
      .eq('venue_id', venueId)
      .is('exited_at', null)
    if (closeError) {
      console.error('transitionState: failed to close current state row', {
        guestId,
        venueId,
        fromState,
        toState,
        error: closeError.message,
      })
      return { ok: false, error: closeError.message, errorCode: 'close_current_state_failed' }
    }
  }

  const { error: insertError } = await supabase.from('guest_states').insert({
    guest_id: guestId,
    venue_id: venueId,
    state: toState,
    entered_at: now,
  })
  if (insertError) {
    console.error('transitionState: failed to insert new state row', {
      guestId,
      venueId,
      fromState,
      toState,
      error: insertError.message,
    })
    return { ok: false, error: insertError.message, errorCode: 'insert_new_state_failed' }
  }

  const { error: eventError } = await supabase.from('engagement_events').insert({
    guest_id: guestId,
    venue_id: venueId,
    event_type: 'state_transition',
    data: { from: fromState, to: toState, reason },
  })
  if (eventError) {
    console.error(
      'transitionState: state_transition audit event failed after state row was applied',
      {
        guestId,
        venueId,
        fromState,
        toState,
        reason,
        error: eventError.message,
      },
    )
    // State change persisted; only the audit row failed. Don't fail the function.
  }

  return { ok: true, data: undefined }
}