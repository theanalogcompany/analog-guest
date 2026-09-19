import { describe, expect, it } from 'vitest'

import { INSTAGRAM_MAX_TEXT_BYTES, classifySendFailure } from '@/lib/messaging/instagram/send'
import {
  CAP_VERDICT_BLOCKER_KINDS,
  capVerdictBlocker,
  idForLog,
  parseSmokeArgs,
  textOfBytes,
} from './instagram-smoke'

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

describe('capVerdictBlocker', () => {
  // The bug this exists for. A run 25 minutes outside the reply window read
  // Meta's code 10 as a size refusal and reported a PASS on the over-cap probe
  // and a FAIL on the at-cap send, advising a lower INSTAGRAM_MAX_TEXT_BYTES.
  it('blocks a cap verdict when the reply window was shut', () => {
    expect(capVerdictBlocker('window_closed')).toBe('the 24-hour reply window was shut')
  })

  // Meta's window refusal reaches the over-cap probe as a raw GraphFailure, so
  // the probe classifies it through the transport's own classifier first. This
  // is the exact failure the first run misread, spelled the way it arrives.
  it('blocks a cap verdict for the code 10 / subcode 2534022 the probe receives', () => {
    const kind = classifySendFailure({
      reason: 'graph_error',
      httpStatus: 400,
      code: 10,
      subcode: 2534022,
      type: 'OAuthException',
      fbtraceId: null,
    })
    expect(kind).toBe('window_closed')
    expect(capVerdictBlocker(kind)).not.toBeNull()
  })

  it('permits a cap verdict only for an unrecognised Graph error, the shape a size refusal arrives in', () => {
    expect(capVerdictBlocker('graph_error')).toBeNull()
  })

  // Every other cause refuses 1000 bytes and 1001 bytes identically, so none of
  // them is evidence about where the line is.
  it.each([
    'token_rejected',
    'rate_limited',
    'recipient_unavailable',
    'timeout',
    'network',
    'malformed_response',
    'empty_text',
    'over_byte_cap',
  ] as const)('blocks a cap verdict for %s', (kind) => {
    expect(capVerdictBlocker(kind)).not.toBeNull()
  })

  // The map is total at compile time; this is the review prompt that a new
  // failure kind has to be decided about rather than defaulted.
  it('covers every send failure kind, and only those', () => {
    expect([...CAP_VERDICT_BLOCKER_KINDS].sort()).toEqual(
      [
        'empty_text',
        'graph_error',
        'malformed_response',
        'network',
        'over_byte_cap',
        'rate_limited',
        'recipient_unavailable',
        'timeout',
        'token_rejected',
        'window_closed',
      ].sort(),
    )
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
