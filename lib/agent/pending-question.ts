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
//
// TAC-484: `loadInboundQuestion` also requires the linked inbound to READ as
// a question (looksLikeQuestion) before it counts as "the question" a card is
// holding. Before this, ANY non-empty inbound body qualified, so a card
// replying to a plain statement still rendered "the venue still owes them an
// answer" as settled fact. Same fail-toward-missing-the-nudge posture as the
// empty-body guard it sits beside.

import { createAdminClient } from '@/lib/db/admin'
import type { PendingQuestion } from '@/lib/ai'
import { looksLikeQuestion } from './looks-like-question'
import { KNOWLEDGE_GAP_CARD_REVIEW_REASONS, isKnowledgeGapCard } from './stages'

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
 * inbound, when the linked inbound has an empty body or doesn't read as a
 * question (TAC-484, looksLikeQuestion), or on any DB error.
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
    // Mirrors isKnowledgeGapCard's conditions in PostgREST form. The predicate
    // is duplicated here because it has to run server-side as a filter; the
    // shared function below re-checks the returned row so the two can't
    // disagree about a row that slipped through.
    //
    // TAC-364: the review_reason legs are now GENERATED from the shared
    // KNOWLEDGE_GAP_CARD_REVIEW_REASONS rather than hand-listed here. They were
    // hand-listed, and they drifted: this query carried one value while
    // isKnowledgeGapCard carried two, so a `knowledge_gap_backstop` card whose
    // clock had already fired was recognized by the predicate and invisible to
    // this query — the `## Unanswered question` block silently vanished for
    // that guest while the card still sat in the operator's queue. Nothing
    // caught it, because the re-check below only sees rows the filter DID
    // return; a row the filter never returns is indistinguishable from no row
    // at all. The filter STRING is asserted in pending-question.test.ts, since
    // Postgres is the only thing that evaluates it.
    const { data: card, error: cardError } = await supabase
      .from('messages')
      .select('id, reply_to_message_id, pending_until, review_reason')
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .eq('direction', 'outbound')
      .eq('review_state', 'pending')
      .or(
        [
          'pending_until.not.is.null',
          ...KNOWLEDGE_GAP_CARD_REVIEW_REASONS.map((r) => `review_reason.eq.${r}`),
        ].join(','),
      )
      // TAC-394: an explicit order, because there can now be two. A guest holds
      // up to two pending cards (migration 041), and either slot can hold a
      // knowledge-gap card: a blank self-reported card in the conversation
      // slot, a backstop-caught comp in the obligation slot. Without ORDER BY
      // Postgres may return either, so `## Unanswered question` could swap
      // between two questions from one turn to the next. The OLDEST card is the
      // question the guest has waited on longest.
      //
      // Known limit, recorded rather than fixed: with a gap card in each slot
      // only the oldest question renders. Rendering both needs a prompt change,
      // and a prompt change needs a pre-registered measurement run, which a
      // case that may never occur at one venue does not justify.
      .order('created_at', { ascending: true })
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
 * Returns null on error, on an empty body, or when the body doesn't read as a
 * question (TAC-484, looksLikeQuestion). Without that last check any
 * non-empty inbound — including a plain statement — became "the question"
 * this card is holding, and `formatPendingQuestion` then asserted, as settled
 * fact, that "the venue still owes them an answer" on every turn the card
 * stayed pending. The 2026-09-18 incident's inbound ("oh and i got the pink
 * panther yesterday") was exactly this: a self-reported order, not a
 * question, that the block told the model was an outstanding question. Never
 * throws.
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
    if (!looksLikeQuestion(data.body)) return null
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
