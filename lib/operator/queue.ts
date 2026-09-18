// Powers GET /api/operator/queue (TAC-258). Returns pending drafts FIFO-
// ordered across the operator's allowed venues, with the latest guest_state
// and last-3 conversation context joined in via the Postgres lateral RPC
// `list_operator_queue` (migration 018) — one round trip, not N+1.
//
// The RPC handles row-level scoping (venue_ids passed in); this helper
// projects the row shape into QueueDraft (camelCase, normalized
// recent_context jsonb → array, pending_since_ms computed from created_at)
// and surfaces it as RAGResult-shaped output for consistency with other
// fail-as-value helpers in the codebase.

import { createAdminClient } from '@/lib/db/admin'
import type { Json } from '@/db/types'
import type { ApprovalTrigger } from '@/lib/agent/stages'
import type { ThreadMessage } from '@/lib/schemas'
import { normalizeRecognitionState } from './recognition-state'
import type { GuestRecognitionState } from './recognition-state'

export type { GuestRecognitionState } from './recognition-state'

// Recent-context entry shape on the queue (last 3 messages joined by
// `list_operator_queue`). Aliased to the canonical `ThreadMessage` so the
// queue payload and the full-thread fetch (`/api/operator/messages/:id/thread`,
// TAC-277) share a single shape. Adding fields here means adding them in
// `lib/schemas/thread-message.ts` so both surfaces stay in lockstep.
export type QueueRecentContextEntry = ThreadMessage

export interface QueueDraft {
  messageId: string
  venueId: string
  venueSlug: string
  guestId: string
  guestDisplayName: string | null
  guestPhoneFallback: string
  draftBody: string
  category: string | null
  voiceFidelity: number | null
  reviewReason: string | null
  // TAC-364. The four fields below are Contract-locked and ALWAYS PRESENT —
  // an empty array or empty string where there is nothing, never undefined, so
  // the client never branches on presence.
  //
  // reviewReasonCode is the RAW trigger code. It exists because shipping only
  // the prose label is what made analog-operator's queue-tone.ts unreachable:
  // that module joined on three English strings this server has never emitted,
  // so every production card fell to the default and two of its three colours
  // were dead. Colour keys on the code; a copy edit below must not be able to
  // reclassify a card.
  reviewReasonCode: string
  // The full trigger set, PRIMARY INCLUDED, as RAW CODES. `[]` when the row
  // predates migration 039 or was written by a path that never ran the gate.
  //
  // Codes, not prose, for the same reason `reviewReasonCode` exists: a
  // secondary trigger that arrives as a sentence cannot drive an icon, a
  // grouping or a filter without the prose join that left queue-tone.ts
  // matching nothing on every production card. `reviewTriggerLabels` below
  // carries the display text.
  //
  // THE PRIMARY IS IN HERE TOO, deliberately, and the server does NOT dedupe
  // it. This field means "everything that fired", and a set that silently
  // omitted one member because it happened to win the priority sort would be a
  // worse thing to reason about than a duplicate. The client renders
  // secondaries as `reviewTriggers` minus `reviewReasonCode` — that subtraction
  // is well defined precisely because both sides are codes.
  reviewTriggers: string[]
  // Display text for `reviewTriggers`, PARALLEL: same length, same order, so
  // `reviewTriggerLabels[i]` is the label for `reviewTriggers[i]`. Normalized
  // through REVIEW_REASON_LABELS with the same 'Needs review' fallback
  // `reviewReason` uses, so an unrecognized code still renders something
  // rather than leaking a raw identifier to an operator.
  //
  // Two arrays rather than an array of pairs because the client indexes them
  // independently: the colour/grouping logic reads codes and never needs the
  // prose, and the card body reads prose and never needs the codes. The
  // index-alignment invariant is asserted in queue.test.ts.
  reviewTriggerLabels: string[]
  // Verbatim claims the grounding verifier flagged.
  //
  // `[]` here does NOT mean "no information" — see the migration and the
  // normalizer below. The COLUMN distinguishes "the check never ran" (NULL)
  // from "it ran and found nothing" (`[]`), because that is the question
  // TAC-367 existed because nobody could answer. The WIRE deliberately does
  // not: both collapse to `[]`, since neither produces a UI element and the
  // Contract's never-branch-on-presence guarantee is worth more to the client
  // than a distinction it would never act on. Ask the column, not the card.
  ungroundedClaims: string[]
  // TAC-394, Contract-locked (TAC-394's description, `## Contract`): how many
  // OTHER pending drafts this guest has at this venue. Always present, 0 when
  // none, never undefined. With migration 041 a guest holds at most one
  // obligation card and one conversation card, so the server produces 0 or 1;
  // the client must not rely on that bound.
  otherPendingDraftsForGuest: number
  recognitionState: GuestRecognitionState | null
  pendingSinceMs: number
  recentContext: QueueRecentContextEntry[]
  langfuseTraceId: string | null
}

