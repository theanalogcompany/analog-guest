import { describe, expect, it } from 'vitest'

import {
  CommitmentEmissionSchema,
  GuestCommitmentRowSchema,
  PendingCommitmentSchema,
  generateCommitmentCode,
  isEmptyArrivalCapture,
  isEmptyCommitmentEmission,
  pendingFromEmission,
  toActiveCommitment,
} from './guest-commitment'

describe('isEmptyCommitmentEmission', () => {
  it('treats the no-op shape `{}` as empty', () => {
    expect(isEmptyCommitmentEmission({})).toBe(true)
  })

  it('treats type-only emission as empty (not actionable without description)', () => {
    expect(isEmptyCommitmentEmission({ type: 'comp' })).toBe(true)
  })

  it('treats description-only emission as empty (not actionable without type)', () => {
    expect(isEmptyCommitmentEmission({ description: 'oat latte' })).toBe(true)
  })

  it('treats whitespace-only description as empty', () => {
    expect(isEmptyCommitmentEmission({ type: 'comp', description: '   ' })).toBe(
      true,
    )
  })

  it('treats a fully-formed emission as non-empty', () => {
    expect(
      isEmptyCommitmentEmission({ type: 'comp', description: 'oat latte' }),
    ).toBe(false)
  })
})

describe('isEmptyArrivalCapture', () => {
  it('treats `{}` as empty', () => {
    expect(isEmptyArrivalCapture({})).toBe(true)
  })

  it('treats signal-without-reference as empty', () => {
    expect(isEmptyArrivalCapture({ signal: 'imminent' })).toBe(true)
  })

  it('treats reference-without-signal as empty', () => {
    expect(
      isEmptyArrivalCapture({ referencesCommitmentId: 'abc-123' }),
    ).toBe(true)
  })

  it('treats whitespace-only commitment id as empty', () => {
    expect(
      isEmptyArrivalCapture({ signal: 'imminent', referencesCommitmentId: '  ' }),
    ).toBe(true)
  })

  it('treats a fully-formed capture as non-empty', () => {
    expect(
      isEmptyArrivalCapture({
        signal: 'scheduled',
        expectedArrival: '2026-05-29T08:00:00Z',
        referencesCommitmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).toBe(false)
  })
})

describe('CommitmentEmissionSchema', () => {
  it('parses the no-op shape', () => {
    const parsed = CommitmentEmissionSchema.safeParse({})
    expect(parsed.success).toBe(true)
  })

  it('strips unknown keys (permissive)', () => {
    const parsed = CommitmentEmissionSchema.safeParse({
      type: 'comp',
      description: 'oat latte',
      unknownKey: 'wat',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect('unknownKey' in parsed.data).toBe(false)
    }
  })

  it('rejects an invalid type enum value', () => {
    const parsed = CommitmentEmissionSchema.safeParse({
      type: 'freebie',
      description: 'oat latte',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('generateCommitmentCode', () => {
  it('returns a 4-char alphanumeric string', () => {
    const code = generateCommitmentCode()
    expect(code).toMatch(/^[A-Z2-9]{4}$/)
    expect(code.length).toBe(4)
  })

  it('excludes visually-confusable characters (0, O, 1, I, L)', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCommitmentCode()
      expect(code).not.toMatch(/[01OIL]/)
    }
  })
})

describe('pendingFromEmission', () => {
  it('returns null for a no-op emission', () => {
    expect(pendingFromEmission({})).toBeNull()
  })

  it('returns null when description is whitespace-only', () => {
    expect(pendingFromEmission({ type: 'comp', description: '  ' })).toBeNull()
  })

  it('generates a code for comp when emission omits one', () => {
    const out = pendingFromEmission({ type: 'comp', description: 'oat latte' })
    expect(out).not.toBeNull()
    expect(out?.code).toMatch(/^[A-Z2-9]{4}$/)
  })

  it('generates a code for hold when emission omits one', () => {
    const out = pendingFromEmission({
      type: 'hold',
      description: 'almond croissant',
    })
    expect(out?.code).toMatch(/^[A-Z2-9]{4}$/)
  })

  it('generates a code for discount when emission omits one', () => {
    const out = pendingFromEmission({ type: 'discount', description: '15% off' })
    expect(out?.code).toMatch(/^[A-Z2-9]{4}$/)
  })

  it('preserves an emission-provided code (trimmed)', () => {
    const out = pendingFromEmission({
      type: 'comp',
      description: 'oat latte',
      code: '  7K2P  ',
    })
    expect(out?.code).toBe('7K2P')
  })

  it('returns null code for recommendation type', () => {
    const out = pendingFromEmission({
      type: 'recommendation',
      description: 'the duck confit',
    })
    expect(out?.code).toBeNull()
  })

  it('trims description', () => {
    const out = pendingFromEmission({
      type: 'comp',
      description: '  oat latte  ',
    })
    expect(out?.description).toBe('oat latte')
  })

  it('passes through expiresAt when present', () => {
    const out = pendingFromEmission({
      type: 'hold',
      description: 'croissant',
      expiresAt: '2026-05-29T18:00:00Z',
    })
    expect(out?.expiresAt).toBe('2026-05-29T18:00:00Z')
  })

  it('returns null expiresAt when absent', () => {
    const out = pendingFromEmission({ type: 'comp', description: 'oat latte' })
    expect(out?.expiresAt).toBeNull()
  })
})

describe('PendingCommitmentSchema', () => {
  it('round-trips a fully-formed pending commitment', () => {
    const pending = {
      type: 'comp' as const,
      description: 'oat latte',
      code: '7K2P',
      expiresAt: null,
    }
    const parsed = PendingCommitmentSchema.safeParse(pending)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual(pending)
  })

  it('rejects a description-less shape (description is required at jsonb boundary)', () => {
    const parsed = PendingCommitmentSchema.safeParse({
      type: 'comp',
      code: '7K2P',
      expiresAt: null,
    })
    expect(parsed.success).toBe(false)
  })
})

describe('toActiveCommitment', () => {
  const baseRow = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    guest_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    venue_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    type: 'comp' as const,
    description: 'oat latte',
    code: '7K2P',
    expected_arrival: null,
    arrival_signal: null,
    created_by: 'agent' as const,
    expires_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    redeemed_at: null,
    source_message_id: null,
    created_at: '2026-05-28T12:00:00Z',
    updated_at: '2026-05-28T12:00:00Z',
  }

  it('projects an open row to ActiveCommitment shape', () => {
    const out = toActiveCommitment({ ...baseRow, status: 'open' })
    expect(out).toEqual({
      id: baseRow.id,
      type: 'comp',
      description: 'oat latte',
      code: '7K2P',
      status: 'open',
      expected_arrival: null,
      arrival_signal: null,
      created_at: '2026-05-28T12:00:00Z',
    })
  })

  it('projects a pending_ack row', () => {
    const out = toActiveCommitment({ ...baseRow, status: 'pending_ack' })
    expect(out?.status).toBe('pending_ack')
  })

  it('returns null for acknowledged status', () => {
    expect(toActiveCommitment({ ...baseRow, status: 'acknowledged' })).toBeNull()
  })

  it('returns null for cancelled / expired / redeemed', () => {
    expect(toActiveCommitment({ ...baseRow, status: 'cancelled' })).toBeNull()
    expect(toActiveCommitment({ ...baseRow, status: 'expired' })).toBeNull()
    expect(toActiveCommitment({ ...baseRow, status: 'redeemed' })).toBeNull()
  })
})

describe('GuestCommitmentRowSchema', () => {
  it('round-trips a full row from the DB', () => {
    const row = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      guest_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      venue_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'hold' as const,
      description: 'almond croissant',
      code: 'X3MN',
      status: 'pending_ack' as const,
      expected_arrival: '2026-05-29T08:00:00Z',
      arrival_signal: 'scheduled' as const,
      created_by: 'agent' as const,
      expires_at: null,
      acknowledged_at: null,
      acknowledged_by: null,
      redeemed_at: null,
      source_message_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      created_at: '2026-05-28T12:00:00Z',
      updated_at: '2026-05-28T12:00:00Z',
    }
    const parsed = GuestCommitmentRowSchema.safeParse(row)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual(row)
  })
})
