// TAC-519: move the `## What you're hoping to get to` block to the end of the
// user prompt, as a pure string transformation on an already-composed prompt.
//
// WHY A TRANSFORMATION RATHER THAN A CODE CHANGE. The position candidate is
// unmeasured, and measuring it by editing runtimeToProse would mean shipping the
// change to find out whether it works. This lets the measurement decide first.
// The arm is therefore exactly one variable away from `before`: same venue, same
// guest, same corpora, same retrieval, same classification, same block text,
// same everything, with one block relocated.
//
// WHY NOT split on '\n\n'. runtimeToProse joins blocks with '\n\n' (serializers
// .ts, `blocks.join('\n\n')`), but `formatOpenIntentions` builds its own
// paragraph from an array containing '' entries joined with '\n', so the
// intentions block CONTAINS '\n\n' internally. Splitting on the separator
// fragments the very block this moves. The split below is on '\n\n' only where
// a '## ' heading follows, which no internal blank line of any user-prompt block
// does today.
//
// That last clause is an assumption about content, not syntax, and a guest can
// type anything: `formatRecentConversation` renders guest bodies verbatim, so a
// guest whose message begins '## ' would create a false boundary. Every such
// case is caught and returned as a refusal rather than silently producing a
// mangled prompt, because a measurement arm that quietly differs in more than
// one variable is worse than a missing arm (TAC-423's INVALID guard, same
// reasoning).

/** The block this moves. Anchored on the header runtimeToProse renders. */
export const INTENTIONS_HEADER = "## What you're hoping to get to"

/** Where it moves to: immediately before this block when present. */
export const EMOJI_HEADER = '## Emoji for this message'

/** The prompt's final line, and the anchor for "before the tail". */
export const GENERATE_LINE = 'Generate the message now.'

function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type MoveResult =
  | { ok: true; prompt: string }
  | { ok: false; reason: string }

/**
 * Split a composed user prompt into its blocks, keeping each block whole.
 *
 * The final element carries the trailing non-block tail ("Guest name: ...",
 * "The guest just sent: ...", the generate line), because the tail has no
 * heading to split on.
 */
export function splitPromptBlocks(userPrompt: string): string[] {
  return userPrompt.split(/\n\n(?=## )/)
}

/**
 * Move the intentions block to just before the emoji directive, or, when no
 * directive rendered, to just before the prompt's trailing tail.
 *
 * Refuses rather than guesses when the prompt does not have the shape this
 * expects. Each refusal reason names what was wrong so a run log says why a
 * unit was dropped.
 */
export function moveIntentionBlockLate(userPrompt: string): MoveResult {
  // WHOLE-LINE matching, not substring, and the first version of this got it
  // wrong in a way its own test caught. A substring count treats a guest body
  // rendering "## What you're hoping to get to was what they typed" as a hit,
  // and the split below treats that line as a block boundary too, so the
  // forged line was found, moved, and the refusal written for it was
  // unreachable. Requiring the header to BE the line distinguishes the real
  // block (header alone on its line) from any body that merely quotes it.
  // Derived from INTENTIONS_HEADER rather than re-typed, so renaming the
  // constant cannot silently make this guard match nothing. Found in review.
  const headerLine = new RegExp(`^${escapeForRegex(INTENTIONS_HEADER)}$`, 'gm')
  const wholeLineHits = (userPrompt.match(headerLine) ?? []).length
  if (wholeLineHits !== 1) {
    return {
      ok: false,
      reason: `intentions header appeared as a whole line ${wholeLineHits} times, expected 1`,
    }
  }
  if (!userPrompt.includes(GENERATE_LINE)) {
    return { ok: false, reason: `prompt does not contain ${JSON.stringify(GENERATE_LINE)}` }
  }

  const parts = splitPromptBlocks(userPrompt)
  const from = parts.findIndex(
    (p) => p === INTENTIONS_HEADER || p.startsWith(`${INTENTIONS_HEADER}\n`),
  )
  if (from === -1) {
    // The header is on its own line but not at the start of a block, so
    // something in a rendered body produced it (a multi-line guest message
    // whose own second line is exactly the header, with no blank line before
    // it, does not create a split). Refuse: moving it would cut a block in half.
    return {
      ok: false,
      reason: 'intentions header is not at a block boundary (a rendered body probably contains it)',
    }
  }

  const block = parts[from]
  const rest = [...parts.slice(0, from), ...parts.slice(from + 1)]

  const emojiAt = rest.findIndex((p) => p.startsWith(EMOJI_HEADER))
  if (emojiAt !== -1) {
    rest.splice(emojiAt, 0, block)
    return { ok: true, prompt: rest.join('\n\n') }
  }

  // No emoji directive this turn, so the block goes before the tail the final
  // element carries.
  //
  // THE CUT IS ANCHORED ON THE TAIL, NOT ON THE FIRST BLANK LINE, and the first
  // version got this wrong in a way its own tests could not see. It cut at
  // `last.indexOf('\n\n')`, which assumes the final block has no internal blank
  // line. `formatRecentConversation` appends the unsent-history note after one,
  // and `formatGuestContext` and `formatPendingQuestion` both contain them. So
  // with no emoji directive and one unsent line in the history, the block was
  // spliced BETWEEN the conversation and its own note, silently, returning
  // ok: true. Reachable with no guest weirdness at all: resolveEmojiDirective
  // returns null for both `never` and `sparingly`, so two of the three emoji
  // policies render no directive. Found in review.
  //
  // THE SEPARATOR IS THE SECOND-TO-LAST BLANK LINE, and this is derivable rather
  // than guessed. runtimeToProse builds the final element as
  // `<lastBlock>\n\n<tailLines>\n\nGenerate the message now.`, and the tail's
  // lines are single lines joined by \n, so the TAIL always contributes exactly
  // one blank line and it is always the last one. Whatever internal blank lines
  // the last block has come before the separator. So the separator is the blank
  // line immediately before the tail's own.
  //
  // Two earlier versions of this guessed and both were wrong. The first cut at
  // the FIRST blank line, which splices into any final block that has one
  // (`formatRecentConversation`'s unsent-history note, `formatGuestContext`,
  // `formatPendingQuestion`) and returned ok: true while orphaning the note onto
  // the intentions block. The second cut at the last blank line BEFORE the
  // generate line, which lands inside the tail itself, because the tail has one.
  // That one was caught by the test written for the first. Both are why this is
  // derived from the known structure rather than from a heuristic.
  if (rest.length === 0) {
    return { ok: false, reason: 'the intentions block was the only block in the prompt' }
  }
  const last = rest[rest.length - 1]
  if (!last.includes(GENERATE_LINE)) {
    return { ok: false, reason: 'the final element does not carry the generate line' }
  }
  const tailBlank = last.lastIndexOf('\n\n')
  const cut = tailBlank === -1 ? -1 : last.lastIndexOf('\n\n', tailBlank - 1)
  if (cut === -1) {
    return { ok: false, reason: 'the final element carries no block/tail boundary' }
  }
  const finalBlock = last.slice(0, cut)
  const tail = last.slice(cut + 2)
  rest[rest.length - 1] = `${finalBlock}\n\n${block}\n\n${tail}`
  return { ok: true, prompt: rest.join('\n\n') }
}