export type ListPendingQueueResult =
  | { ok: true; drafts: QueueDraft[] }
  | { ok: false; error: string }

// TAC-299: extra non-policy review_reason values that can land on
// messages.review_reason without going through applyApprovalPolicyStage.
// Kept as a separate union from ApprovalTrigger so the auto-policy code
// doesn't have to know about operator-initiated reasons, but folded into
// the label map below so the queue UI renders both kinds uniformly.
//   operator_decline_initiated — TAC-299: operator swiped left on a
//     heads-up card; the draft-decline route persisted an apology draft
//     bypassing the policy gate (the swipe IS the approval).
//   generation_failed — TAC-364: generation crashed twice and
//     persistGenerationFailureCard wrote a blank card directly. Also outside
//     APPROVAL_TRIGGERS, and for the same structural reason as the decline:
//     the gate takes a GenerateMessageResult and a crash never produced one.
//     Until TAC-364 this card was stamped `knowledge_gap`, which made its copy
//     a lie — see GENERATION_FAILED_REVIEW_REASON in lib/agent/stages.ts.
type ExtraReviewReason = 'operator_decline_initiated' | 'generation_failed'

// Operator-facing copy for `messages.review_reason`.
//
// TAC-364 replaced all of these. They are now ONE PLAIN SENTENCE each, not a
// rule name and not a category label: what the operator needs to know, written
// to be understood cold. Five of the thirteen approval triggers have never
// fired in production, so their copy will be read for the first time on a live
// card.
//
// The wire field stays `string | null` — only the value changes from raw
// classifier code to human-readable text. Typed as Record<ApprovalTrigger |
// ExtraReviewReason, ...> so adding a new trigger in lib/agent/stages.ts or a
// new non-policy reason without copy here fails tsc. That totality is why the
// TAC-361 defect was NOT a fallthrough: no trigger can fall through this map.
//
// These strings are Contract surface — analog-operator renders them verbatim.
//
// NO EM DASHES in any value here (ruled 2026-09-14). These are read fast on a
// phone mid-shift, and an em dash is a pause the reader has to parse; a full
// stop or a comma is not. Enforced by a test over this map in queue.test.ts,
// not by review, so a new trigger's copy cannot reintroduce one. Comments in
// this file are prose and may keep them; only the strings reach the card.
// The copy table in the TAC-364 description is the source; transcribe from it,
// never from this map, when asserting on them.
//
// NOT IN THIS MAP, deliberately: `demo_bypass` and `crisis_safety_reply`. Both
// land on review_state='auto_sent' and `list_operator_queue` filters
// review_state='pending', so neither can reach a card. Containment is the
// queue predicate, not this map — do not add copy for them on the assumption
// that it would ever be read.
const REVIEW_REASON_LABELS: Record<ApprovalTrigger | ExtraReviewReason, string> = {
  // --- Obligation: yes/no on money -----------------------------------------
  // TAC-297: structural commitment-type gate, top of PRIMARY_TRIGGER_PRIORITY.
  // Says what is at stake (something free) and whose call it is, rather than
  // naming the gate.
  commitment_type_gated: 'This offers something free. Your call.',
  // Hedged because it is a regex on prose, not a structured emission: it can
  // be wrong, and the copy should not assert more confidence than the check
  // has. (Its only production hit to date matched the word "refund" inside the
  // model REFUSING a refund.)
  comp_regex_backstop: "This sounds like it's offering something on the house.",
  // v1.23.0 complaint floor. Names both halves of what the operator is
  // judging: a complaint happened, and the reply promises something about it.
  complaint_commitment_floor: 'Someone complained and this promises to make it right.',
  // TAC-355. "isn't on" is the venue's own vocabulary for a perk that isn't
  // running. Deliberately doesn't name the mechanic — that would need the
  // identified id persisted on the row, which is out of scope here.
  mechanic_offer_backstop: "This may be offering a perk that isn't on.",

  // --- Something outside the draft needs you --------------------------------
  // TAC-308. The one card with a clock: if nobody answers inside the window a
  // holding message goes to the guest instead of an answer. Phrased as the
  // ask, in the agent's own voice, because the operator is being asked to
  // supply something only they have.
  knowledge_gap: "A guest asked something I don't have an answer for.",
  // TAC-350. The distinction from knowledge_gap above is worth the operator's
  // attention and is carried by the tense: there the agent knew it was stuck,
  // here it wrote something and a second check disagreed. That check CAN be
  // wrong — it was, twice, in the first two minutes after TAC-301 part 1.5
  // deployed — so the sentence reports a doubt rather than a verdict. The
  // flagged claim itself now rides on `ungroundedClaims` so the operator can
  // see which sentence is the suspect one.
  knowledge_gap_backstop: "I wasn't sure this was true, so I didn't send it.",
  // TAC-367. Deliberately NOT folded under the backstop copy above: nothing
  // was caught here, the check just didn't complete. Telling an operator a
  // claim was caught when none was is the wrong-reason-copy problem TAC-364
  // exists for.
  grounding_check_failed: "I couldn't finish checking this one.",
  // Venue-wide policy, ranked last in PRIMARY_TRIGGER_PRIORITY, so this shows
  // only when nothing more specific co-fired. "right now" because the flag is
  // a switch someone threw and can throw back.
  hold_all_outbound: "You're holding everything here right now.",
  // TAC-361, the defect this ticket was opened on. The old copy read
  // 'Complaint needs your call' — an explicit entry written at v1.24.0 when
  // comp_complaint was the only routed category. TAC-307 generalised the
  // trigger to any category (and shipped a master "hold everything" switch)
  // and the copy never followed, so a welcome reply to "Hi Himanshu!" reached
  // the operator labelled as a complaint. Now it names the only thing that is
  // actually true on every routed category: they chose this.
  category_requires_approval: 'You chose to review these yourself.',

  // --- The draft came out wrong --------------------------------------------
  // The model's own self-flag, which carries a free-text approvalReason we
  // don't persist — so the copy stays vague on purpose rather than inventing a
  // specific that isn't on the row.
  model_flagged: 'Something felt off about this one.',
  // TAC-355. First person, because that is literally what went wrong: the
  // reply talked about the agent instead of to the guest. The card renders the
  // full body, so this tells the operator what to look for.
  self_talk_detected: 'I was talking about myself instead of to the guest.',
  // "like you" — the venue's voice is the thing being matched, and the
  // operator is the one who knows what it sounds like. Never "low fidelity
  // score", which is our vocabulary, not theirs.
  fidelity_below_auto_send_floor: "This doesn't sound enough like you.",
  // TAC-364, new. Generation crashed twice and the card is blank. Until now
  // this said "a guest asked something I don't have an answer for", which was
  // false — the guest may have asked something perfectly answerable.
  generation_failed: 'Something went wrong writing this one.',

  // --- You're mid-thread with this guest ------------------------------------
  // Ranked 9th, so it only ever wins when nothing else fired: the draft itself
  // is fine and the copy should not imply otherwise. Verified in production —
  // on 2026-08-09 a perfectly good "Cortado or the Frosty Gandhi" was held
  // behind an unreviewed knowledge-gap card.
  previous_pending_held: 'Held behind an earlier message to this guest.',
  // TAC-299: the operator swiped left on a heads-up card and /draft-decline
  // persisted this apology. "You passed on the last one" points at their own
  // action, which is the context that makes the draft make sense.
  operator_decline_initiated: "You passed on the last one, so here's another go.",
}

