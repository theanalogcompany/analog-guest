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
  const wholeLineHits = (userPrompt.match(/^## What you're hoping to get to$/gm) ?? []).length
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

  // No emoji directive this turn, so the block goes before the tail that the
  // final element carries. The tail is whatever follows that element's own
  // first blank line.
  if (rest.length === 0) {
    return { ok: false, reason: 'the intentions block was the only block in the prompt' }
  }
  const last = rest[rest.length - 1]
  const cut = last.indexOf('\n\n')
  if (cut === -1) {
    return { ok: false, reason: 'the final block carries no tail to insert before' }
  }
  const finalBlock = last.slice(0, cut)
  const tail = last.slice(cut + 2)
  rest[rest.length - 1] = `${finalBlock}\n\n${block}\n\n${tail}`
  return { ok: true, prompt: rest.join('\n\n') }
}
