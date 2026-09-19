import { describe, expect, it } from 'vitest'

import { INSTAGRAM_MAX_TEXT_BYTES } from '@/lib/messaging/instagram/send'
import { idForLog, parseSmokeArgs, textOfBytes } from './instagram-smoke-text'

describe('textOfBytes', () => {
  // Check B asks Meta where the line is. A message one byte out asks a
  // different question and answers it confidently.
  it('builds exactly the requested number of bytes, at the cap and one over', () => {
    for (const bytes of [INSTAGRAM_MAX_TEXT_BYTES, INSTAGRAM_MAX_TEXT_BYTES + 1]) {
      const text = textOfBytes(bytes, 'analog smoke test')
      expect(Buffer.byteLength(text, 'utf8')).toBe(bytes)
    }
  })

  it('opens with the label, so a person reading the thread knows what it is', () => {
    expect(textOfBytes(100, 'analog smoke test 2 of 3')).toMatch(/^analog smoke test 2 of 3 a+$/)
  })

  it('is ASCII, so the byte count is the thing under test and not the label', () => {
    const text = textOfBytes(200, 'analog smoke test')
    expect(text.length).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('refuses rather than build a message of the wrong length', () => {
    expect(() => textOfBytes(5, 'a label far longer than five bytes')).toThrow(/longer than 5 bytes/)
  })
})

describe('parseSmokeArgs', () => {
  it('reads the venue, the guest and both flags', () => {
    expect(parseSmokeArgs(['--venue', 'le-mils-coffee', '--guest', 'g-1', '--confirm', '--show-ids'])).toEqual({
      venue: 'le-mils-coffee',
      guest: 'g-1',
      confirm: true,
      showIds: true,
    })
  })

  // Both default to off: the script sends real messages, and prints no mid.
  it('defaults both flags off', () => {
    expect(parseSmokeArgs(['--venue', 'v', '--guest', 'g'])).toEqual({
      venue: 'v',
      guest: 'g',
      confirm: false,
      showIds: false,
    })
  })

  it('leaves the venue and guest undefined when they are missing, so the script can refuse', () => {
    expect(parseSmokeArgs(['--confirm'])).toEqual({ confirm: true, showIds: false })
  })
})

describe('idForLog', () => {
  const MID = 'aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE3ODQxNDAwMDAwMDAwMDAx'

  it('prints only the ends by default, so a mid never lands on screen whole', () => {
    const shown = idForLog(MID, false)
    expect(shown).not.toContain(MID)
    expect(shown).toContain(`(${MID.length} chars)`)
  })

  it('prints it whole only when asked, for diagnosing a mismatch', () => {
    expect(idForLog(MID, true)).toBe(MID)
  })
})
