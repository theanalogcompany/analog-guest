/**
 * TAC-483. Pure classifier over a real verifyGrounding call's
 * `ungroundedClaims` array: does any claim describe the specific failure
 * shape this ticket measures — the generator collapsing two differently
 * named, differently dated guest-reported items into one claimed repeat or
 * streak ("the Pink Panther two days in a row" when the guest actually named
 * Blossom Tonic today and Pink Panther yesterday)?
 *
 * This is a HEURISTIC AID over free-form model prose, not ground truth.
 * verifyGrounding's own `hasUngroundedClaim` is the real signal and this file
 * never touches the verifier — per the ticket's instruction, it is not being
 * changed and its output is the evidence this ticket rests on. A keyword
 * match can both over-count (an unrelated claim happens to say "again") and
 * under-count (a conflation phrased without any of these words), which is
 * why the orchestrating script always prints the raw claims text for a human
 * to read alongside this score, rather than trusting the count alone.
 *
 * No `@/*` imports — pure and dependency-free, so it loads in vitest with no
 * SDK init, same posture as lib/agent/comp-backstop.ts and
 * lib/ai/self-talk-detector.ts.
 */

const REPEAT_PHRASE_PATTERNS: readonly RegExp[] = [
  /\btwo days? in a row\b/i,
  /\bconsecutive days?\b/i,
  /\bback[- ]to[- ]back\b/i,
  /\bagain\b/i,
  /\btwice\b/i,
  /\bsame (?:drink|item|thing|order)\b/i,
  /\bboth days?\b/i,
  /\brepeat\b/i,
]

/** True when one claim's text carries repeat/streak phrasing. */
export function isConflationShapedClaim(claim: string): boolean {
  return REPEAT_PHRASE_PATTERNS.some((pattern) => pattern.test(claim))
}

export type ConflationScore = {
  isConflationShaped: boolean
  matchedClaims: string[]
}

/**
 * Scores a full `ungroundedClaims` array. `isConflationShaped` is true when
 * at least one claim matches; `matchedClaims` is the subset that did, so the
 * caller can print exactly which claim(s) tripped it alongside the raw list.
 * An empty input (no claim flagged at all) scores false, not an error.
 */
export function scoreConflationClaims(claims: readonly string[]): ConflationScore {
  const matchedClaims = claims.filter(isConflationShapedClaim)
  return { isConflationShaped: matchedClaims.length > 0, matchedClaims }
}
