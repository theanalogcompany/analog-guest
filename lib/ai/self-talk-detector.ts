// Deterministic self-talk / reasoning-leakage detector for agent drafts
// (TAC-355). Sits alongside DASH_REGEX inside generateMessage's per-attempt
// regen loop (lib/ai/generate-message.ts) — same role, same placement.
//
// The failure this catches: the model writes an em dash, notices it broke
// the universal no-dash rule, and corrects itself OUT LOUD in the guest-
// facing body instead of rewriting ("...dandelion root — actually wait, no
// dashes. Chicory, nutmeg..."). A guest reading that knows immediately
// they're texting a bot, which defeats the product's premise (CLAUDE.md:
// "Voice is the product"). No model judgment is needed to detect it — a
// guest-facing message never legitimately contains self-correction or a
// reference to the agent's own rules/instructions.
//
// Unlike DASH_REGEX (which ships anyway if the violation persists through
// every regen attempt — THE-225's reasoning: punctuation isn't worth
// refusing over), a self-talk violation that survives the retry must NOT
// ship. See generateMessage's selfTalkViolationPersisted field and
// stages.ts's SELF_TALK_DETECTED trigger for the queue-not-send handling.
//
// Pattern scoping (false-positive analysis from the TAC-355 audit): the
// check runs against the AGENT'S OWN generated body, never the guest's
// inbound, so a guest asking about "the rules" can never trip it on its
// own. The real risk is the agent's own legitimate business copy —
// "per house rules", "here are instructions to redeem" are real venue
// speech. Every rules/instructions/programming pattern below therefore
// requires a self-referential subject (my/our/I'm/I was) rather than
// matching the bare noun. "as an AI"/"as a bot"/etc. carry low false-
// positive risk as near-bare patterns. The self-correction patterns
// ("actually wait", "let me rephrase") accept looser matching deliberately
// — a false positive here costs one harmless regen attempt, never a queue
// or a block, while a false negative ships the exact defect this module
// exists to catch.

export const SELF_TALK_PATTERNS: readonly RegExp[] = [
  // Self-correction mid-message — the literal failure case.
  /\bactually,?\s*wait\b/i,
  /\blet me rephrase\b/i,
  /\blet me rewrite (?:that|this)\b/i,
  /\bi should not\b/i,
  /\bi shouldn'?t\b/i,
  /\bno dashes?\b/i,
  /\bwithout (?:a |the )?dash(?:es)?\b/i,
  /\bcan'?t use (?:a |an? )?(?:em[- ]?)?dash\b/i,
  // Self-reference as an AI/bot/assistant/model.
  /\bas an ai\b/i,
  /\bas an assistant\b/i,
  /\bas a bot\b/i,
  /\bas a language model\b/i,
  /\bi'?m an ai\b/i,
  // Self-referential rules/instructions/programming — subject required so
  // ordinary venue copy ("per house rules", "instructions to redeem") never
  // matches.
  /\b(?:my|our|i'?m|i was)\s+(?:instructions?|programming|guidelines|rules)\b/i,
  /\bper my (?:instructions?|rules|programming|guidelines)\b/i,
]

export type SelfTalkMatchResult = { matched: true; pattern: string } | { matched: false }

/**
 * Scan a drafted message body against SELF_TALK_PATTERNS. On the first
 * match, returns the pattern source (for trace / event payload, mirroring
 * matchComp's shape). Pure function — no DB, no I/O.
 */
export function matchSelfTalk(body: string): SelfTalkMatchResult {
  for (const p of SELF_TALK_PATTERNS) {
    if (p.test(body)) {
      return { matched: true, pattern: p.source }
    }
  }
  return { matched: false }
}
