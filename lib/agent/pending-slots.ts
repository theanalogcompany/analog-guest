// TAC-394, option F: two pending slots per (venue, guest).
//
// Migration 041 replaced migration 020's one-pending-draft-per-guest index with
// two partial unique indexes. A guest now holds at most one OBLIGATION card (the
// draft's structured commitment carrier is a comp, hold or discount) and one
// CONVERSATION card (everything else, including a blank knowledge-gap card,
// whose carrier TAC-309 nulls). This module is the one place that knows it:
//
//   pendingSlotOf           the slot condition, mirroring migration 041's SQL
//   isSameCommitment        TAC-318's "same promise", scoped by type
//   loadPendingRowsBySlot   the ONE per-guest pending read, ordered, both slots
//   decideSlotAction        what a queued draft does to the card in its slot,
//                           shared by the approval gate and 23505 recovery
//   isKnowledgeGapCard      moved here from stages.ts, which re-exports it
//
// Why a separate module rather than more of stages.ts: the persist layer has to
// make the gate's decision again when a unique violation hands it a card the
// gate never saw, and schedule-and-send.ts cannot import stages.ts, which pulls
// lib/ai and lib/rag in at module load. So this stays dependency-light.
//
// The rule, as ruled on TAC-394 on 2026-09-14:
//
//   the new draft                                         what happens
//   ----------------------------------------------------  ------------------------------------
//   carries an obligation, obligation slot empty          new obligation card
//   carries the SAME commitment as the obligation card    regenerates that card in place
//   carries a DIFFERENT commitment, body blanked          conversation slot (carrier is nulled)
//   carries a DIFFERENT commitment, body kept             dropped with an alert; card untouched
//   no obligation, nothing holds it                       sends (decided by the gate)
//   no obligation, something holds it                     conversation slot: regen or insert
//
// Inside either slot, TAC-264's regenerate-in-place and TAC-308's knowledge-gap
// card protection apply unchanged.

import type { MessageCategory } from '@/lib/ai/types'
import { capturePendingSlotInvariantBroken } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { isObligationType, OBLIGATION_TYPES } from '@/lib/guests/commitment-expiry'
import { commitmentDedupKey } from '@/lib/guests/commitments'
import {
  type CommitmentEmission,
  type CommitmentType,
  type PendingCommitment,
  isEmptyCommitmentEmission,
  pendingFromEmission,
} from '@/lib/schemas/guest-commitment'
import { looksLikeQuestion } from './looks-like-question'

// ===== The slot =====

export type PendingSlot = 'obligation' | 'conversation'

/**
 * The carrier types that put a card in the obligation slot, sorted.
 *
 * Derived from OBLIGATION_TYPES (TAC-341's allowlist) rather than restated, so
 * the slot rule and the commitment lifecycle can never disagree about what an
 * obligation is. Migration 041's two index predicates list the same strings as
 * SQL literals, and pending-slots.test.ts reads that file and fails if they
 * differ. The SQL cannot import this constant, so that test is the only thing
 * keeping the two in step. A new obligation type therefore needs a new
 * migration, and the failing test is what says so.
 */
export const OBLIGATION_SLOT_TYPES: readonly string[] = [...OBLIGATION_TYPES].sort()

/**
 * Which slot a pending row's carrier puts it in. Mirrors migration 041:
 *
 *   coalesce(pending_commitment->>'type', '') in ('comp', 'hold', 'discount')
 *
 * Reads the RAW `type` string, not a schema-parsed carrier, because the index
 * does. A carrier whose other fields are malformed still lands in the slot its
 * type names in Postgres; parsing strictly here would put that row in the
 * conversation slot while the index put it in the obligation slot, and the two
 * layers would disagree about which card a draft competes with.
 *
 * Anything that is not an object with a string `type` (null, an array, a
 * scalar) is the conversation slot, which is also what `->>` yields NULL for.
 */
export function pendingSlotOf(pendingCommitment: unknown): PendingSlot {
  if (
    pendingCommitment === null ||
    typeof pendingCommitment !== 'object' ||
    Array.isArray(pendingCommitment)
  ) {
    return 'conversation'
  }
  const type = (pendingCommitment as Record<string, unknown>).type
  return typeof type === 'string' && OBLIGATION_SLOT_TYPES.includes(type)
    ? 'obligation'
    : 'conversation'
}

function otherSlot(slot: PendingSlot): PendingSlot {
  return slot === 'obligation' ? 'conversation' : 'obligation'
}

// ===== The commitment =====

/** What identifies a commitment for the slot rule, plus its code for alerts. */
export interface CommitmentIdentity {
  type: string
  description: string
  code: string | null
}

/**
 * Read a STORED carrier (`messages.pending_commitment`) leniently.
 *
 * Null unless `type` is a string and `description` is a non-blank string. An
 * obligation card whose carrier can't be read therefore has no identity,
 * compares unequal to every draft, and keeps its slot. That is the safe
 * direction: the alternative is regenerating over a comp nobody can read.
 */
export function commitmentIdentityOf(raw: unknown): CommitmentIdentity | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.type !== 'string') return null
  if (typeof r.description !== 'string' || r.description.trim().length === 0) return null
  return {
    type: r.type,
    description: r.description,
    code: typeof r.code === 'string' ? r.code : null,
  }
}

