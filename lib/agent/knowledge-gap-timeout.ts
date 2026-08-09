// TAC-308 knowledge-gap timeout processor. Called from the external HTTP cron
// (cron-job.org) that hits /api/cron/pending-timeout every minute.
//
// What it does: finds knowledge-gap cards whose window has elapsed without an
// operator answering, and sends the guest a holding message so they aren't
// left in silence indefinitely.
//
// THE WINDOW IS A FLOOR, NOT AN SLA. `messages.pending_until` is the earliest
// a holding message may fire. With the every-minute external trigger the
// message lands within ~6 minutes of the floor. (The trigger originally lived
// on GitHub Actions with a `*/5` schedule — Vercel Hobby caps cron at daily —
// but GH queues scheduled workflows at low priority and the measured cadence
// was min 22m / median 36m / max 117m, so it moved to cron-job.org.) The
// asymmetry is deliberate: firing LATE costs a guest a few more minutes
// inside a silence they are already in, while firing EARLY would talk over an
// operator who was about to answer. Never compensate for jitter by shortening
// the window or by treating `pending_until` as approximate.
//
// Idempotency: claim-before-side-effect, CAS-gated, following
// transitionToPendingAck (lib/guests/commitments.ts) and
// claimFollowupLogRows (lib/followups/log.ts). The claim is an UPDATE that
// NULLS `pending_until` conditioned on it still being non-null; rowcount=1 is
// the exclusive right to send. Two overlapping cron runs cannot both win, so
// the holding message fires exactly once per card. A read-then-null would
// not give that guarantee, which is why the ticket's original "null it so it
// can't fire twice" was rewritten (TAC-308 decision #6).
//
// Note the claim happens BEFORE generation, not after. That trades one
// possible lost holding message (process dies between claim and send) against
// the possibility of two being sent. For a message whose entire content is
// "still on it," a duplicate is worse than a miss.
//
// Concrete, not generic — the third sibling of processDueCommitments
// (lib/guests/commitments-due.ts) and processDueFollowups
// (lib/followups/engine.ts). The shared "find eligible → claim → side effect"
// seam still isn't extracted; three instances now agree on the shape, so the
// next person to touch all three has a real basis for pulling it out.

import { createAdminClient } from '@/lib/db/admin'
import { handleHoldingMessage } from './handle-holding-message'
import { loadInboundQuestion } from './pending-question'

/**
 * Cap on cards processed per tick. Generation + send is a few seconds per
 * card and the route runs inside a Vercel function timeout, so an unbounded
 * scan on a bad day (mass outage, backlog) would run past the limit and get
 * killed mid-batch. Unclaimed cards are simply picked up on the next tick —
 * five minutes later — because the claim is what marks progress.
 */
export const MAX_CARDS_PER_TICK = 25

export interface ProcessDueKnowledgeGapsResult {
  /** Cards whose window had elapsed at scan time. */
  scanned: number
  /** Cards where this run won the CAS and earned the right to send. */
  claimed: number
  /** Cards where the CAS lost — a concurrent run or an operator got there first. */
  casLost: number
  /** Holding messages sent from a generated body. */
  sent: number
  /** Holding messages sent as the plain fallback line. */
  fallbackSent: number
  /** Cards where policy suppressed the send (guest opted out, venue holds all outbound). */
  suppressed: number
  /** Cards that errored after being claimed. */
  errored: number
  /** Cards skipped because the card had no linked inbound question. */
  invalid: number
}

interface DueCard {
  id: string
  venue_id: string
  guest_id: string
  reply_to_message_id: string | null
}

interface PendingQuestionRow {
  id: string
  providerMessageId: string
  question: string
  askedAt: Date
}

/**
 * Process every knowledge-gap card whose window has elapsed.
 *
 * Never throws — every error is caught, logged, and counted. The caller (the
 * cron route) maps the summary into a 200 so a single bad row can't fail the
 * whole tick.
 */
