import { describe, expect, it } from 'vitest'
import { BrandPersonaSchema, VoiceAntiPatternSchema } from './brand-persona'

// THE-236: voiceAntiPatterns reshape. Schema must accept legacy string[] and
// new struct[] shapes interchangeably and normalize both to the struct shape.

const validPersonaBase = {
  tone: 'warm and direct',
  formality: 'casual',
  speakerFraming: 'venue',
  emojiPolicy: 'never',
  lengthGuide: 'short — 1-2 sentences',
} as const

describe('VoiceAntiPatternSchema', () => {
  it('normalizes a legacy string entry to {text, source: manual}', () => {
    const out = VoiceAntiPatternSchema.parse('do not open with Hi [name]!')
    expect(out).toEqual({ text: 'do not open with Hi [name]!', source: 'manual' })
  })

  it('preserves a struct entry with all fields', () => {
    const struct = {
      text: 'no marketing flourishes',
      source: 'auto' as const,
      authorOperatorId: 'd4f6e3a2-1b5c-4f8e-9a7d-2e3f4b5c6d7e',
      addedAt: '2026-05-08T12:00:00.000Z',
    }
    expect(VoiceAntiPatternSchema.parse(struct)).toEqual(struct)
  })

  it('defaults source to manual when only text is provided in a struct', () => {
    const out = VoiceAntiPatternSchema.parse({ text: 'avoid em dashes' })
    expect(out.source).toBe('manual')
    expect(out.text).toBe('avoid em dashes')
  })

  it('rejects empty text', () => {
    expect(VoiceAntiPatternSchema.safeParse('').success).toBe(false)
    expect(VoiceAntiPatternSchema.safeParse({ text: '' }).success).toBe(false)
  })

  it('rejects an unknown source value', () => {
    expect(
      VoiceAntiPatternSchema.safeParse({ text: 'x', source: 'imported' }).success,
    ).toBe(false)
  })

  it('rejects a non-uuid authorOperatorId', () => {
    expect(
      VoiceAntiPatternSchema.safeParse({ text: 'x', authorOperatorId: 'jaipal' }).success,
    ).toBe(false)
  })
})

describe('BrandPersonaSchema voiceAntiPatterns', () => {
  it('accepts a legacy string-array shape and normalizes each entry', () => {
    const parsed = BrandPersonaSchema.parse({
      ...validPersonaBase,
      voiceAntiPatterns: ['no marketing flourishes', 'no closing acknowledgments'],
    })
    expect(parsed.voiceAntiPatterns).toEqual([
      { text: 'no marketing flourishes', source: 'manual' },
      { text: 'no closing acknowledgments', source: 'manual' },
    ])
  })

  it('accepts a struct-array shape and preserves metadata', () => {
    const parsed = BrandPersonaSchema.parse({
      ...validPersonaBase,
      voiceAntiPatterns: [
        {
          text: 'avoid em dashes',
          source: 'auto',
          addedAt: '2026-05-08T12:00:00.000Z',
        },
      ],
    })
    expect(parsed.voiceAntiPatterns).toEqual([
      {
        text: 'avoid em dashes',
        source: 'auto',
        addedAt: '2026-05-08T12:00:00.000Z',
      },
    ])
  })

  it('accepts a mixed legacy + struct array (in-flight migration shape)', () => {
    const parsed = BrandPersonaSchema.parse({
      ...validPersonaBase,
      voiceAntiPatterns: [
        'legacy string entry',
        { text: 'fresh struct entry', source: 'auto' },
      ],
    })
    expect(parsed.voiceAntiPatterns).toEqual([
      { text: 'legacy string entry', source: 'manual' },
      { text: 'fresh struct entry', source: 'auto' },
    ])
  })

  it('defaults voiceAntiPatterns to [] when omitted', () => {
    const parsed = BrandPersonaSchema.parse(validPersonaBase)
    expect(parsed.voiceAntiPatterns).toEqual([])
  })
})
