import { V2_PROMPT_VERSION } from './template'
import type {
  ComposedPrompt,
  ComposedSystemBlock,
  ComposedTurn,
} from './compose'

// The composed prompt as ONE editable document, and back.
//
// WHY A TEXT ROUND TRIP AND NOT A FORM. `TurnOverrides` already replaces
// rendered sections wholesale, and that covers every input the composer
// INTERPOLATES - but not the frame around them, not the hard lines, not the
// section order, and not the transcript. Those are the units an ablation most
// often lands on (`.claude/skills/ablate-a-bad-reply`, step 4 says the only way
// to ablate the frame today is to edit `lib/ai/prompts/` locally and revert),
// and a human cannot try one without a deploy. Serializing the whole thing
// makes every byte that reaches the model editable in the playground, which is
// what was asked for.
//
// WHAT AN EDITED PROMPT IS NOT. It is not version V2_PROMPT_VERSION. A trace
// stamped with the template version for a prompt that no template produced is
// the exact defect class this repo keeps paying for - a claim nothing
// enforces, which is then read as fact by `eval_judgments`, the regression
// harness and the golden set, all of which key their rows to that string. So
// `parsePromptText` stamps `HAND_EDITED_SUFFIX` and nothing can quietly
// un-stamp it: the version is derived from the parse, not passed in.
//
// FAILS CLOSED on anything it cannot parse. Direction is a decision
// (`.claude/rules/errors-as-values.md`): the alternative is running a turn
// against a prompt that differs from what the operator is looking at, and then
// reasoning about the reply. A refused parse costs one retype. A silently
// dropped block costs a wrong conclusion about the agent, which is the thing
// this surface exists to produce.

/**
 * Appended to the template version when a turn ran on hand-edited text.
 *
 * Read it rather than comparing against `V2_PROMPT_VERSION`: the point is that
 * an edited prompt is NOT the version it started from, and a reader asking
 * "which template produced this" needs the answer to be "none".
 */
export const HAND_EDITED_SUFFIX = '+hand-edited'

export function isHandEdited(promptVersion: string): boolean {
  return promptVersion.endsWith(HAND_EDITED_SUFFIX)
}

/**
 * The HOUSE NOTES label, matched EXACTLY on the way back in.
 *
 * `ComposedPrompt.guestState` is handed to the judge as `situationBrief`, and
 * its own docstring records what happened when a caller recovered it
 * positionally instead - it silently returned the guest's own message. A label
 * match has the same hazard in a different shape: an operator who renames the
 * header gets an empty brief. That is why the parse returns
 * `houseNotesFound` rather than defaulting, so the caller can refuse instead
 * of the judge quietly scoring against nothing.
 */
const HOUSE_NOTES_LABEL = 'HOUSE NOTES'

const SYSTEM_PREFIX = 'SYSTEM: '
const CACHE_FLAG = ' | cache breakpoint'

/**
 * A header line. `<<<` and `>>>` rather than `===` or `---`, because the
 * prompt itself contains markdown rules and `#` headings, and a delimiter a
 * prompt could plausibly contain is a delimiter that will one day eat a
 * section. Nothing in `lib/ai/prompts/` or any rendered section uses angle
 * triples - checked, not assumed.
 */
function header(text: string, cache: boolean): string {
  return `<<< ${text}${cache ? CACHE_FLAG : ''} >>>`
}

const HEADER_RE = /^<<< (.+?) >>>$/

/**
 * A body line that would be read back as a delimiter, escaped with a leading
 * backslash. Already-escaped lines gain one more, which is what makes it
 * reversible rather than lossy at the second round trip.
 *
 * THIS IS NOT HYPOTHETICAL. The transcript blocks carry the guest's own words
 * verbatim, and they are arbitrary text. The first round-trip check written
 * for this module put `<<< GUEST >>>` inside an assistant turn and the parser
 * silently split one turn into two, shifting every turn after it by one - the
 * guest's message ended up attributed to the venue. A format whose own test
 * can produce that is not a format to ship on the grounds that our copy
 * happens not to collide today.
 */
