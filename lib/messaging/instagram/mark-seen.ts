// TAC-540: show the guest Seen, about a second after they hit send.
//
// Shaped like its neighbour refresh-profile.ts, and for the same reasons: the
// webhook route hands it to `waitUntil` right after the 200, it does its own
// reads, it never throws, and it logs its own outcome. Nothing downstream
// reads its result.
//
// WHY THE WEBHOOK AND NOT THE AGENT. Seen has to be fast to mean anything, and
// the agent's first chance to send it is behind findExistingReply, loadInbound,
// its own venue-status read and then COALESCE_SETTLE_MS. From here it is one
// read and one POST, both off the response path.
//
// WHAT COUNTS AS A TURN IS NOT DECIDED HERE. The route calls this only when
// `resolveAgentHandoff` returned `run`, which is what excludes an echo, a read
// receipt, a bare scan referral, a redelivery, a titleless postback and a shut
// agent gate. Re-deriving any of that here would be a second copy of the
// handoff rule, and the two would agree until one of them changed.
//
// THE ONE EXCLUSION THE HANDOFF CANNOT GIVE US is the paused venue, because
// `venues.status` is read inside runInboundTurn, behind the settle. So it is
// read again here: one primary-key query per turn-starting inbound, inside
// waitUntil. The alternatives were worse. Widening loadInstagramSendTarget
// coupled a send-target lookup to processing state, and the operator path uses
// that same lookup on a paused venue deliberately. Exporting handle-inbound's
// private loadVenueStatus pulled the whole agent orchestrator into the
// webhook's Seen path for one SELECT.
//
// AN UNREADABLE STATUS DOES NOT MARK SEEN, and that is the opposite of
// isVenueProcessingHalted's own fail-open default. Deliberate, and the
// difference is what each decision costs. That helper decides whether to
// REPLY, where a venue going silent because one column could not be read is
// the worse failure; here the only cost of skipping is a missing tick, and the
// only cost of getting it wrong is telling a guest at a switched-off venue
// that somebody is reading. So the verdict still comes from the shared
// predicate — two copies of "paused" is how they drift — and the unreadable
// case is refused before it reaches that predicate.
//
// Never throws, and nothing about a failure is recoverable, so every outcome
// is logged and returned rather than raised.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { captureInstagramSenderActionFailed } from '@/lib/analytics/posthog'
import { isVenueProcessingHalted } from '@/lib/venues/status'

import { sendInstagramSenderAction, type InstagramSenderActionResult } from './sender-actions'
import { loadInstagramSendTarget, type InstagramSendTargetResult } from './send-target'

type AdminSupabaseClient = SupabaseClient<Database>

/**
 * Why Seen was not sent, or that it was.
 *
 * `venue_halted` and `venue_status_unreadable` are separate because they have
 * different fixes: one is somebody having switched the venue off on purpose,
 * the other is a database problem. Collapsing them would send whoever is on
 * call looking in the wrong place — the same reasoning send-target.ts gives
 * for splitting `token_missing` from `token_unreadable`.
 */
export type MarkSeenOutcome =
  | { status: 'sent' }
  | { status: 'venue_halted'; venueStatus: string }
  | { status: 'venue_status_unreadable' }
  | { status: 'no_send_target'; problem: string }
  | { status: 'send_failed'; kind: string }

export interface MarkSeenTarget {
  venueId: string
  guestId: string
}

/**
 * Injected so a test asserts on the calls this actually makes rather than on
 * a mock's opinion of them. `dispatch-instagram-reply.ts`'s shape, and for
 * the same reason: the send target resolution reads a credentials table, and
 * stubbing it at the module boundary would hide which venue was asked about.
 */
export interface MarkSeenDeps {
  loadTarget: (input: MarkSeenTarget) => Promise<InstagramSendTargetResult>
  sendAction: (input: {
    accountId: string
    recipientId: string
    token: string
  }) => Promise<InstagramSenderActionResult>
}

function defaultDeps(supabase: AdminSupabaseClient): MarkSeenDeps {
  return {
    loadTarget: (input) => loadInstagramSendTarget(supabase, input),
    sendAction: (input) => sendInstagramSenderAction({ ...input, action: 'mark_seen', fetchImpl: fetch }),
  }
}

/**
 * Mark the guest's thread as seen. Fire-and-forget; never throws.
 */
export async function markInboundSeen(
  supabase: AdminSupabaseClient,
  target: MarkSeenTarget,
  injected: Partial<MarkSeenDeps> = {},
): Promise<MarkSeenOutcome> {
  const deps: MarkSeenDeps = { ...defaultDeps(supabase), ...injected }
  try {
    const { data, error } = await supabase
      .from('venues')
      .select('status')
      .eq('id', target.venueId)
      .maybeSingle()
    if (error) {
      // See the header: refused BEFORE isVenueProcessingHalted, because that
      // helper's unreadable case means "carry on" and here it must not.
      console.warn('instagram: venue status unreadable, not marking seen', {
        event: 'instagram_mark_seen_skipped',
        reason: 'venue_status_unreadable',
        venueId: target.venueId,
        guestId: target.guestId,
        error: error.message,
      })
      return { status: 'venue_status_unreadable' }
    }
    const venueStatus = data?.status ?? null
    if (isVenueProcessingHalted(venueStatus)) {
      // TAC-529's switch, honoured here too. A venue somebody stopped must not
      // tell a guest it is reading their message.
      console.log('instagram: venue is halted, not marking seen', {
        event: 'instagram_mark_seen_skipped',
        reason: 'venue_halted',
        venueId: target.venueId,
        venueStatus,
      })
      return { status: 'venue_halted', venueStatus: venueStatus ?? 'unknown' }
    }

    const targetResult = await deps.loadTarget(target)
    if (!targetResult.ok) {
      console.warn('instagram: no send target, not marking seen', {
        event: 'instagram_mark_seen_skipped',
        reason: targetResult.problem,
        venueId: target.venueId,
        guestId: target.guestId,
      })
      return { status: 'no_send_target', problem: targetResult.problem }
    }

    const sent = await deps.sendAction({
      accountId: targetResult.target.accountId,
      recipientId: targetResult.target.recipientId,
      token: targetResult.target.token,
    })
    if (!sent.ok) {
      console.warn('instagram: mark_seen failed (cosmetic)', {
        event: 'instagram_sender_action_failed',
        action: 'mark_seen',
        kind: sent.kind,
        venueId: target.venueId,
        guestId: target.guestId,
      })
      await captureInstagramSenderActionFailed({
        venueId: target.venueId,
        guestId: target.guestId,
        action: 'mark_seen',
        kind: sent.kind,
      })
      return { status: 'send_failed', kind: sent.kind }
    }
    return { status: 'sent' }
  } catch (e) {
    // graphRequest and the reads are all value-returning today, so reaching
    // here is a bug in our own code rather than a provider fault. Caught
    // anyway: this runs inside waitUntil, where an escaping rejection is an
    // unhandled one.
    console.error('instagram: markInboundSeen threw unexpectedly', {
      event: 'instagram_mark_seen_threw',
      venueId: target.venueId,
      guestId: target.guestId,
      error: e instanceof Error ? e.message : String(e),
    })
    return { status: 'send_failed', kind: 'unexpected_throw' }
  }
}