/**
 * The carrier a queued draft WILL persist, reduced to its identity.
 *
 * Must agree with what schedule-and-send.ts writes: `pendingFromEmission(...)`,
 * nulled when the body is blanked (TAC-309). Deliberately NOT
 * `pendingFromEmission` itself, which mints a fresh verification code on every
 * call: the slot decision needs only the type and the description, and a code
 * minted here would never match the one written. `code` is the model's own
 * emitted code or null, for the drop alert only.
 *
 * `bodyBlanked` is the one way a draft gives up its obligation (ruled
 * 2026-09-14). A blank card carries no commitment, so it lands in the
 * conversation slot. A draft that keeps its body still states its promise in
 * prose, and moving it out of the obligation slot would strip the record while
 * leaving the promise on the card: approving it would send a comp with no
 * guest_commitments row, no code and no expiry, the untracked promise TAC-401
 * is about. So a kept body keeps its slot, and a different commitment there is
 * dropped.
 */
export function draftCommitmentIdentity(
  emission: CommitmentEmission,
  bodyBlanked: boolean,
): CommitmentIdentity | null {
  if (bodyBlanked || isEmptyCommitmentEmission(emission)) return null
  // isEmptyCommitmentEmission guarantees both are defined.
  return {
    type: emission.type as string,
    description: (emission.description as string).trim(),
    code: emission.code?.trim() || null,
  }
}

/**
 * TAC-401: the carrier a queued draft persists, once the prose-promise check
 * can supply one the model never emitted.
 *
 * THE PRECEDENCE IS THE RULING, as narrowed on 2026-09-21: an OBLIGATION the
 * check finds replaces a recommendation carried by generation, and the check
 * never mints a second obligation when generation already carried one.
 *
 * The narrowing is the TAC-380 distinction. A recommendation is an INTENTION,
 * not an obligation: it costs the venue nothing, never gates, and carries no
 * verification code. So it must never be the reason a comp the venue now owes
 * goes untracked. An earlier version of this function kept the recommendation
 * in that case, which caught the promise and then recorded the wrong thing —
 * the operator approved a card for a comp and a `guest_commitments` row was
 * created for a drink suggestion.
 *
 * Three cases, and they are not the same:
 *
 *   - The emission is an OBLIGATION (comp/hold/discount). It wins, and the
 *     check never ran at all — verifyProsePromiseStage skips on
 *     isCommitmentTypeGated — so `promised` is null here by construction. This
 *     is "never mints a second obligation", and it is the half of the original
 *     ruling that did not move: the model's own structured comp is a better
 *     record of what it promised than a second reading of its prose.
 *   - The emission is a RECOMMENDATION and the check named an obligation. The
 *     obligation REPLACES it. The draft therefore moves to the obligation slot,
 *     which is correct: it is one.
 *   - The emission is a RECOMMENDATION and the check named nothing usable. The
 *     recommendation stays — there is nothing to replace it with, and dropping
 *     it would lose a record for no gain.
 *
 * `bodyBlanked` nulls everything, for TAC-309's reason unchanged: a blank
 * knowledge-gap card carries no commitment, and a promise the operator cannot
 * see is one they must not be able to bind by approving.
 *
 * Paired with resolveDraftCarrierIdentity below. The two must apply the same
 * precedence, and a test pins that they do rather than leaving it to whoever
 * edits one of them next.
 */
export function resolveDraftCarrier(
  emission: CommitmentEmission,
  promised: PendingCommitment | null,
  bodyBlanked: boolean,
): PendingCommitment | null {
  if (bodyBlanked) return null
  const own = pendingFromEmission(emission)
  if (own !== null && isObligationType(own.type)) return own
  return promised ?? own
}

/**
 * TAC-401: the same resolution reduced to its slot identity, with NO
 * verification code minted.
 *
 * Separate from resolveDraftCarrier above for the reason draftCommitmentIdentity
 * is separate from pendingFromEmission: that function mints a fresh code on
 * every call, and the gate needs an identity, not a carrier. A minted code
 * here would be a value that never reaches the database, and it would reach
 * the drop alert — which someone may be reading mid-incident — as if it were
 * a code the guest had been given.
 *
 * `promised` already carries its minted code, because verifyProsePromiseStage
 * mints it once. So the identity of a promised carrier is read off it rather
 * than regenerated.
 */
export function resolveDraftCarrierIdentity(
  emission: CommitmentEmission,
  promised: PendingCommitment | null,
  bodyBlanked: boolean,
): CommitmentIdentity | null {
  if (bodyBlanked) return null
  const own = draftCommitmentIdentity(emission, false)
  if (own !== null && isObligationType(own.type as CommitmentType)) return own
  return commitmentIdentityOf(promised) ?? own
}

/**
 * "The same commitment" (ruled 2026-09-14, correcting an earlier reading of
 * "the same type"): the same TYPE and the same TAC-318 dedup key
 * (`commitmentDedupKey`: trimmed and lower-cased).
 *
 * A comp for a different item is a different obligation. A hold for the same
 * item as a pending comp is a different obligation too, because TAC-318 rules
 * that one gated type never displaces another.
 *
 * Accepted consequence: rewording beyond case and whitespace counts as
 * different, so a comp re-emitted in new words is dropped with an alert and the
 * existing card stays. That is the safe direction. The drop event carries both
 * descriptions, so rewordings can be counted apart from genuinely different
 * obligations.
 */
