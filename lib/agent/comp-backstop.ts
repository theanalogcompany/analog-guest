// Deterministic regex backstop for comp commitments in agent drafts (TAC-212).
//
// Sits alongside the model's `requiresOperatorApproval` self-flag inside
// applyApprovalPolicyStage. The two layers run independently: when the model
// misses a self-flag (or genuinely thinks the reply isn't a comp), the regex
// can still force `triggers: ['comp_regex_backstop']` and queue the draft.
// Comp commitments are the irreversible-financial case where a false negative
// is much worse than a false positive — operator can always release a queued
// draft, but can't unsend a free coffee.
//
// Pattern selection follows the operator-action-anchored rule from the plan
// review: only fire on phrasings that mean comp in operator context, not bare
// keywords. Anything ambiguous (bare "free", bare "discount", bare "no charge")
// requires an explicit menu/order/bill noun nearby. False positives we accept
// are vanishingly rare in agent drafts to guests; false negatives are the
// failure mode this exists to prevent.
//
// Same role as THE-225's DASH_REGEX but a different placement: dash check
// runs INSIDE the regen loop (forces rewrite); comp check runs OUTSIDE the
// regen loop (queues instead). Comp commitments are intentional speech acts —
// rewording probably still has the comp.

export const COMP_PATTERNS: readonly RegExp[] = [
  // High-precision solo phrases (cannot mean anything else in this context)
  /\bon (us|me|the house)\b/i,
  /\bmy treat\b/i,
  /\bour treat\b/i,
  /\bcomp(ed|ing|s)?\b/i,
  /\bcomplimentary\b/i,
  /\brefund(ed|ing|s)?\b/i,
  /\bgratis\b/i,
  // Operator-action with context
  /\bnext one(?:'?s)? on (?:me|us|the house)\b/i,
  /\bfirst one(?:'?s)? on (?:me|us|the house)\b/i,
  /\bnext round(?:'?s)? on (?:me|us|the house)\b/i,
  /\bwon'?t (charge|bill) (?:you )?for\b/i,
  /\bdon'?t worry about (?:the|this|that|your) (?:bill|tab|charge)\b/i,
  /\btake care of (this|that|it|the bill|your bill|the tab)\b/i,
  /\b(?:I'?ll|we'?ll|let me|let us) (?:cover|pick up|get) (?:this|that|it|your (?:bill|tab|order)|the (?:bill|tab))\b/i,
  // Money-with-zero
  /\$0(?:\b|\.\d)/,
  /\bfree of charge\b/i,
  /\bno cost to you\b/i,
  /\bzero cost\b/i,
  // Contextual "free X" — only fires next to concrete order/menu nouns,
  // never on "free wifi" / "free parking" / "free of espresso-related guilt"
  /\bfree (drink|coffee|espresso|latte|cappuccino|americano|tea|pastry|cookie|round|refill|one|item|order|pour|shot|cup|snack|bite|sandwich)\b/i,
  // Contextual discount — only fires when the discount applies to an order
  /\bdiscount(?:ed|ing|s)? (?:your|this|the|on your|for your|on this)\b/i,
  /\b\d{1,3}% (?:off|discount)\b/i,
  // Contextual "no charge" — only fires on "no charge for this/that" (bare
  // demonstrative, operator-action shape) or "no charge for the|your <menu
  // noun>". This intentionally drops "no charge for the wifi password" while
  // keeping "no charge for your refill" / "no charge for the round".
  /\bno charge for (?:this|that)\b/i,
  /\bno charge for (?:the|your) (?:order|tab|bill|refill|round|drink|coffee|espresso|latte|cappuccino|americano|tea|pastry|cookie|item|cup|sandwich|snack|one|pour|shot)\b/i,
]

export type CompMatchResult =
  | { matched: true; pattern: string }
  | { matched: false }

/**
 * Scan a drafted message body against COMP_PATTERNS. On the first match,
 * returns the pattern source for trace / event payload (so operators can see
 * which phrasing tripped the backstop in PostHog). On no match, returns
 * `{ matched: false }`. Pure function — no DB, no I/O.
 */
export function matchComp(body: string): CompMatchResult {
  for (const p of COMP_PATTERNS) {
    if (p.test(body)) {
      return { matched: true, pattern: p.source }
    }
  }
  return { matched: false }
}