const ESCAPABLE_RE = /^(\\*)(<<< .+? >>>)$/

function escapeBody(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(ESCAPABLE_RE, '\\$1$2'))
    .join('\n')
}

function unescapeLine(line: string): string {
  const m = ESCAPABLE_RE.exec(line)
  return m === null || m[1] === '' ? line : `${m[1].slice(1)}${m[2]}`
}

/**
 * ComposedPrompt to one document, in the order the model receives it.
 *
 * Round-trips byte for byte through `parsePromptText` - checked against a
 * prompt carrying a delimiter-shaped line inside a turn, which is the case
 * that breaks a naive version of this. Two things are deliberately NOT carried
 * in the text:
 *
 * - `promptCharCount` and `promptVersion` are DERIVED on the way back.
 *   Carrying them would let them disagree with the bytes above them, and a
 *   stale char count on an edited prompt is a number a reader would trust.
 * - a block body's TRAILING blank lines, which are indistinguishable from the
 *   separator this puts between blocks. Nothing composed ends in one.
 */
export function promptToText(
  prompt: Pick<ComposedPrompt, 'system' | 'turns'>,
): string {
  const parts = [
    ...prompt.system.map((b) =>
      [
        header(`${SYSTEM_PREFIX}${b.label}`, b.cacheBreakpoint),
        escapeBody(b.text),
      ].join('\n'),
    ),
    ...prompt.turns.map((t) =>
      [
        header(
          t.role === 'user' ? 'GUEST' : 'VENUE',
          t.cacheBreakpoint === true,
        ),
        escapeBody(t.text),
      ].join('\n'),
    ),
  ]
  return parts.join('\n\n')
}

export type PromptTextParse =
  | { ok: true; prompt: ComposedPrompt; houseNotesFound: boolean }
  | { ok: false; error: string }

/**
 * One document back to a ComposedPrompt, or a refusal naming the line.
 *
 * Four things are REFUSED rather than repaired, each because repairing it
 * would send the model something other than what is on screen:
 *
 * - text before the first header - it belongs to no block, so it would vanish
 * - an unrecognised header - a typo in `GUSET` would silently drop a turn
 * - a system block after a turn - the SDK hoists system blocks above all
 *   messages, so the document would no longer be in the order it claims
 * - no blocks at all
 *
 * An EMPTY block body is allowed: deleting a section's contents while keeping
 * its header is a legitimate ablation arm, and it is the one this module exists
 * to make possible.
 */
