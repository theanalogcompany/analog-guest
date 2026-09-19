import { describe, expect, it } from 'vitest'
import { applyChannelSubstitutions, copyVariantFor } from './channel-variants'

describe('applyChannelSubstitutions (TAC-495)', () => {
  it('returns the text unchanged with no substitutions', () => {
    expect(applyChannelSubstitutions('texting you', [], 't')).toBe('texting you')
  })

  it('swaps a phrase that appears exactly once', () => {
    expect(
      applyChannelSubstitutions('they are texting you now', [{ from: 'texting', to: 'messaging' }], 't'),
    ).toBe('they are messaging you now')
  })

  it('applies substitutions in order', () => {
    expect(
      applyChannelSubstitutions(
        'a text, then a number',
        [
          { from: 'a text', to: 'a message' },
          { from: 'a number', to: 'an account' },
        ],
        't',
      ),
    ).toBe('a message, then an account')
  })

  // The whole guarantee: a phrase that has drifted out of the source text
  // must break loudly, not leave the SMS copy in the other channel's variant.
  it('throws when the phrase is missing, naming the label and the phrase', () => {
    expect(() =>
      applyChannelSubstitutions('nothing here', [{ from: 'this number', to: 'x' }], 'OPENER/instagram'),
    ).toThrow(/OPENER\/instagram.*found 0.*"this number"/)
  })

  // Twice is as bad as never: one substitution would silently change two
  // places, one of which nobody chose.
  it('throws when the phrase appears more than once', () => {
    expect(() =>
      applyChannelSubstitutions('text and text', [{ from: 'text', to: 'message' }], 't'),
    ).toThrow(/found 2/)
  })

  it('counts non-overlapping occurrences', () => {
    expect(() => applyChannelSubstitutions('aaa', [{ from: 'aa', to: 'b' }], 't')).not.toThrow()
  })

  it('treats a replacement containing $ patterns literally', () => {
    expect(applyChannelSubstitutions('pay here', [{ from: 'here', to: "$& $'" }], 't')).toBe("pay $& $'")
  })
})

describe('copyVariantFor (TAC-495)', () => {
  it('keeps a known channel', () => {
    expect(copyVariantFor('text')).toBe('text')
    expect(copyVariantFor('instagram')).toBe('instagram')
  })

  // Unknown gets the copy that asserts no phone number, never the SMS copy.
  it('maps an unknown channel to the Instagram copy', () => {
    expect(copyVariantFor(null)).toBe('instagram')
  })
})
