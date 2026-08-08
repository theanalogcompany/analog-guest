// TAC-313: message splitting. Pure helpers for turning one generated body
// into the bubbles that get dispatched as separate Sendblue messages.
//
// No imports — this module is deliberately dependency-free so the split and
// strip logic can be unit-tested without any SDK init (see CLAUDE.md
// "Module split for testability").
//
// The model places the delimiter; the sender decides what to do with it. Two
// entry points, and the asymmetry between them is the whole design:
//
//   splitIntoBubbles       — the auto-send path. Delimiter becomes a boundary.
//   collapseToSingleMessage — the queue path. Delimiter becomes a space.
//
// Together they enforce the invariant that NO DELIMITER EVER REACHES THE
// DATABASE: the auto-send path persists per-bubble bodies that never contained
// one, and the queue path strips before the row is written. An operator
// approving a draft therefore sends text they can actually see, and the
// operator dispatch path needs no delimiter logic of its own.

/**
 * The token the model emits where one beat ends and the next begins.
 *
 * Chosen over a punctuation-shaped delimiter (`|||`, `---`, `\n\n`) because
 * those can occur in real text, and a false positive splits a message the
 * model never meant to split. `[[BREAK]]` cannot appear by accident, and it is
 * unmistakable when reading a Langfuse trace or a corpus row during voice
 * tuning — which is the activity this token will mostly be seen during.
 */
export const BUBBLE_DELIMITER = '[[BREAK]]'

/**
 * Hard cap on bubbles per response, enforced HERE rather than only in the
 * prompt. A prompt rule is guidance; this is the guarantee. Four bubbles in a
 * row stops reading as texting and starts reading as a machine.
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
 * Split a generated body into the bubbles to dispatch, in order.
 *
 * - No delimiter present → a single-element array holding the body unchanged.
 *   This is the common case; splitting is the exception.
 * - Over the cap → the first `MAX_BUBBLES_PER_RESPONSE - 1` bubbles are kept
 *   as-is and every remaining beat is JOINED into the last one. Text is never
 *   discarded. Truncating would silently delete a sentence the model meant to
 *   send, which is a worse failure than a slightly dense final bubble.
 * - Body that is only delimiters (or only whitespace) → empty array. The
 *   caller treats that as an empty body and takes its existing failure path
 *   rather than dispatching nothing and reporting success.
 */
export function splitIntoBubbles(body: string): string[] {
  const parts = body
    .split(DELIMITER_PATTERN)
    .map(normalizeWhitespace)
    .filter((part) => part.length > 0)

  if (parts.length <= MAX_BUBBLES_PER_RESPONSE) return parts

  const kept = parts.slice(0, MAX_BUBBLES_PER_RESPONSE - 1)
  const merged = parts.slice(MAX_BUBBLES_PER_RESPONSE - 1).join(' ')
  return [...kept, merged]
}

/**
 * Flatten a generated body to one message: delimiters become a single space,
 * whitespace runs collapse, ends trim.
 *
 * This is the queue-path guard. A queued draft is one row that an operator
 * reads and approves verbatim, so it must contain prose rather than markup —
 * and because approve dispatches `messages.body` unchanged, a delimiter left
 * in the row would go straight to the guest over a body the operator was never
 * shown.
 *
 * Accepted cost, per TAC-313 §2: an approved draft does not split where an
 * auto-sent one would.
 */
export function collapseToSingleMessage(body: string): string {
  return normalizeWhitespace(body.replace(DELIMITER_PATTERN, ' '))
}