/**
 * TAC-364: the label map's key set, for tests only.
 *
 * `tsc` already forces COPY to exist for every trigger (the map is total over
 * `ApprovalTrigger | ExtraReviewReason`). What it cannot force is that the new
 * copy was ever checked against the Contract — a 16th trigger compiles the
 * moment someone types any string, and `queue.test.ts`'s `it.each` table is
 * hand-maintained. Exporting the keys lets that test assert its own
 * completeness, so new copy cannot ship having been read by nobody.
 *
 * Not for runtime branching. Same shape as `_PUSH_POLICY_FOR_TESTS`.
 */
export const _REVIEW_REASON_KEYS_FOR_TESTS: readonly string[] =
  Object.keys(REVIEW_REASON_LABELS)

const REVIEW_REASON_FALLBACK = 'Needs review'

function normalizeReviewReason(raw: string | null): string | null {
  if (raw === null) return null
  return (REVIEW_REASON_LABELS as Record<string, string>)[raw] ?? REVIEW_REASON_FALLBACK
}

/**
 * TAC-364: the raw trigger codes, unmodified.
 *
 * Ruling 1 replaced an earlier version of this that mapped every entry through
 * REVIEW_REASON_LABELS — prose here made the one thing the client has to do
 * with the field impossible, since secondaries are `reviewTriggers` minus
 * `reviewReasonCode` and that subtraction needs both sides to be codes.
 * `toReviewTriggerLabels` below carries the display text.
 *
 * A null column means the row predates migration 039, or was written by a path
 * that never ran the gate (the generation-failure card, the operator decline)
 * and so has no trigger SET to record — only the single reason it stamps
 * itself. Both render as today, which is what the Contract promises for an old
 * row.
 *
 * `?? []` rather than `=== null`: the column is also ABSENT (undefined) when
 * this code runs against a pre-039 RPC, which is a real local-dev state even
 * though the deploy ordering forbids it in production. Both mean "nothing
 * recorded" to the client, and one nullish check covers both without
 * pretending to defend against anything else.
 *
 * Order is preserved from the DB array, which is enumeration order from
 * `applyApprovalPolicyStage` — the order the checks fired, NOT priority order.
 * Re-sorting here would throw away the only record of what fired when.
 */
