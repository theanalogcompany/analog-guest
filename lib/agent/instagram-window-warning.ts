// TAC-473: warn the operator when a held Instagram draft has an hour left.
//
// Called from the external HTTP cron (cron-job.org) that hits
// /api/cron/pending-timeout every minute, beside processDueKnowledgeGaps.
//
// WHY THAT ROUTE, AND NOT A NEW ONE (ruled 2026-09-23). It is already hit every
// minute, already authenticated with EXTERNAL_CRON_SECRET, and an every-minute
// tick is exactly the granularity a one-hour warning wants. A new route would
// have meant a third cron-job.org entry to create and monitor for no gain.
//
// WHAT THAT ROUTE ACTUALLY DOES NOW, since the name no longer says it: its
// original job, the knowledge-gap holding message, is DISABLED and TAC-484
// disabled it permanently, so processDueKnowledgeGaps returns an all-zero
// summary without touching the database. Until this processor landed the route
// was a live, authenticated, every-minute trigger doing nothing at all. The
// name was not changed here, deliberately — renaming it means re-pointing the
// cron-job.org entry, which is an operational step for a cosmetic gain — so
// read "pending-timeout" as "a pending card is timing out", which is true of
// both jobs.
//
// FOURTH concrete sibling of processDueCommitments, processDueFollowups,
// processDueKnowledgeGaps and processDueCommitmentLifecycle. Still
// concrete-not-generic: the shared find-eligible → claim → side-effect seam
// stays unextracted.
//
// IDEMPOTENCY IS A COLUMN, NOT AN INTERVAL. The tick is every minute and the
// warning window is an hour, so without durable state a single card would push
// sixty times. `messages.window_warning_pushed_at` is the marker, claimed by
// CAS before the push, exactly as processDueKnowledgeGaps claims
// `pending_until`. Migration 038's escalation lesson is the precedent: an
// alert that re-fires every tick is not noisy, it is worthless.
//
// Claim BEFORE the push, like its siblings. That trades one possible lost
// warning (the process dies between claim and push) against a push storm if a
// marker write fails repeatedly. The house rule for pushes is to fail toward
// the loud side, but "loud" there means an unrecognised trigger still pushing
// once, not one card pushing on every tick for an hour.

import { createAdminClient } from '@/lib/db/admin'
import { INSTAGRAM_WINDOW_MS, loadLastGuestActionAt } from '@/lib/messaging/instagram/window'
import { sendInstagramWindowWarningPush } from '@/lib/notifications/send-instagram-window-push'

/**
 * How much of the window has to be left for the warning to fire.
 *
 * ONE HOUR, from the ticket. It is the last point at which a tap can still send
 * from inside the app; below it the operator is increasingly going to be
 * copying text into Instagram by hand instead.
 *
 * Measured against META's TRUE deadline, the same one the Contract's
 * `replyWindowExpiresAt` carries. The server's own send gate closes
 * INSTAGRAM_WINDOW_MARGIN_MS (5 minutes) earlier, so the operator really has
 * about 55 usable minutes when this fires. Warning on the true deadline keeps
 * one definition of "time left" across the push, the wire and the card.
 */
export const INSTAGRAM_WINDOW_WARNING_MS = 60 * 60 * 1000

export interface ProcessInstagramWindowWarningsResult {
  /** Pending Instagram drafts considered. */
  scanned: number
  /** Drafts inside the warning window and not yet warned. */
  due: number
  /** Drafts where this run won the CAS and earned the right to push. */
  claimed: number
  /** Drafts where the CAS lost to a concurrent run. */
  casLost: number
  /** Pushes dispatched. */
  pushed: number
  /** Drafts skipped because the window is not close enough yet. */
  notYet: number
  /** Drafts skipped because the window has already closed. */
  expired: number
  /** Drafts with no readable window anchor. */
  windowUnknown: number
  /** Drafts that errored. */
  errored: number
}

interface PendingInstagramDraft {
  id: string
  venue_id: string
  guest_id: string
  guest: { first_name: string | null } | null
}