export async function processDueKnowledgeGaps(
  now: Date,
): Promise<ProcessDueKnowledgeGapsResult> {
  const summary: ProcessDueKnowledgeGapsResult = {
    scanned: 0,
    claimed: 0,
    casLost: 0,
    sent: 0,
    fallbackSent: 0,
    suppressed: 0,
    errored: 0,
    invalid: 0,
  }

  const due = await findDueCards(now)
  if (due === null) return summary
  summary.scanned = due.length

  for (const card of due) {
    // A card with no linked inbound has no question to hold on. Claim it
    // anyway so the scan doesn't return it every five minutes forever — the
    // clock has served its purpose and there is nothing to send.
    if (!card.reply_to_message_id) {
      console.warn(
        `[cron pending-timeout] card=${card.id} has no reply_to_message_id, clearing its clock`,
      )
      await claimCard(card.id)
      summary.invalid += 1
      continue
    }

    const question = await loadQuestion(card.reply_to_message_id)
    if (question === null) {
      console.warn(
        `[cron pending-timeout] card=${card.id} inbound ${card.reply_to_message_id} unreadable, clearing its clock`,
      )
      await claimCard(card.id)
      summary.invalid += 1
      continue
    }

    // CAS claim. Everything below this line runs at most once per card,
    // across every concurrent cron run.
    const claim = await claimCard(card.id)
    if (claim === 'error') {
      summary.errored += 1
      continue
    }
    if (claim === 'lost') {
      // Another run beat us here, or an operator approved the draft between
      // the scan and now (dispatchOperatorOutbound flips review_state, so the
      // conditional UPDATE matches nothing). Either way the guest is handled.
      summary.casLost += 1
      continue
    }
    summary.claimed += 1

    try {
      const result = await handleHoldingMessage({
        venueId: card.venue_id,
        guestId: card.guest_id,
        pendingQuestion: question,
      })
      if (result.status === 'failed') {
        console.error('[cron pending-timeout] holding message failed', {
          cardId: card.id,
          stage: result.stage,
          error: result.error,
        })
        summary.errored += 1
        continue
      }
      if (result.status === 'suppressed') {
        // Policy, not breakage: the guest opted out, or the venue holds all
        // outbound. The clock is already cleared, so this won't re-fire.
        console.log('[cron pending-timeout] holding message suppressed', {
          cardId: card.id,
          reason: result.reason,
        })
        summary.suppressed += 1
        continue
      }
      if (result.usedFallback) summary.fallbackSent += 1
      else summary.sent += 1

      // TAC-309 removed the post-send card regen. It existed for WYSIWYG on a
      // prefilled body; knowledge-gap cards are now blank, so there was
      // nothing left to keep in sync and it was spending a context build,
      // retrieval and generation per timed-out card to write nothing.
    } catch (e) {
      // handleHoldingMessage is fail-closed, so a throw is unexpected.
      console.error('[cron pending-timeout] handleHoldingMessage threw', {
        cardId: card.id,
        error: e instanceof Error ? e.message : String(e),
      })
      summary.errored += 1
    }
  }

  return summary
}

/**
 * Cards whose window has elapsed.
 *
 * The predicate deliberately keys on `pending_until` rather than on
 * `review_reason='knowledge_gap'` as the ticket first specified.
 * `review_reason` holds the priority-selected primaryTrigger, so a draft that
 * both gapped and committed a comp would carry a different label and silently
 * lose its timer. `pending_until` non-null means exactly one thing — a clock
 * is running — which is the property the scan actually needs.
 *
 * `review_state='pending'` keeps approved / edited / skipped rows out. And
 * because the filter requires `pending_until` to be non-null, the eight
 * legacy `pending_review` rows with no expiry (out of scope per the ticket)
 * are excluded by construction rather than by an explicit carve-out.
 *
 * Returns null on error — caller reports an empty summary rather than
 * throwing out of the cron.
 */
async function findDueCards(now: Date): Promise<DueCard[] | null> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('messages')
      .select('id, venue_id, guest_id, reply_to_message_id')
      .eq('review_state', 'pending')
      .not('pending_until', 'is', null)
      .lte('pending_until', now.toISOString())
      .order('pending_until', { ascending: true })
      .limit(MAX_CARDS_PER_TICK)
    if (error) {
      console.error('[cron pending-timeout] due scan failed', { error: error.message })
      return null
    }
    return data ?? []
  } catch (e) {
    console.error('[cron pending-timeout] due scan threw', {
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

/**
 * CAS claim: null out `pending_until`, conditioned on it still being set and
 * the row still being pending.
 *
 * rowcount=1 ('won') is the exclusive right to send one holding message.
 * rowcount=0 ('lost') means a concurrent run claimed it, or an operator acted
 * on the draft and moved it out of review_state='pending'.
 *
 * Nulling the column is also what makes the message one-shot: nothing else in
 * the codebase writes `pending_until` back on an existing row
 * (persistOrRegenQueuedDraft omits the key on UPDATE unless a caller passes a
 * fresh clock, and the only caller that does is the inbound gate arming a
 * card that isn't already one). This is the single writer of the
 * fired/not-fired state.
 */
async function claimCard(cardId: string): Promise<'won' | 'lost' | 'error'> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('messages')
      .update({ pending_until: null })
      .eq('id', cardId)
      .eq('review_state', 'pending')
      .not('pending_until', 'is', null)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[cron pending-timeout] claim failed', { cardId, error: error.message })
      return 'error'
    }
    return data ? 'won' : 'lost'
  } catch (e) {
    console.error('[cron pending-timeout] claim threw', {
      cardId,
      error: e instanceof Error ? e.message : String(e),
    })
    return 'error'
  }
}

/**
 * The guest's original question behind a card, or null if unreadable.
 *
 * Delegates to the shared reader in pending-question.ts so the empty-body
 * guard and fail-null posture can't drift from the prompt-block path.
 */
async function loadQuestion(inboundMessageId: string): Promise<PendingQuestionRow | null> {
  const inbound = await loadInboundQuestion(inboundMessageId)
  if (inbound === null) return null
  return {
    id: inbound.id,
    providerMessageId: inbound.providerMessageId,
    question: inbound.question,
    askedAt: inbound.askedAt,
  }
}