function normalizeReviewTriggers(raw: string[] | null): string[] {
  return raw ?? []
}

/**
 * TAC-364: display text for `normalizeReviewTriggers`' output, index-aligned.
 *
 * Derived from the SAME array in the SAME order rather than mapped separately
 * at the call site, so the two cannot come out of step. Callers must pass the
 * already-normalized codes, not the raw column, or the alignment guarantee is
 * theirs to keep rather than this function's.
 */
function toReviewTriggerLabels(codes: string[]): string[] {
  return codes.map(
    (t) => (REVIEW_REASON_LABELS as Record<string, string>)[t] ?? REVIEW_REASON_FALLBACK,
  )
}

/**
 * TAC-364: `null` → `[]`, nothing else. The claims are the verifier's verbatim
 * quotations from the draft body and are shown to the operator as written —
 * there is no label map to run them through, and rewriting them would defeat
 * the point of quoting.
 *
 * This collapse is where the column's NULL-vs-`[]` distinction is DELIBERATELY
 * discarded. NULL means the grounding check never ran (followup, demo guest,
 * or the model self-reported a gap so the check was skipped) and `[]` means it
 * ran and found nothing — a real difference, and the one TAC-367 existed
 * because nobody could answer. It stays a property of the row rather than the
 * payload because neither state produces anything on the card: both render no
 * claims. Surfacing it would cost the Contract's never-branch-on-presence
 * guarantee to tell the client something it would not act on. The observability
 * question is asked in SQL against `messages.ungrounded_claims`, not here.
 */
