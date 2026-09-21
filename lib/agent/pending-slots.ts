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

import { capturePendingSlotInvariantBroken } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { OBLIGATION_TYPES } from '@/lib/guests/commitment-expiry'
import { commitmentDedupKey } from '@/lib/guests/commitments'
import {
  type CommitmentEmission,
  type PendingCommitment,
  isEmptyCommitmentEmission,
  pendingFromEmission,
} from '@/lib/schemas/guest-commitment'

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
 * THE PRECEDENCE IS THE RULING (2026-09-21, ruling 3): an actionable emission
 * from generation ALWAYS wins, and `promised` is used only where generation
 * emitted nothing actionable. The check never mints a second commitment
 * alongside one the model already made.
 *
 * Two cases sit behind that one line, and they are not the same:
 *
 *   - The emission is an OBLIGATION (comp/hold/discount). The check never ran
 *     at all — verifyProsePromiseStage skips on isCommitmentTypeGated — so
 *     `promised` is null here by construction and the `??` is belt-and-braces
 *     rather than the thing doing the work.
 *   - The emission is a RECOMMENDATION. The check DID run, because a
 *     recommendation is not an obligation and the same reply can still promise
 *     a comp in prose, which is exactly this ticket's failure. The trigger
 *     fires and the draft queues, but the carrier stays the recommendation the
 *     model emitted. Overwriting it would silently convert one promise into a
 *     different one on a card an operator is about to approve.
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
  return pendingFromEmission(emission) ?? promised
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
  return draftCommitmentIdentity(emission, false) ?? commitmentIdentityOf(promised)
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
}

export interface PendingRowsBySlot {
  obligation: PendingSlotRow | null
  conversation: PendingSlotRow | null
}

export const EMPTY_PENDING_ROWS: PendingRowsBySlot = Object.freeze({
  obligation: null,
  conversation: null,
})

export const PENDING_SLOT_ROW_COLUMNS =
  'id, body, pending_until, review_reason, pending_commitment, created_at'

// Two slots, plus one row to notice a broken invariant. With migration 041 live
// a guest has at most two pending rows, so a third means the indexes are gone.
const PENDING_ROWS_READ_LIMIT = 3

/**
 * Sort a guest's pending rows, OLDEST FIRST, into their slots. Pure.
 *
 * When a slot holds more than one row, which migration 041 makes impossible,
 * the OLDEST is kept: it is the card an operator has been looking at longest,
 * and keeping it matches the queue's own FIFO order. The rest come back in
 * `extra` so the caller can report them rather than silently pick one.
 */
export function partitionPendingRows(rows: readonly PendingSlotRow[]): {
  rows: PendingRowsBySlot
  extra: PendingSlotRow[]
} {
  const bySlot: PendingRowsBySlot = { obligation: null, conversation: null }
  const extra: PendingSlotRow[] = []
  for (const row of rows) {
    const slot = pendingSlotOf(row.pending_commitment)
    if (bySlot[slot] === null) bySlot[slot] = row
    else extra.push(row)
  }
  return { rows: bySlot, extra }
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
      .order('created_at', { ascending: true })
      .limit(PENDING_ROWS_READ_LIMIT)
    if (result.error) {
      console.warn(
        `[agent] loadPendingRowsBySlot degraded for venue=${venueId} guest=${guestId}: ${result.error.message}`,
      )
      return null
    }
    data = (result.data ?? []) as PendingSlotRow[]
  } catch (e) {
    console.warn(
      `[agent] loadPendingRowsBySlot threw for venue=${venueId} guest=${guestId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }

  const { rows, extra } = partitionPendingRows(data)
  if (extra.length > 0) {
    // Unreachable while migration 041 is live. Kept loud rather than silent,
    // and Slack-relayed, because this is the one signal that the indexes are gone.
    console.error('[agent] pending-slot invariant broken: more than one pending row in a slot', {
      venueId,
      guestId,
      keptObligationId: rows.obligation?.id ?? null,
      keptConversationId: rows.conversation?.id ?? null,
      extraIds: extra.map((r) => r.id),
    })
    try {
      await capturePendingSlotInvariantBroken({
        venueId,
        guestId,
        keptObligationId: rows.obligation?.id ?? null,
        keptConversationId: rows.conversation?.id ?? null,
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

export type SlotDropReason =
  | 'obligation_slot_taken'
  | 'knowledge_gap_card_protected'
  | 'slot_occupied'

export type SlotDecision =
  | { action: 'insert'; slot: PendingSlot }
  | { action: 'regen'; slot: PendingSlot; draftId: string }
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
 *   6. regen: TAC-308 protects a knowledge-gap card from a turn that is not
 *      itself a gap turn, unless only the grounding check truncated (a draft
 *      nobody could read the verdict for is handed to an operator, never
 *      destroyed; see TAC-367 in stages.ts). Anything else regenerates in place.
 */
export function decideSlotAction(input: SlotDecisionInput): SlotDecision {
  const slot = pendingSlotOf(input.draftCommitment)
  const occupant = input.rows[slot]
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

  switch (input.callerPolicy) {
    case 'never_regen':
      return drop('slot_occupied')
    case 'regen_always':
      return { action: 'regen', slot, draftId: occupant.id }
    case 'regen_gap_card_only':
      return isKnowledgeGapCard(occupant)
        ? { action: 'regen', slot, draftId: occupant.id }
        : drop('slot_occupied')
    case 'regen':
      if (isKnowledgeGapCard(occupant) && !input.isGapTurn && !input.checkDidNotComplete) {
        return drop('knowledge_gap_card_protected')
      }
      return { action: 'regen', slot, draftId: occupant.id }
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
    (rows.conversation !== null && isKnowledgeGapCard(rows.conversation))
  )
}

/** The card in the slot a draft does NOT land in. For analytics only. */
export function otherSlotOccupant(
  rows: PendingRowsBySlot,
  draftCommitment: CommitmentIdentity | null,
): PendingSlotRow | null {
  return rows[otherSlot(pendingSlotOf(draftCommitment))]
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
    checkDidNotComplete:
      set.includes('grounding_check_failed') || set.includes('prose_promise_check_failed'),
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
