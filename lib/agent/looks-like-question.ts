// TAC-484: a deterministic, dependency-free check for whether a guest's
// message reads as a question — same shape as lib/ai/self-talk-detector.ts
// (pure, no @/* imports, no model call).
//
// Motivating incident (2026-09-18, Le Mil's): a knowledge-gap card's
// `## Unanswered question` prompt block (pending-question.ts) attached itself
// to ANY non-empty inbound, including a plain statement ("oh and i got the
// pink panther yesterday"). The block then told the model, as settled fact,
// that "the venue still owes them an answer" — a false premise the next four
// auto-sent turns built on top of. This check is what stops the block (and,
// separately, the holding-message clock in stages.ts) from attaching to an
// inbound that was never a question in the first place.
//
// Biased toward PRECISION, not recall, on purpose. The failure this closes is
// a statement being treated as an outstanding question; the cost of the
// reverse mistake (a real question phrased without "?" or a recognized
// opener loses the "the venue still owes them an answer" framing) is losing
// a nudge, not creating a false one — the same "a nudge, not a guardrail"
// framing pending-question.ts's own header already carries for this whole
// mechanism.

const INTERROGATIVE_OPENERS: ReadonlySet<string> = new Set([
  'what',
  'why',
  'when',
  'where',
  'who',
  'how',
  'can',
  'could',
  'would',
  'will',
  'is',
  'are',
  'do',
  'does',
  'did',
  'should',
  'any',
  'was',
  'were',
])

/**
 * True when `body` reads as a question: it contains a literal `?`, or its
 * first word is a closed-list interrogative opener. Otherwise false,
 * including on an empty or whitespace-only body.
 */
export function looksLikeQuestion(body: string): boolean {
  const trimmed = body.trim()
  if (trimmed.length === 0) return false
  if (trimmed.includes('?')) return true
  const firstWord = trimmed.match(/^[a-zA-Z']+/)?.[0]
  if (!firstWord) return false
  return INTERROGATIVE_OPENERS.has(firstWord.toLowerCase())
}