export function isSameCommitment(
  a: Pick<CommitmentIdentity, 'type' | 'description'> | null,
  b: Pick<CommitmentIdentity, 'type' | 'description'> | null,
): boolean {
  if (a === null || b === null) return false
  return (
    a.type === b.type && commitmentDedupKey(a.description) === commitmentDedupKey(b.description)
  )
}

// ===== The read =====

export interface PendingSlotRow {
  id: string
  body: string
  pending_until: string | null
  review_reason: string | null
  pending_commitment: unknown
  created_at: string
  /**
   * TAC-397: the inbound this card answers. Migration 054 keys the
   * conversation index on it, so 23505 race recovery reads it to tell "the
   * same message arrived twice" from "a different message won the slot" —
   * two situations that need opposite handling and are indistinguishable
   * without it.
   */
  reply_to_message_id: string | null
}

export interface PendingRowsBySlot {
  obligation: PendingSlotRow | null
  /**
   * TAC-397: every pending conversation card, OLDEST FIRST.
   *
   * Was a single row until migration 054. A guest now holds one conversation
   * card per unanswered inbound, because a second question gets its own card
   * rather than regenerating the first one over the top of the earlier one.
   *
   * Oldest first so `at(-1)` is the most recently opened card, which is the
   * only one a correction may ever be matched against (ruled 2026-09-22,
   * question 2). Read it through mostRecentlyOpenedConversationCard rather
   * than indexing here, so that ruling has one implementation.
   */
  conversation: PendingSlotRow[]
}

export const EMPTY_PENDING_ROWS: PendingRowsBySlot = Object.freeze({
  obligation: null,
  // Frozen too: this is a shared singleton, and an unfrozen array on it could
  // be pushed into by one caller and read by the next.
  conversation: Object.freeze([]) as unknown as PendingSlotRow[],
})

export const PENDING_SLOT_ROW_COLUMNS =
  'id, body, pending_until, review_reason, pending_commitment, created_at, reply_to_message_id'

/**
 * TAC-397: was 3 (two slots plus one row to notice a broken invariant), which
 * was right while migration 041 capped a guest at two pending rows. Migration
 * 054 caps the conversation slot per INBOUND instead, so the count is bounded
 * by how many unanswered questions a guest has in flight, not by 2.
 *
 * 25 is generous rather than derived. A guest holding 25 unanswered cards is
 * already a queue-management failure, and hitting the limit is REPORTED (see
 * loadPendingRowsBySlot) rather than silently truncated.
 */
export const PENDING_ROWS_READ_LIMIT = 25

/**
 * Sort a guest's pending rows, OLDEST FIRST, into their slots. Pure.
 *
 * The two slots are treated DIFFERENTLY as of TAC-397, and the asymmetry is
 * the point:
 *
 *   obligation   — still at most one. More than one is an invariant break
 *                  (migration 041's obligation index is untouched), so the
 *                  OLDEST is kept — the card an operator has been looking at
 *                  longest, matching the queue's FIFO order — and the rest
 *                  come back in `extra` for the caller to report rather than
 *                  silently discard.
 *   conversation — many is NORMAL now. Every row is kept, in order. Nothing
 *                  about a second conversation card is an invariant break,
 *                  and reporting one as such would have made migration 054's
 *                  whole purpose look like a fault.
 */
export function partitionPendingRows(rows: readonly PendingSlotRow[]): {
  rows: PendingRowsBySlot
  extra: PendingSlotRow[]
} {
  const bySlot: PendingRowsBySlot = { obligation: null, conversation: [] }
  const extra: PendingSlotRow[] = []
  for (const row of rows) {
    if (pendingSlotOf(row.pending_commitment) === 'conversation') {
      bySlot.conversation.push(row)
      continue
    }
    if (bySlot.obligation === null) bySlot.obligation = row
    else extra.push(row)
  }
  return { rows: bySlot, extra }
}

/**
 * The card a correction may be matched against, or null when the guest holds
 * none. THE single implementation of the 2026-09-22 ruling (question 2): only
 * ever the most recently opened conversation card, never an older one.
 *
 * Also what the three non-`regen` caller policies read as "the occupant", so
 * the decline, the crash card and a manual followup keep treating the slot as
 * single-occupant exactly as they did before TAC-397.
 */
export function mostRecentlyOpenedConversationCard(
  rows: PendingRowsBySlot,
): PendingSlotRow | null {
  return rows.conversation.at(-1) ?? null
}

