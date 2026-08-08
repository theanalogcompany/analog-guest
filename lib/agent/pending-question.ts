// TAC-308: load the question this guest is still owed an answer to.
//
// A knowledge-gap card is a row in `messages` with review_state='pending'
// that `isKnowledgeGapCard` recognizes (see stages.ts for why that predicate
// takes both pending_until and review_reason). The question itself is not on
// that row — the card holds the agent's DRAFT ANSWER. The question is the
// inbound the draft replies to, reachable via `reply_to_message_id`, which
// the queue path already populates from `ctx.currentMessage` inside
// `buildOutboundInsert`.
//
// Two round trips rather than a PostgREST self-join: `messages` referencing
// `messages` through reply_to_message_id makes the embedded-relation syntax
// ambiguous to read and easy to break silently, and the second query only
// runs when a card actually exists. The common path costs one indexed lookup
// that returns nothing.
//
// Fail-OPEN throughout. A DB hiccup here means the `## Unanswered question`
// block is missing from one prompt — the reply is slightly worse, the card
// and its clock are untouched, and the universal no-promise rules in
// SYSTEM_TEMPLATE still apply. Failing the agent run instead would be a far
// larger outage for a context block that is a nudge, not a guardrail.

import { createAdminClient } from '@/lib/db/admin'
import type { PendingQuestion } from '@/lib/ai'
import { APPROVAL_TRIGGERS, isKnowledgeGapCard } from './stages'

export interface LoadedPendingQuestion {
  /** messages.id of the knowledge-gap card holding the pending slot. */
  draftId: string
  /** The guest's original question, when they asked, and what this turn is doing about it. */
  question: PendingQuestion
}

/**
 * Find the outstanding knowledge-gap question for a (venue, guest) pair.
 *
 * Returns null when nothing is outstanding, when the card has no linked
 * inbound, when the linked inbound has an empty body, or on any DB error.
 *
 * Mode is derived from whether the clock is still running:
 *   pending_until non-null → 'outstanding'  (guest has been told nothing)
 *   pending_until null     → 'acknowledged' (the holding message has fired)
 *
 * The timer path overrides the result to 'writing_holding' when it is
 * generating the holding message itself.
 */
export async function findPendingQuestion(
  venueId: string,
  guestId: string,
): Promise<LoadedPendingQuestion | null> {
  try {
    const supabase = createAdminClient()
    // Mirrors isKnowledgeGapCard's two conditions in PostgREST form. The
    // predicate is duplicated here because it has to run server-side as a
    // filter; the shared function below re-checks the returned row so the two
    // can't disagree about a row that slipped through.
    const { data: card, error: cardError } = await supabase
      .from('messages')
      .select('id, reply_to_message_id, pending_until, review_reason')
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .eq('direction', 'outbound')
      .eq('review_state', 'pending')
      .or(
        `pending_until.not.is.null,review_reason.eq.${APPROVAL_TRIGGERS.KNOWLEDGE_GAP}`,
      )
      .limit(1)
      .maybeSingle()

    if (cardError) {
      console.warn(
        `[agent] findPendingQuestion card lookup degraded for venue=${venueId} guest=${guestId}: ${cardError.message}`,
      )
      return null
    }
    if (!card || !isKnowledgeGapCard(card) || !card.reply_to_message_id) return null

    const inbound = await loadInboundQuestion(card.reply_to_message_id)
    if (inbound === null) return null

    return {
      draftId: card.id,
      question: {
        question: inbound.question,
        askedAt: inbound.askedAt,
        mode: card.pending_until !== null ? 'outstanding' : 'acknowledged',
      },
    }
  } catch (e) {
    console.warn(
      `[agent] findPendingQuestion threw for venue=${venueId} guest=${guestId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
}

export interface InboundQuestion {
  id: string
  question: string
  askedAt: Date
  /** '' when the row has no provider id (shouldn't happen for a real inbound). */
  providerMessageId: string
}

/**
 * Read the guest's original question off the inbound row a knowledge-gap card
 * replies to.
 *
 * Shared by `findPendingQuestion` (prompt block) and the timeout processor
 * (holding message + card regen) so the empty-body guard and the fail-null
 * posture can't drift between them — this text is what the holding message is
 * written against, so a disagreement about "is this question readable" would
 * show up as two different guest experiences.
 *
 * Returns null on error or on an empty body. Never throws.
 */
export async function loadInboundQuestion(
  inboundMessageId: string,
): Promise<InboundQuestion | null> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('messages')
      .select('id, body, created_at, provider_message_id')
      .eq('id', inboundMessageId)
      .maybeSingle()
    if (error) {
      console.warn(
        `[agent] loadInboundQuestion degraded for message=${inboundMessageId}: ${error.message}`,
      )
      return null
    }
    if (!data || data.body.trim().length === 0) return null
    return {
      id: data.id,
      question: data.body,
      askedAt: new Date(data.created_at),
      providerMessageId: data.provider_message_id ?? '',
    }
  } catch (e) {
    console.warn(
      `[agent] loadInboundQuestion threw for message=${inboundMessageId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
}