export function parsePromptText(text: string): PromptTextParse {
  const lines = text.split('\n')
  const system: ComposedSystemBlock[] = []
  const turns: ComposedTurn[] = []
  let current:
    | { kind: 'system'; label: string; cache: boolean; body: string[] }
    | {
        kind: 'turn'
        role: 'user' | 'assistant'
        cache: boolean
        body: string[]
      }
    | null = null

  const flush = (): void => {
    if (current === null) return
    // Trailing blank lines are the blank line this serializer PUT between
    // blocks; a leading one is not, so only the tail is trimmed.
    const body = current.body.join('\n').replace(/\n+$/, '')
    if (current.kind === 'system')
      system.push({
        label: current.label,
        text: body,
        cacheBreakpoint: current.cache,
      })
    else
      turns.push({
        role: current.role,
        text: body,
        ...(current.cache ? { cacheBreakpoint: true } : {}),
      })
    current = null
  }

  for (const [i, line] of lines.entries()) {
    const match = HEADER_RE.exec(line)
    if (match === null) {
      if (current === null) {
        if (line.trim() === '') continue
        return {
          ok: false,
          error: `line ${i + 1}: text before the first <<< ... >>> header`,
        }
      }
      current.body.push(unescapeLine(line))
      continue
    }
    flush()
    let name = match[1]
    const cache = name.endsWith(CACHE_FLAG)
    if (cache) name = name.slice(0, -CACHE_FLAG.length)
    if (name.startsWith(SYSTEM_PREFIX)) {
      if (turns.length > 0)
        return {
          ok: false,
          error: `line ${i + 1}: a SYSTEM block cannot follow a GUEST or VENUE turn - the provider puts every system block in front of every turn, so the order on screen would not be the order sent`,
        }
      current = {
        kind: 'system',
        label: name.slice(SYSTEM_PREFIX.length),
        cache,
        body: [],
      }
      continue
    }
    if (name === 'GUEST' || name === 'VENUE') {
      current = {
        kind: 'turn',
        role: name === 'GUEST' ? 'user' : 'assistant',
        cache,
        body: [],
      }
      continue
    }
    return {
      ok: false,
      error: `line ${i + 1}: unknown header "${match[1]}" - expected "SYSTEM: <label>", "GUEST" or "VENUE", each optionally followed by "${CACHE_FLAG.trim()}"`,
    }
  }
  flush()

  if (system.length === 0 && turns.length === 0)
    return { ok: false, error: 'no <<< ... >>> blocks found' }

  const houseNotes = system.find((b) => b.label === HOUSE_NOTES_LABEL)
  return {
    ok: true,
    houseNotesFound: houseNotes !== undefined,
    prompt: {
      system,
      turns,
      // '' rather than a guess. The judge gets an empty brief and the caller
      // is told why by `houseNotesFound`; inventing one would score the reply
      // against notes the model never read.
      guestState: houseNotes?.text ?? '',
      promptCharCount:
        system.reduce((n, b) => n + b.text.length, 0) +
        turns.reduce((n, t) => n + t.text.length, 0),
      promptVersion: `${V2_PROMPT_VERSION}${HAND_EDITED_SUFFIX}`,
    },
  }
}

/**
 * The SYSTEM blocks only - the half of a prompt that is reusable.
 *
 * WHAT THE EDITOR EDITS, and what a saved prompt is: the transcript belongs to
 * the TURN, not to the prompt. The first version of both put the whole
 * document in the textarea, so the guest's own message was editable and a
 * saved prompt carried the conversation it was saved against - two ways to end
 * up reasoning about a reply to a different question than the one on screen.
 * The house blocks are what an ablation is about; the turns are what it is run
 * against, and `spliceSystemBlocks` puts them back at send time.
 *
 * `droppedTurns` counts what was stripped, so a caller can say so.
 */