function emptySummary(): ProcessInstagramWindowWarningsResult {
  return {
    scanned: 0,
    due: 0,
    claimed: 0,
    casLost: 0,
    pushed: 0,
    notYet: 0,
    expired: 0,
    windowUnknown: 0,
    errored: 0,
  }
}

/**
 * Find held Instagram drafts with an hour or less left, claim each, and push.
 * Never throws: it runs inside a cron tick.
 */
export async function processInstagramWindowWarnings(
  now: Date,
): Promise<ProcessInstagramWindowWarningsResult> {
  const summary = emptySummary()
  const supabase = createAdminClient()

  // Only cards that have never been warned. The marker is what makes the
  // every-minute tick safe, and filtering on it here keeps the scan small.
  const { data: drafts, error } = await supabase
    .from('messages')
    .select('id, venue_id, guest_id, guest:guests!inner(first_name)')
    .eq('review_state', 'pending')
    .eq('channel', 'instagram')
    .is('window_warning_pushed_at', null)
  if (error) {
    console.error('[cron instagram-window] scan failed', { error: error.message })
    summary.errored += 1
    return summary
  }

  const rows = (drafts ?? []) as unknown as PendingInstagramDraft[]
  summary.scanned = rows.length

  // The window anchor is per GUEST, not per card, so a guest holding several
  // cards is read once rather than once per card.
  const anchorByGuest = new Map<string, number | null>()

  for (const draft of rows) {
    try {
      const anchorKey = `${draft.venue_id}:${draft.guest_id}`
      if (!anchorByGuest.has(anchorKey)) {
        // loadLastGuestActionAt, not a second copy of that query. It is what
        // the SEND GATE consults, so reading the anchor any other way here
        // would let the warning disagree with the thing it is warning about.
        const anchor = await loadLastGuestActionAt(supabase, draft.venue_id, draft.guest_id)
        // A failed read is NOT null. Null means "no guest action"; a read that
        // failed has not established that, so it is an error for this draft and
        // the next tick tries again.
        if (!anchor.ok) throw new Error(anchor.error)
        anchorByGuest.set(anchorKey, anchor.value === null ? null : anchor.value.getTime())
      }

      const anchor = anchorByGuest.get(anchorKey) ?? null
      if (anchor === null) {
        // No saved guest action carries Meta's clock, so there is no deadline
        // to warn about. Same posture as the Contract's null: unknown, not
        // expired.
        summary.windowUnknown += 1
        continue
      }

      const remainingMs = anchor + INSTAGRAM_WINDOW_MS - now.getTime()
      if (remainingMs <= 0) {
        // Already closed. Warning now would be telling the operator to hurry
        // for something they can no longer do from the app.
        summary.expired += 1
        continue
      }
      if (remainingMs > INSTAGRAM_WINDOW_WARNING_MS) {
        summary.notYet += 1
        continue
      }
      summary.due += 1

      // CAS: the marker is claimed before the push, and only if nobody else
      // claimed it. rowcount 1 is the exclusive right to push this card.
      const { data: claimed, error: claimError } = await supabase
        .from('messages')
        .update({ window_warning_pushed_at: now.toISOString() })
        .eq('id', draft.id)
        .eq('review_state', 'pending')
        .is('window_warning_pushed_at', null)
        .select('id')
      if (claimError) throw new Error(claimError.message)
      if (!claimed || claimed.length !== 1) {
        summary.casLost += 1
        continue
      }
      summary.claimed += 1

      await sendInstagramWindowWarningPush({
        draftId: draft.id,
        venueId: draft.venue_id,
        guestId: draft.guest_id,
        guestFirstName: draft.guest?.first_name ?? null,
        remainingMs,
      })
      summary.pushed += 1
    } catch (err) {
      // Per card, so one bad row cannot abandon the rest of the tick.
      console.error('[cron instagram-window] draft failed', {
        draftId: draft.id,
        error: err instanceof Error ? err.message : String(err),
      })
      summary.errored += 1
    }
  }

  return summary
}
