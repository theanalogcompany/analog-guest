import { describe, expect, it } from 'vitest'

import {
  EMOJI_HEADER,
  GENERATE_LINE,
  INTENTIONS_HEADER,
  moveIntentionBlockLate,
  splitPromptBlocks,
} from './intention-block-move'

// The shape runtimeToProse produces: blocks joined with '\n\n', then the tail.
// The intentions block deliberately carries internal blank lines, because that
// is what makes a naive split on '\n\n' wrong and is the whole reason this
// module exists.
const INTENTIONS_BLOCK = [
  INTENTIONS_HEADER,
  "you don't know this guest's name yet",
  '',
  "These are things you'd like to get to, not a checklist to work through.",
  '',
  'If nothing fits, let it wait.',
].join('\n')

const TAIL = ['Guest name: Sam', 'The guest just sent: "hey"', '', GENERATE_LINE].join('\n')

function promptOf(blocks: readonly string[]): string {
  return `${blocks.join('\n\n')}\n\n${TAIL}`
}

describe('splitPromptBlocks', () => {
  it('keeps a block with internal blank lines whole', () => {
    const parts = splitPromptBlocks(promptOf(['## Right now\nit is 9am', INTENTIONS_BLOCK]))
    expect(parts).toHaveLength(2)
    expect(parts[1]).toContain('If nothing fits, let it wait.')
    // The tail rides on the final element, which has no heading to split on.
    expect(parts[1]).toContain(GENERATE_LINE)
  })

  it('splits only where a heading follows the blank line', () => {
    // A naive split on '\n\n' would return 5 here.
    expect(splitPromptBlocks(promptOf([INTENTIONS_BLOCK]))).toHaveLength(1)
  })
})

describe('moveIntentionBlockLate', () => {
  it('moves the block to immediately before the emoji directive', () => {
    const prompt = promptOf([
      '## Right now\nit is 9am',
      INTENTIONS_BLOCK,
      '## Recent conversation\n[2h ago] guest: hey',
      `${EMOJI_HEADER}\nno emoji this message`,
    ])
    const r = moveIntentionBlockLate(prompt)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.prompt.indexOf('## Recent conversation')).toBeLessThan(
      r.prompt.indexOf(INTENTIONS_HEADER),
    )
    expect(r.prompt.indexOf(INTENTIONS_HEADER)).toBeLessThan(r.prompt.indexOf(EMOJI_HEADER))
  })

  it('moves the block before the tail when no emoji directive rendered', () => {
    const prompt = promptOf([
      '## Right now\nit is 9am',
      INTENTIONS_BLOCK,
      '## Recent conversation\n[2h ago] guest: hey',
    ])
    const r = moveIntentionBlockLate(prompt)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.prompt.indexOf('## Recent conversation')).toBeLessThan(
      r.prompt.indexOf(INTENTIONS_HEADER),
    )
    expect(r.prompt.indexOf(INTENTIONS_HEADER)).toBeLessThan(r.prompt.indexOf('Guest name: Sam'))
    expect(r.prompt.endsWith(GENERATE_LINE)).toBe(true)
  })

  it('preserves every byte of the block, including its internal blank lines', () => {
    const prompt = promptOf(['## Right now\nit is 9am', INTENTIONS_BLOCK, `${EMOJI_HEADER}\nnone`])
    const r = moveIntentionBlockLate(prompt)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.prompt).toContain(INTENTIONS_BLOCK)
  })

  it('changes nothing but order: the moved prompt is a permutation of the same blocks', () => {
    const blocks = ['## Right now\nit is 9am', INTENTIONS_BLOCK, `${EMOJI_HEADER}\nnone`]
    const r = moveIntentionBlockLate(promptOf(blocks))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Same multiset of blocks, same tail, different order.
    expect(splitPromptBlocks(r.prompt).sort()).toEqual(splitPromptBlocks(promptOf(blocks)).sort())
  })

  it('refuses when the block is absent', () => {
    const r = moveIntentionBlockLate(promptOf(['## Right now\nit is 9am']))
    expect(r).toEqual({
      ok: false,
      reason: 'intentions header appeared as a whole line 0 times, expected 1',
    })
  })

  it('refuses when the header appears twice', () => {
    const r = moveIntentionBlockLate(promptOf([INTENTIONS_BLOCK, INTENTIONS_BLOCK]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('whole line 2 times')
  })

  // THE TWO CASES THE ASSUMPTION RESTS ON. A guest can text anything, and
  // formatRecentConversation renders bodies verbatim, so a body can put text at
  // column 0. Both must refuse, not mangle. The first version of this file
  // asserted a refusal that could not fire, which is how the whole-line rule
  // was found.
  it('refuses when a guest body quotes the header with trailing text', () => {
    const forged = [
      '## Recent conversation',
      '[2h ago] guest: hey',
      '',
      `${INTENTIONS_HEADER} was what they typed`,
    ].join('\n')
    const r = moveIntentionBlockLate(promptOf(['## Right now\nit is 9am', forged]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    // Not a whole-line match, so the real block is the only whole-line hit...
    // and here there is no real block at all, so the count is 0.
    expect(r.reason).toContain('whole line 0 times')
  })

  it('refuses when the only whole-line header sits mid-block', () => {
    // A multi-line guest body whose second line is exactly the header, with no
    // blank line before it, so no split boundary is created.
    const forged = ['## Recent conversation', '[2h ago] guest: hey', INTENTIONS_HEADER].join('\n')
    const r = moveIntentionBlockLate(promptOf(['## Right now\nit is 9am', forged]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('not at a block boundary')
  })

  it('refuses a prompt with no generate line', () => {
    const r = moveIntentionBlockLate(`## Right now\nit is 9am\n\n${INTENTIONS_BLOCK}`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('Generate the message now.')
  })

  it('refuses when the intentions block is the only block', () => {
    const r = moveIntentionBlockLate(`${INTENTIONS_BLOCK}\n\n${TAIL}`)
    expect(r).toEqual({
      ok: false,
      reason: 'the intentions block was the only block in the prompt',
    })
  })
})