/**
 * THE per-guest pending read. Every caller that needs "this guest's pending
 * card" goes through here and then names the slot it wants. pending-slots.test.ts
 * carries a source guard that fails if another single-row pending read for a
 * guest appears anywhere in the repo.
 *
 * It replaced `findPendingDraft` (stages.ts) and `findOpenPendingRow`
 * (schedule-and-send.ts). Both were `.limit(1).maybeSingle()` with no ordering,
 * which returns an ARBITRARY row: harmless while migration 020 allowed one
 * pending row per guest, wrong the moment there can be two, because a caller
 * after the conversation card could be handed the comp card and regenerate over
 * it. Ordering by created_at and returning both slots makes the choice explicit.
 *
 * Fails OPEN, as findPendingDraft did: a failed read returns null, the gate
 * proceeds as if no card exists, and migration 041's indexes are the backstop
 * (a colliding INSERT gets 23505, and recovery reads again).
 */
export async function loadPendingRowsBySlot(
  venueId: string,
  guestId: string,
): Promise<PendingRowsBySlot | null> {
  let data: PendingSlotRow[]
  try {
    const supabase = createAdminClient()
    const result = await supabase
      .from('messages')
      .select(PENDING_SLOT_ROW_COLUMNS)
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .eq('direction', 'outbound')
      .eq('review_state', 'pending')
      // TAC-397: DESCENDING, then reversed below. This is the TAC-316
      // DESC-window pattern and the ordering is load-bearing, not a
      // preference.
      //
      // With `ascending: true` a guest over the limit loses their NEWEST
      // cards — which is precisely the one a correction must be matched
      // against (mostRecentlyOpenedConversationCard), and precisely the one
      // the gate needs to decide whether this turn regenerates or inserts.
      // TAC-316 shipped exactly that bug in the Command Center's own
      // conversation query: `ASC LIMIT 200` kept the OLDEST 200 rows and hid
      // everything newer the night Mock Sextant crossed the cap.
      .order('created_at', { ascending: false })
      .limit(PENDING_ROWS_READ_LIMIT)
    if (result.error) {
      console.warn(
        `[agent] loadPendingRowsBySlot degraded for venue=${venueId} guest=${guestId}: ${result.error.message}`,
      )
      return null
    }
    // Newest-first off the wire, oldest-first for every consumer.
    data = ((result.data ?? []) as PendingSlotRow[]).slice().reverse()
  } catch (e) {
    console.warn(
      `[agent] loadPendingRowsBySlot threw for venue=${venueId} guest=${guestId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }

  // TAC-397: hitting the read limit means rows were dropped, and the ones
  // dropped are the guest's OLDEST cards (see the DESC ordering above). That
  // is the right end to lose, but it is still a truncation, and an obligation
  // card older than 25 conversation cards would fall outside the window and
  // read as an empty obligation slot. Loud rather than silent; the same
  // channel as the invariant break below, because the consequence is the
  // same — the gate is deciding against an incomplete picture.
  if (data.length >= PENDING_ROWS_READ_LIMIT) {
    console.error('[agent] pending-slot read hit its limit; older cards were not read', {
      venueId,
      guestId,
      limit: PENDING_ROWS_READ_LIMIT,
    })
  }

  const { rows, extra } = partitionPendingRows(data)
  if (extra.length > 0) {
    // TAC-397: OBLIGATION slot only. A second conversation card is normal
    // since migration 054 and is not reported here. Unreachable while
    // migration 041's obligation index is live. Kept loud rather than silent,
    // and Slack-relayed, because this is the one signal that index is gone.
    console.error(
      '[agent] pending-slot invariant broken: more than one pending row in the obligation slot',
      {
        venueId,
        guestId,
        keptObligationId: rows.obligation?.id ?? null,
        keptConversationId: mostRecentlyOpenedConversationCard(rows)?.id ?? null,
        extraIds: extra.map((r) => r.id),
      },
    )
    try {
      await capturePendingSlotInvariantBroken({
        venueId,
        guestId,
        keptObligationId: rows.obligation?.id ?? null,
        keptConversationId: mostRecentlyOpenedConversationCard(rows)?.id ?? null,
        extraIds: extra.map((r) => r.id),
      })
    } catch {
      // Observability must not cost the read its result.
    }
  }
  return rows
}

// ===== The decision =====

/**
 * How a caller treats an occupied slot.
 *
 *   regen                the approval gate's callers (inbound, followup):
 *                        TAC-264 regenerates in place, TAC-308 protects a
 *                        knowledge-gap card
 *   regen_always         the operator decline (TAC-299): the operator's
 *                        "we can't fulfill" supersedes the pending reply
 *   regen_gap_card_only  the generation-failure card (TAC-309): updates a
 *                        knowledge-gap card, never overwrites anything else
 *   never_regen          manual followups (TAC-307): a Follow Up click never
 *                        overwrites a card an operator is about to act on
 */
export type SlotCallerPolicy = 'regen' | 'regen_always' | 'regen_gap_card_only' | 'never_regen'

/**
 * TAC-397: what a guest's new message does to the conversation card they
 * already have waiting. The three cases from the ticket's own spec.
 *
 *   own_card    it needs its own answer. A new card; the pending one is
 *               untouched. Also the answer whenever nothing is pending.
 *   no_answer   it needs no answer at all ("haha", "thanks"). Nothing is
 *               generated into a row and nothing is regenerated.
 *   correction  it amends the question the pending card is answering. That
 *               card is regenerated in place and keeps the text it replaced.
 */
export type ConversationDisposition = 'own_card' | 'no_answer' | 'correction'

/**
 * Categories whose own classifier definitions already mean "no question or
 * request in this message":
 *
 *   acknowledgment  "acknowledging, signing off, or otherwise closing a
 *                   thread without a question or request"
 *   casual_chatter  "small talk or an unprompted casual comment without
 *                   asking a question"
 *
 * Narrower than the ticket's "acknowledgement, reaction, chatter" on purpose.
 * A reaction with no text never reaches the agent at all, and every other
 * category can carry something worth answering.
 */
const NO_ANSWER_CATEGORIES: ReadonlySet<string> = new Set<MessageCategory>([
  'acknowledgment',
  'casual_chatter',
])

export interface ConversationDispositionInput {
  /** Whether the guest already holds at least one pending conversation card. */
  hasConversationOccupant: boolean
  /** This turn's classified category; null on a run with no inbound. */
  category: MessageCategory | null
  /** The classifier's judgement (TAC-397). False on a run with no inbound. */
  correctsPendingReply: boolean
  /** The guest's message; null on a followup, the decline, the crash card. */
  inboundBody: string | null
}

/**
 * Which of the three cases this turn is. Pure.
 *
 * Order matters and each step is a decision:
 *
 * 1. NOTHING PENDING -> own_card. This is the safety bound on the whole
 *    mechanism: `no_answer` is UNREACHABLE unless a card is already waiting,
 *    so a misjudged silence can never be the reason a guest gets nothing at
 *    all — only the reason they get nothing EXTRA while an operator already
 *    holds a card for them. Before TAC-397 that same message overwrote the
 *    card, so even a wrong silence is strictly better than the old behaviour.
 *
 * 2. correctsPendingReply -> correction, checked BEFORE the chatter test. A
 *    correction phrased casually ("oh wait, oat milk actually") still
 *    corrects, and reading it as chatter would silence the one message that
 *    must not be silenced.
 *
 * 3. A no-question category AND a body that does not read as a question ->
 *    no_answer.
 *
 *    The AND is doing the safety work here, not looksLikeQuestion. That
 *    function is deliberately precision-biased (TAC-484) — its own test pins
 *    `looksLikeQuestion('tell me the wifi password') === false` — and TAC-484
 *    uses it where a false return costs a nudge. Here a false return argues
 *    for SILENCE, the opposite direction, so it is never trusted alone: an
 *    imperative request would also have to classify as acknowledgment or
 *    casual_chatter before anything is silenced.
 *
 * 4. Anything else -> own_card. The ticket's "when unsure, choose case 1":
 *    a separate card never loses content, a wrong regen can lose a question.
 */
export function resolveConversationDisposition(
  input: ConversationDispositionInput,
): ConversationDisposition {
  if (!input.hasConversationOccupant) return 'own_card'
  if (input.correctsPendingReply) return 'correction'
  if (
    input.category !== null &&
    NO_ANSWER_CATEGORIES.has(input.category) &&
    !looksLikeQuestion(input.inboundBody ?? '')
  ) {
    return 'no_answer'
  }
  return 'own_card'
}

/**
 * TAC-397: does this turn produce NO write at all?
 *
 * Shared by the approval gate and decideSlotAction, and it has to be, because
 * the two ask it at different moments. The gate must ask BEFORE its
 * `triggers.length === 0 -> send` return: a clean reply to "haha" fires no
 * trigger, so by the time decideSlotAction runs the gate has already sent it.
 * decideSlotAction asks again for the queue path and for 23505 recovery.
 *
 * Two conditions beyond the disposition itself, and both matter:
 *
 *   slot === 'conversation'  a draft carrying a comp, hold or discount goes to
 *                            the obligation slot and is never silenced by a
 *                            judgement about conversational chatter. If the
 *                            model answered "haha" with a comp, that is a
 *                            comp and an operator sees it.
 *   callerPolicy === 'regen' only a guest's own inbound can be judged. A
 *                            followup, the decline and the crash card have no
 *                            message to read.
 */
export function silencesConversationTurn(input: {
  slot: PendingSlot
  callerPolicy: SlotCallerPolicy
  disposition: ConversationDisposition | null
  hasOccupant: boolean
}): boolean {
  return (
    input.slot === 'conversation' &&
    input.callerPolicy === 'regen' &&
    input.hasOccupant &&
    (input.disposition ?? 'own_card') === 'no_answer'
  )
}

export type SlotDropReason =
  | 'obligation_slot_taken'
  | 'knowledge_gap_card_protected'
  | 'slot_occupied'

export type SlotDecision =
  | { action: 'insert'; slot: PendingSlot }
  | {
      action: 'regen'
      slot: PendingSlot
      draftId: string
      /**
       * TAC-397: capture the body this card held before the UPDATE, so the
       * operator can compare. True ONLY on a correction — every other regen
       * (the decline, the crash card, a gap card refreshed by a second
       * unanswerable question) clears the columns instead, so a card since
       * overwritten for an unrelated reason never keeps a stale correction's
       * text.
       */
      captureReplacedDraft: boolean
    }
  // TAC-397: the guest's message needs no answer and a card is already
  // waiting. Nothing is written and nothing is regenerated. DISTINCT from
  // `drop`, which means a draft competed for a slot and lost — here nothing
  // competed, and there was never a reply worth keeping.
  | { action: 'silence'; slot: 'conversation' }
  | { action: 'drop'; slot: PendingSlot; reason: SlotDropReason; protectedDraftId: string }

export interface SlotDecisionInput {
  rows: PendingRowsBySlot
  /** The carrier the draft will persist: `draftCommitmentIdentity(...)`. */
  draftCommitment: CommitmentIdentity | null
  /** A knowledge-gap turn: the self-reported or backstop trigger fired. */
  isGapTurn: boolean
  /** The grounding check truncated (TAC-367). Exempt from gap-card protection. */
  checkDidNotComplete: boolean
  callerPolicy: SlotCallerPolicy
  /**
   * TAC-397: what this turn does to the conversation card, from
   * resolveConversationDisposition. Read ONLY by the `regen` policy.
   *
   * Required but nullable, so every call site states a value rather than
   * inheriting one by omission. `null` means "no guest inbound to judge" —
   * an engine followup, the decline, the crash card, the Instagram
   * send-failed card.
   *
   * A `null` disposition keeps the PRE-TAC-397 behaviour for the conversation
   * slot: regenerate in place. It must not become `own_card`, because every
   * proactive run shares migration 054's sentinel key and so cannot hold a
   * second card — see the branch in decideSlotAction for what that costs.
   */
  conversationDisposition: ConversationDisposition | null
}

/**
 * What a draft that WILL queue does to the card in its slot. Pure.
 *
 * SHARED on purpose: the approval gate calls it for the card it read, and
 * `persistOrRegenQueuedDraft` calls it again for the card a unique violation
 * revealed, which the gate never saw. Deciding that second case differently is
 * how an overwrite gets back in through the race path (TAC-394 AC4).
 *
 * Send-versus-queue is decided before this runs, in the gate, because TAC-308's
 * carve-out and previous_pending_held depend on the trigger set. This decides
 * only where a queued draft goes. In order:
 *
 *   1. The slot is empty: insert.
 *   2. The obligation slot holds a DIFFERENT commitment: drop, and the existing
 *      card wins. This applies to EVERY caller policy, the operator decline
 *      included: no path may overwrite one obligation with another.
 *   3. never_regen: refuse.
 *   4. regen_always: regenerate.
 *   5. regen_gap_card_only: regenerate a knowledge-gap card, refuse anything
 *      else.
 *   6. regen: the conversation slot consults the DISPOSITION (TAC-397); the
 *      obligation slot keeps TAC-308's knowledge-gap protection, which
 *      protects a gap card from a turn that is not itself a gap turn unless
 *      only a check failed to complete (a draft nobody could read the verdict
 *      for is handed to an operator, never destroyed; see TAC-367 in
 *      stages.ts).
 */
export function decideSlotAction(input: SlotDecisionInput): SlotDecision {
  const slot = pendingSlotOf(input.draftCommitment)
  const occupant =
    slot === 'obligation' ? input.rows.obligation : mostRecentlyOpenedConversationCard(input.rows)

  // TAC-397: on the conversation slot the `regen` policy decides from the
  // DISPOSITION first, because "this message deserves its own card" is true
  // whether or not a card is already there. An occupant is no longer, on its
  // own, a reason to do anything to it.
  //
  // This is also where TAC-308's protected-card DROP disappears for this
  // path, per the 2026-09-22 ruling (question 3): that drop existed only to
  // stop an unrelated turn overwriting a knowledge-gap card, and an unrelated
  // turn now inserts its own card instead. Nothing is overwritten, so nothing
  // needs protecting. A CORRECTION reaching a gap card is not unrelated by
  // definition — it amends the very question the card is stuck on — so it is
  // allowed to regenerate it.
  //
  // `conversationDisposition !== null` is what scopes this to a run that HAS a
  // guest message, and it is load-bearing rather than defensive. Migration
  // 054's index folds a NULL `reply_to_message_id` onto one sentinel, so every
  // proactive run (an engine followup, the decline, the crash card) shares a
  // single conversation key and CANNOT have a card of its own. Returning
  // `insert` for one produces a 23505 that recovery cannot converge on — it
  // has no inbound to match, decides `insert` again, exhausts
  // RACE_RECOVERY_MAX_ATTEMPTS and throws. For an engine followup that is a
  // red alert every tick AND a permanently burned dedup claim, because
  // `followups/engine.ts` keeps the claim on a persist-stage failure.
  //
  // So a proactive run falls through to the switch below and keeps its
  // pre-TAC-397 behaviour exactly. That is also the honest reading of the
  // ticket: its three cases are about a guest's second MESSAGE, and a run with
  // no message is not one of them.
  if (
    slot === 'conversation' &&
    input.callerPolicy === 'regen' &&
    input.conversationDisposition !== null
  ) {
    const disposition = input.conversationDisposition
    if (
      silencesConversationTurn({
        slot,
        callerPolicy: input.callerPolicy,
        disposition,
        hasOccupant: occupant !== null,
      })
    ) {
      return { action: 'silence', slot: 'conversation' }
    }
    if (occupant !== null && disposition === 'correction') {
      return {
        action: 'regen',
        slot: 'conversation',
        draftId: occupant.id,
        captureReplacedDraft: true,
      }
    }
    // own_card, or a disposition whose target vanished between the read that
    // produced it and this call. Either way: its own card. Falling through to
    // an insert on a vanished target is deliberate — a fresh read reflects
    // reality, and inserting is the harmless direction.
    return { action: 'insert', slot: 'conversation' }
  }

  if (occupant === null) return { action: 'insert', slot }

  const drop = (reason: SlotDropReason): SlotDecision => ({
    action: 'drop',
    slot,
    reason,
    protectedDraftId: occupant.id,
  })

  if (
    slot === 'obligation' &&
    !isSameCommitment(commitmentIdentityOf(occupant.pending_commitment), input.draftCommitment)
  ) {
    return drop('obligation_slot_taken')
  }

  // TAC-397: every regen below is a NON-correction, so none captures a
  // replaced draft. The obligation slot never does either — it is out of this
  // ticket's scope entirely.
  switch (input.callerPolicy) {
    case 'never_regen':
      return drop('slot_occupied')
    case 'regen_always':
      return { action: 'regen', slot, draftId: occupant.id, captureReplacedDraft: false }
    case 'regen_gap_card_only':
      return isKnowledgeGapCard(occupant)
        ? { action: 'regen', slot, draftId: occupant.id, captureReplacedDraft: false }
        : drop('slot_occupied')
    case 'regen':
      // Only reachable for the OBLIGATION slot: the conversation branch
      // returned above. TAC-308's protection and TAC-367's exemption unchanged.
      if (isKnowledgeGapCard(occupant) && !input.isGapTurn && !input.checkDidNotComplete) {
        return drop('knowledge_gap_card_protected')
      }
      return { action: 'regen', slot, draftId: occupant.id, captureReplacedDraft: false }
  }
}

/**
 * Whether EITHER slot holds a knowledge-gap card. The holding-message clock is
 * the guest's, not the slot's: the timeout scan fires once per card with no
 * per-guest dedupe, so a gap turn that armed a clock beside a gap card in the
 * other slot would send the guest a second holding message. Callers arm
 * `pending_until` only when this is false. A card whose clock already fired
 * still counts, as it did within one slot under migration 020. This holds only
 * for turns that read each other's cards: two gap turns seconds apart can both
 * find no gap card, land in different slots and each arm a clock (TAC-404).
 */
export function anyKnowledgeGapCard(rows: PendingRowsBySlot): boolean {
  return (
    (rows.obligation !== null && isKnowledgeGapCard(rows.obligation)) ||
    // TAC-397: EVERY conversation card, not just the newest. A guest can hold
    // several, and the clock is the guest's: one gap card anywhere is enough
    // to stop a second holding message.
    rows.conversation.some((row) => isKnowledgeGapCard(row))
  )
}

/**
 * The card occupying a named slot, or null. TAC-397: the conversation slot is
 * an array, so "the occupant" is the most recently opened card there — the
 * same one decideSlotAction and a correction both target. Used by the two drop
 * reports, which need the protected card's carrier.
 */
export function occupantOfSlot(rows: PendingRowsBySlot, slot: PendingSlot): PendingSlotRow | null {
  return slot === 'obligation' ? rows.obligation : mostRecentlyOpenedConversationCard(rows)
}

/**
 * Whether the slot a draft does NOT land in holds anything. For analytics only.
 *
 * TAC-397: returns a boolean rather than the row. Both call sites only ever
 * asked `!== null`, and the conversation slot no longer has "the" row.
 */
export function otherSlotOccupied(
  rows: PendingRowsBySlot,
  draftCommitment: CommitmentIdentity | null,
): boolean {
  const other = otherSlot(pendingSlotOf(draftCommitment))
  return other === 'obligation' ? rows.obligation !== null : rows.conversation.length > 0
}

/**
 * The two gap flags decideSlotAction needs, recovered from a draft's trigger
 * set. For the persist layer, which receives the trigger set
 * (`reviewTriggers`) but not the gate's intermediate booleans. Mirrors the
 * gate: a gap turn is the self-reported or the backstop knowledge-gap trigger,
 * and a truncated check is grounding_check_failed. Literals for the reason
 * given at KNOWLEDGE_GAP_CARD_REVIEW_REASONS below, and pinned against
 * APPROVAL_TRIGGERS in stages.test.ts. A caller with no trigger set (the
 * decline, the crash card) reads as neither, which is what their own policies
 * assume.
 */
export function gapFlagsFromTriggers(triggers: readonly string[] | undefined): {
  isGapTurn: boolean
  checkDidNotComplete: boolean
} {
  const set = triggers ?? []
  return {
    isGapTurn: set.includes('knowledge_gap') || set.includes('knowledge_gap_backstop'),
    // Both absence-of-information triggers, and they must stay in step with
    // the gate's own computation in stages.ts — this is what 23505 race
    // recovery decides with, so a divergence means the gate spares a draft and
    // recovery destroys it.
    //
    // TAC-424: `grounding_check_degraded` is listed too, as defence in depth
    // rather than because it is reachable alone. The gate always co-pushes
    // `grounding_check_failed` with it, so today the first clause already
    // covers every degraded turn — but the invariant making that safe lives in
    // another file, and "the marker is more specific, push only that" is a
    // plausible future tidy. If anyone made it, this function would stop
    // exempting the turn and recovery would DESTROY a draft the gate spared,
    // which is the exact divergence the comment above warns about.
    checkDidNotComplete:
      set.includes('grounding_check_failed') ||
      set.includes('grounding_check_degraded') ||
      set.includes('prose_promise_check_failed'),
  }
}

// ===== Knowledge-gap cards =====
//
// Moved here from lib/agent/stages.ts by TAC-394, which re-exports both names,
// so existing imports from './stages' keep working. They had to move because
// decideSlotAction needs the predicate and the persist layer cannot import
// stages.ts. The review_reason values are string literals here for the same
// reason: APPROVAL_TRIGGERS and GENERATION_FAILED_REVIEW_REASON live in
// stages.ts. stages.test.ts pins the literals against those constants, so the
// two cannot drift silently.

/**
 * Every `messages.review_reason` that marks a pending row as a knowledge-gap
 * card, i.e. one the guest is owed an answer to.
 *
 * SHARED with `findPendingQuestion` (lib/agent/pending-question.ts), which has
 * to express the same predicate as a PostgREST filter so it can run
 * server-side. That duplication used to be by hand and it DRIFTED: the query
 * carried one value where the predicate below carried two, so a
 * `knowledge_gap_backstop` card whose clock had already fired was recognized
 * here and invisible there — the `## Unanswered question` block silently
 * vanished for that guest while the card still sat in the operator's queue,
 * and the comment at the query claimed the two mirrored each other the whole
 * time. TAC-364 found it while adding a third value.
 *
 * Exported as one array so the next value added lands in both places at once
 * rather than being caught by a reader. Do not inline these back into either
 * site.
 */
export const KNOWLEDGE_GAP_CARD_REVIEW_REASONS = [
  'knowledge_gap',
  'knowledge_gap_backstop',
  'generation_failed',
] as const

/**
 * TAC-308: is this pending row a knowledge-gap card?
 *
 * Two conditions, OR'd, and the OR is load-bearing:
 *
 *   pending_until IS NOT NULL — the clock is still running. Catches the card
 *     even when a co-firing trigger (a comp commitment on the same turn) won
 *     `review_reason` and the label doesn't say "knowledge_gap".
 *   review_reason = 'knowledge_gap' — the clock has already fired. The timer
 *     CLEARS pending_until as its CAS claim, so after a holding message goes
 *     out the first condition stops matching. Without this second one the
 *     card would silently lose its eviction protection five minutes after
 *     being created, which is the original data-loss bug on a delay.
 *
 * Residual, accepted: a draft that BOTH gapped and committed a comp gets
 * review_reason='commitment_type_gated', so once its clock fires it is no
 * longer recognized. Rare (the model has to do both in one turn) and it
 * degrades to pre-TAC-308 behavior rather than to something worse. Closing it
 * needs a column, which the ticket ruled out.
 *
 * TAC-484 WIDENS that residual for a BACKSTOP-caught comp specifically. That
 * card can no longer arm a clock at all, so it is unrecognized from creation
 * rather than from the moment a clock fires. The consequences are the same two
 * as before, just reached earlier: findPendingQuestion's filter matches
 * neither leg, and anyKnowledgeGapCard reads false. Inert while the holding
 * message is disabled; it is written down because the window widened, not
 * because the behaviour changed.
 *
 * TAC-350: the review_reason leg checks BOTH `knowledge_gap` (self-reported)
 * and `knowledge_gap_backstop` (independently caught) — a card protected by
 * the backstop trigger must get identical eviction protection to one the
 * model flagged itself, or a regen of a backstop-caught card would silently
 * lose its clock the moment the label won by a co-firing trigger changed.
 *
 * TAC-364 adds `generation_failed` as a third value on that leg, and it is
 * REQUIRED rather than tidy. The crash card arms `pending_until` like any
 * other gap card, so it is protected while the clock runs — but the moment
 * the timer CAS-claims and nulls that column, a crash card without this leg
 * stops being recognized, and the next turn that queues for any reason
 * UPDATEs it in place instead of taking the `drop` branch: the guest's
 * outstanding question is overwritten and the crash is erased. Splitting the
 * crash path off `knowledge_gap` without adding it here would have introduced
 * exactly the data-loss bug the second leg exists to prevent.
 */
export function isKnowledgeGapCard(row: {
  review_reason?: string | null
  pending_until?: string | null
}): boolean {
  // Positive identification only. `typeof === 'string'` rather than
  // `!== null` because an ABSENT field (a caller that didn't select the
  // column, a hand-built row) is `undefined`, and `undefined !== null` is
  // true — which would classify every ordinary pending draft as a protected
  // knowledge-gap card and silently start dropping replies that used to
  // send. Unknown means "not a gap card": the fail-safe direction is the
  // pre-TAC-308 behavior, not the new one.
  return (
    typeof row.pending_until === 'string' ||
    (typeof row.review_reason === 'string' &&
      (KNOWLEDGE_GAP_CARD_REVIEW_REASONS as readonly string[]).includes(row.review_reason))
  )
}
