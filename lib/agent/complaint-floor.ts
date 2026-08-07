// Category floor for complaint turns (v1.23.0).
//
// WHY THIS EXISTS — the failure it backstops:
//
// On 2026-08-07 the agent auto-sent "Come by and I'll have another made for
// you" in direct response to a refund request. Three gates should have caught
// it and none did:
//
//   comp_regex_backstop  — COMP_PATTERNS is anchored on monetary comp
//                          vocabulary ("on us", "comp", "free <noun>"). An
//                          in-kind remake uses none of it.
//   model_flagged        — the `# Resource commitment self-flag` block
//                          enumerated "comp, discount, refund, or any
//                          monetary credit". The model's own trace reasoning:
//                          "not flag operator approval since I'm not
//                          promising a monetary credit, just a corrected
//                          drink."
//   commitment_type_gated— the `# Commitments` type enum had no in-kind
//                          replacement type; the model emitted commitment: {}.
//
// v1.23.0 widens all three prompts from monetary to value-transfer framing.
// But the observed failure was the model REASONING ITS WAY AROUND a line —
// it weighed "comp vs. remake," found the categories didn't cover it, and
// self-authorized an exception. Widening the enumeration relocates the line;
// it does not remove the model's ability to argue past the new one. This
// module is the deterministic floor underneath that judgment.
//
// DESIGN: gate on grammar, not vocabulary.
//
// The tempting fix — widen COMP_PATTERNS to catch "another made for you" —
// was explicitly rejected. The set of ways to describe WHAT is being given is
// unbounded ("I'll have one waiting", "come by and we'll sort it out"), and
// any pattern broad enough to catch those also fires on legitimate non-comp
// language ("I'll have an answer for you"). That trades a high-precision
// backstop for a noisy one.
//
// The set of ways to say "I commit to a future action" is, by contrast,
// small and closed: first-person subject + forward modal. So we match PROMISE
// SHAPE and let the category provide the topic scope. On a complaint turn,
// a first-person forward promise is a remedy promise — we don't need to know
// what was promised to know it needs review.
//
// MEASURED against all 12 comp_complaint outbounds in the database
// (2026-05-02 .. 2026-08-07, the complete history at time of writing):
//   8 queued (66%) · 6 true positives · 2 false positives · precision 75%
//   all 3 pure-question turns pass through untouched
//   catches the 2026-08-07 incident
// comp_complaint runs 0.64 msg/week (12 of 142 outbound, 8.5%), so the floor
// costs roughly one extra operator review per 2.4 weeks and one FALSE queue
// per ~10 weeks. Both false positives are prompt-endorsed information stalls
// ("let me find out and get back to you"); accepted deliberately rather than
// carved out, because an information-verb denylist is the same lexical slope
// the vocabulary approach was rejected for.

import type { MessageCategory } from '@/lib/ai/types'

/**
 * Categories where a first-person forward promise is presumed to be a remedy
 * promise. Deliberately narrow — this is the topic scope that lets the
 * grammar predicate stay dumb.
 *
 * NOT included, and why it matters: `mechanic_request`. Both "can i get a
 * free drink" and "any chance you can hold a bag" classify there, so the
 * floor is structurally incapable of queueing an ordinary perk refusal —
 * the regression case that matters most. Adding a category here is a real
 * decision; it widens what gets held from the guest.
 */
export const FLOOR_CATEGORIES: ReadonlySet<MessageCategory> = new Set<MessageCategory>([
  'comp_complaint',
])

/**
 * First-person forward-commitment grammar.
 *
 * NEGATION IS THE HAZARD HERE. `\b(i can)\b` matches "I can't" — the
 * apostrophe is a non-word character, so the boundary after "can" holds and
 * the refusal reads as a promise. That would queue refusals, which is a worse
 * failure than the bug this module fixes: an unreviewed comp is recoverable
 * by an operator, a delayed "no" is a guest sitting unanswered.
 *
 * Two consequences baked into the patterns below:
 *   - `i can` / `we can` are OMITTED entirely. Measured against the 12
 *     fixtures, they contribute zero true positives — a genuine commitment
 *     effectively always surfaces as "I'll" / "we'll" / "let me". They are
 *     pure negation risk with no upside.
 *   - `i will` / `we will` carry an explicit (?!\s+(?:not|never)) guard,
 *     since "I will not be able to do that" has the same shape.
 * Contractions are safe unguarded: "won't" does not match "will", and
 * "I'll never" is not idiomatic in this voice.
 *
 * `let me` is KEPT despite costing one false positive ("let me find out"),
 * because dropping it loses "let me make you a fresh one" / "let me get you
 * another one" — the exact in-kind replacement class this module exists for,
 * and phrasings COMP_PATTERNS does not cover either. Verified against the
 * fixtures both ways before committing to this trade.
 */
export const FORWARD_COMMITMENT_PATTERNS: readonly RegExp[] = [
  // Apostrophe REQUIRED on contractions, and both straight (') and curly (’)
  // accepted. An optional apostrophe — /\bwe'?ll\b/ — collapses to the word
  // "well", so "we're usually well stocked" reads as a promise; /\bi'?ll\b/
  // likewise matches "ill". Both were caught by the fixture suite below.
  // Guests send curly apostrophes from iOS, so the class is not optional.
  /\bi['’]ll\b/i,
  /\bwe['’]ll\b/i,
  /\b(?:i|we) will(?!\s+(?:not|never)\b)/i,
  /\blet me\b/i,
  /\bi['’]m going to\b/i,
  /\bwe['’]re going to\b/i,
]

export type ForwardCommitmentMatch =
  | { matched: true; pattern: string }
  | { matched: false }

/**
 * Scan a drafted body for first-person forward-commitment grammar. Returns
 * the matching pattern source on a hit so the operator queue and PostHog can
 * show which shape tripped the floor. Pure — no DB, no I/O.
 *
 * Mirrors matchComp (lib/agent/comp-backstop.ts) in shape and return type on
 * purpose; the two are siblings in applyApprovalPolicyStage.
 */
export function matchForwardCommitment(body: string): ForwardCommitmentMatch {
  for (const p of FORWARD_COMMITMENT_PATTERNS) {
    if (p.test(body)) {
      return { matched: true, pattern: p.source }
    }
  }
  return { matched: false }
}

/**
 * Whether this category is in scope for the floor. Kept as a helper rather
 * than an inline Set lookup so the category scope is greppable from the
 * gate and testable independently of the grammar.
 */
export function isFloorCategory(category: MessageCategory | undefined): boolean {
  return category !== undefined && FLOOR_CATEGORIES.has(category)
}