export function systemTextOf(
  text: string,
):
  | { ok: true; text: string; droppedTurns: number }
  | { ok: false; error: string } {
  const parsed = parsePromptText(text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return {
    ok: true,
    droppedTurns: parsed.prompt.turns.length,
    text: promptToText({ system: parsed.prompt.system, turns: [] }),
  }
}

/**
 * One system block, replaced by LABEL.
 *
 * WHY BLOCKS AND NOT THE WHOLE DOCUMENT. A prompt edit is worth keeping across
 * turns - that is the whole ablation loop, "change one line, try it on six
 * inbounds" - and a whole-document override cannot be kept, because two of the
 * three blocks are not reusable. HOUSE NOTES is rebuilt every turn from
 * retrieval, the guest's state and the mission; pinning the document pins a
 * brief from whenever it was saved, and every later turn is then answered
 * against a stale one with nothing on screen saying so.
 *
 * Replacing by label leaves every block the operator did not touch LIVE. An
 * edit to ROLE is reusable because ROLE is static; an edit to HOUSE NOTES is
 * still possible and is still the operator's call, and the UI says what it
 * costs rather than the format forbidding it.
 */
export interface PromptBlockOverride {
  label: string
  text: string
}

/**
 * Which blocks differ, comparing an edited document against the composed one.
 *
 * REFUSES a changed label SET - a renamed, added or removed block - because
 * replacement is by label and there is nothing to match a renamed block to.
 * Emptying a block's body is the supported way to ablate it, and it survives
 * this comparison as a block whose text is ''.
 */
export function changedBlocks(
  composedText: string,
  editedText: string,
): { ok: true; blocks: PromptBlockOverride[] } | { ok: false; error: string } {
  const composed = parsePromptText(composedText)
  if (!composed.ok) return { ok: false, error: composed.error }
  const edited = parsePromptText(editedText)
  if (!edited.ok) return { ok: false, error: edited.error }

  const composedLabels = composed.prompt.system.map((b) => b.label)
  const editedLabels = edited.prompt.system.map((b) => b.label)
  if (composedLabels.join('\u0000') !== editedLabels.join('\u0000'))
    return {
      ok: false,
      error: `the SYSTEM block labels must stay as they are (${composedLabels.join(', ')}) - they are how an edit is matched to a block on a later turn. To ablate a block, empty its body and keep its header.`,
    }

  const blocks: PromptBlockOverride[] = []
  for (const [i, block] of edited.prompt.system.entries()) {
    const before = composed.prompt.system[i]
    if (before.text !== block.text)
      blocks.push({ label: block.label, text: block.text })
  }
  return { ok: true, blocks }
}

/**
 * Block overrides applied to a freshly composed prompt.
 *
 * FAILS CLOSED on a label the prompt does not carry. A stored override naming
 * a block that has since been renamed in the template would otherwise be
 * silently ignored, and the operator would read a reply from an un-ablated
 * prompt as the result of their ablation.
 *
 * `guestState` is recomputed from whatever now carries the HOUSE NOTES label,
 * so the judge is handed the brief the model actually read rather than the one
 * the composer built.
 */
export function applyPromptBlocks(
  prompt: ComposedPrompt,
  blocks: readonly PromptBlockOverride[],
): { ok: true; prompt: ComposedPrompt } | { ok: false; error: string } {
  const labels = new Set(prompt.system.map((b) => b.label))
  const unknown = blocks.filter((b) => !labels.has(b.label))
  if (unknown.length > 0)
    return {
      ok: false,
      error: `no SYSTEM block is labelled ${unknown.map((b) => `"${b.label}"`).join(', ')} - the prompt carries ${[...labels].join(', ')}`,
    }

  const system = prompt.system.map((block) => {
    const override = blocks.find((b) => b.label === block.label)
    return override === undefined ? block : { ...block, text: override.text }
  })
  const houseNotes = system.find((b) => b.label === HOUSE_NOTES_LABEL)
  return {
    ok: true,
    prompt: {
      ...prompt,
      system,
      guestState: houseNotes?.text ?? '',
      promptCharCount:
        system.reduce((n, b) => n + b.text.length, 0) +
        prompt.turns.reduce((n, t) => n + t.text.length, 0),
      promptVersion: `${V2_PROMPT_VERSION}${HAND_EDITED_SUFFIX}`,
    },
  }
}

/**
 * Every system block collapsed into ONE, carrying the operator's text.
 *
 * WHAT THIS GIVES UP, stated because the composer's own header argues the
 * other way (lib/ai/v2/compose.ts): the three blocks are ordered
 * volatility-ascending so a cache breakpoint can sit after the stable half.
 * One block has no stable half. On a surface that sends the SAME text for
 * every question - the prompt lab's sweep - that costs nothing, and in fact
 * caches better than the default, because the default's HOUSE NOTES varies per
 * question while this is byte-identical across all of them. On a surface where
 * the per-turn block really does change, it would re-read the whole prefix
 * every turn. Which surface this is, is the caller's to know.
 *
 * `guestState` is kept AS COMPOSED rather than recomputed. There is no HOUSE
 * NOTES block left to read it back out of, and the judge scores a reply
 * against the brief - handing it an empty one would mark every reply down for
 * not using facts it was never shown. So the judge reads the composer's brief
 * while the model read the operator's text, and the trace carries both.
 */
export function replaceSystemText(
  prompt: ComposedPrompt,
  text: string,
): ComposedPrompt {
  return {
    ...prompt,
    system: [{ label: 'SYSTEM', text, cacheBreakpoint: true }],
    promptCharCount:
      text.length + prompt.turns.reduce((n, t) => n + t.text.length, 0),
    promptVersion: `${V2_PROMPT_VERSION}${HAND_EDITED_SUFFIX}`,
  }
}
