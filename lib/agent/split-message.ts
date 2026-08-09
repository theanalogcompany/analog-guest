// TAC-313 introduced this module as the model-driven splitting machinery;
// TAC-319 retired the model's role. The model no longer places delimiters —
// dispatch decides the split deterministically in ./sentence-split — so what
// survives here is the DEFENSIVE half: the delimiter matcher and the
// collapse/strip helper, plus the shared bubble constants.
//
// No imports — this module is deliberately dependency-free so the strip logic
// can be unit-tested without any SDK init (see CLAUDE.md "Module split for
// testability").
//
// collapseToSingleMessage now serves BOTH paths:
//   - queue path: a draft is one row an operator reads and approves verbatim,
//     so it must contain prose, never markup.
//   - dispatch path: resolveDispatchBubbles (./sentence-split) calls it first,
//     so a stray model-emitted [[BREAK]] is stripped as noise before sentence
//     detection runs.
// Between them the TAC-313 invariant stands: NO DELIMITER EVER REACHES THE
// DATABASE, or Sendblue.

/**
 * The token the model USED to emit where one beat ended and the next began
 * (TAC-313, prompt versions v1.27.0–v1.30.0). TAC-319 removed the rule that
 * taught it, so the model should never emit it again — but "should never" is
 * exactly what defensive stripping is for, and traces or corpus rows written
 * during that era may still carry it.
 */
export const BUBBLE_DELIMITER = '[[BREAK]]'

/**
 * Hard cap on bubbles per response. Four bubbles in a row stops reading as
 * texting and starts reading as a machine. TAC-319: also the upper bound of
 * the flippable sentence range in ./sentence-split — a body with more
 * sentences than this never splits at all (all-or-nothing; partial grouping
 * is forbidden).
 */
export const MAX_BUBBLES_PER_RESPONSE = 3

/**
 * Pause between bubbles, with the typing indicator showing across it.
 *
 * A fixed constant, deliberately NOT derived from `sampleTiming` — per TAC-313
 * §6 the timing module is out of scope and none of its constants are read or
 * changed here. A follow-up bubble lands faster than a first reply does,
 * because the writer is already mid-thought rather than deciding to answer.
 */
export const INTER_BUBBLE_GAP_MS = 1_500

/**
 * Delimiter matcher, deliberately tolerant of near-misses.
 *
 * Accepts one or two brackets on each side, zero to two closing brackets, any
 * internal whitespace, and any casing: `[[BREAK]]`, `[BREAK]`, `[[break]]`,
 * `[[ BREAK ]]`, `[[BREAK]`, `[BREAK]]`. Surrounding whitespace is consumed as
 * part of the match so neither output carries the gap the delimiter sat in.
 *
 * THE TOLERANCE IS DIRECTIONAL, and the direction is the point. A false
 * positive splits a message that should have stayed whole — mildly odd for the
 * guest, and no wrong text is shown. A false negative ships a literal
 * `[[BREAK]` into someone's iMessage thread. Over-matching is the safe side, so
 * this pattern errs toward matching.
 *
 * The two alternatives exist to get tolerance and safety at the same time,
 * because a single pattern has to trade one against the other:
 *
 *   `[[BREAK`      — DOUBLE bracket, matched whatever follows. Two opening
 *                    brackets is already an unambiguous signal, so a delimiter
 *                    fused straight into the next word (`a[[BREAKb`, both
 *                    closing brackets lost) still splits.
 *   `[BREAK\b`     — SINGLE bracket, matched only at a word boundary. Without
 *                    that boundary `[BREAKFAST]` would match `[BREAK` and
 *                    leave a dangling `FAST]`, corrupting a real message.
 *
 * A single-bracket token fused to the next word (`a[BREAKb`) is therefore the
 * one shape not matched. It requires losing an opening bracket AND both
 * closing brackets AND the space, and matching it would mean giving up the
 * `[BREAKFAST]` protection — which guards text a guest actually sees.
 *
 * Residual, accepted: a bare `BREAK` with no brackets at all is not matched,
 * because the unbracketed word appears in ordinary prose ("we take a break at
 * three") and stripping it would corrupt real messages. The prompt shows the
 * bracketed token exactly.
 *
 * Used only with `.split()` and `.replace()`, both of which are unaffected by
 * the `g` flag's `lastIndex` state. Do not add a `.test()` call against this
 * shared instance without cloning it first.
 */
const DELIMITER_PATTERN = /\s*(?:\[\[\s*BREAK|\[{1,2}\s*BREAK\b)\s*\]{0,2}\s*/gi

/** Collapse every run of whitespace to a single space and trim the ends. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Flatten a body to one message: delimiters become a single space, whitespace
 * runs collapse, ends trim. Returns an empty string for a body that was only
 * delimiters or whitespace — callers treat that as an empty body.
 *
 * Queue path: a queued draft is one row that an operator reads and approves
 * verbatim, so it must contain prose rather than markup — and because approve
 * dispatches `messages.body` unchanged, a delimiter left in the row would go
 * straight to the guest over a body the operator was never shown.
 *
 * Dispatch path (TAC-319): resolveDispatchBubbles calls this before sentence
 * detection, so a stray marker is stripped as noise rather than treated as a
 * split instruction.
 *
 * Accepted cost, unchanged from TAC-313 §2 and reaffirmed by the TAC-319
 * ruling: an approved draft does not split — when a human wrote or approved
 * exact text, sending it verbatim is the least surprising behavior.
 */
export function collapseToSingleMessage(body: string): string {
  return normalizeWhitespace(body.replace(DELIMITER_PATTERN, ' '))
}