function normalizeUngroundedClaims(raw: string[] | null): string[] {
  return raw ?? []
}

/**
 * TAC-394: the RPC's `other_pending_for_guest` count, as the Contract's
 * always-present number. `count(*)` is never NULL, but the column is ABSENT when
 * this code runs against a pre-042 function (a local-dev state the deploy
 * ordering forbids in production), and the Contract promises a number, so
 * anything that is not a positive finite number reads as 0.
 */
function normalizeOtherPendingCount(raw: number | null | undefined): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0
}

function normalizeRecentContext(raw: Json | null): QueueRecentContextEntry[] {
  if (raw === null) return []
  if (!Array.isArray(raw)) return []
  const out: QueueRecentContextEntry[] = []
  for (const entry of raw) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).id === 'string' &&
      typeof (entry as Record<string, unknown>).direction === 'string' &&
      typeof (entry as Record<string, unknown>).body === 'string' &&
      typeof (entry as Record<string, unknown>).createdAt === 'string'
    ) {
      const e = entry as Record<string, string>
      if (e.direction === 'inbound' || e.direction === 'outbound') {
        out.push({
          id: e.id,
          direction: e.direction,
          body: e.body,
          createdAt: e.createdAt,
        })
      }
    }
  }
  return out
}

export async function listPendingQueue(
  allowedVenueIds: string[],
  /** Optional override for testing. Defaults to Date.now(). */
  nowMs: number = Date.now(),
): Promise<ListPendingQueueResult> {
  // Empty allowlist → empty queue; an operator with no venue grants isn't
  // an error, they just see nothing.
  if (allowedVenueIds.length === 0) {
    return { ok: true, drafts: [] }
  }

  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('list_operator_queue', {
    venue_ids: allowedVenueIds,
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  const drafts: QueueDraft[] = (data ?? []).map((row) => {
    const createdAt = new Date(row.created_at).getTime()
    // Computed once and used twice, so the codes and their labels are
    // guaranteed to be the same array in the same order rather than two
    // independent normalizations that happen to agree today.
    const reviewTriggerCodes = normalizeReviewTriggers(row.review_triggers)
    return {
      messageId: row.draft_id,
      venueId: row.venue_id,
      venueSlug: row.venue_slug,
      guestId: row.guest_id,
      guestDisplayName: row.guest_display_name,
      // TAC-467: '' for a guest with no phone (an Instagram guest), never
      // null. analog-operator parses the drafts array all-or-nothing with
      // `guestPhoneFallback: z.string()`, so one null would empty the queue
      // for every operator who can see that venue. The cast is deliberate:
      // generated types call every RPC return column non-null, and
      // regenerating them would put back a `string` that is not true.
      guestPhoneFallback: (row.guest_phone as string | null) ?? '',
      draftBody: row.draft_body,
      category: row.category,
      voiceFidelity: row.voice_fidelity,
      reviewReason: normalizeReviewReason(row.review_reason),
      // TAC-364: the RAW code, un-normalized and never null — this is what the
      // client keys card colour on, and `''` is the "nothing recorded" value so
      // it never has to branch on presence. Deliberately NOT derived from
      // `reviewReason`: the whole defect being fixed is that a label is prose
      // that can be edited, and a colour must not move when copy does.
      reviewReasonCode: row.review_reason ?? '',
      reviewTriggers: reviewTriggerCodes,
      reviewTriggerLabels: toReviewTriggerLabels(reviewTriggerCodes),
      ungroundedClaims: normalizeUngroundedClaims(row.ungrounded_claims),
      otherPendingDraftsForGuest: normalizeOtherPendingCount(row.other_pending_for_guest),
      recognitionState: normalizeRecognitionState(row.recognition_state),
      pendingSinceMs: Math.max(0, nowMs - createdAt),
      recentContext: normalizeRecentContext(row.recent_context),
      langfuseTraceId: row.langfuse_trace_id,
    }
  })

  return { ok: true, drafts }
}
