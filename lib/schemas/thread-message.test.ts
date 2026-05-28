import { describe, expect, it } from 'vitest'

import { THREAD_MESSAGE_LIMIT, ThreadMessageSchema } from './thread-message'

describe('ThreadMessageSchema', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

  it('parses a valid inbound message', () => {
    const parsed = ThreadMessageSchema.parse({
      id: VALID_UUID,
      direction: 'inbound',
      body: 'hey are you guys open tomorrow?',
      createdAt: '2026-05-26T18:14:23.000Z',
    })
    expect(parsed.id).toBe(VALID_UUID)
    expect(parsed.direction).toBe('inbound')
  })

  it('parses a valid outbound message', () => {
    const parsed = ThreadMessageSchema.parse({
      id: VALID_UUID,
      direction: 'outbound',
      body: 'we are! 8 to 4 :)',
      createdAt: '2026-05-26T18:14:51.000Z',
    })
    expect(parsed.direction).toBe('outbound')
  })

  it('rejects a non-uuid id', () => {
    expect(() =>
      ThreadMessageSchema.parse({
        id: 'not-a-uuid',
        direction: 'inbound',
        body: 'hi',
        createdAt: '2026-05-26T18:14:23.000Z',
      }),
    ).toThrow()
  })

  it('rejects an unknown direction value', () => {
    expect(() =>
      ThreadMessageSchema.parse({
        id: VALID_UUID,
        direction: 'sideways',
        body: 'hi',
        createdAt: '2026-05-26T18:14:23.000Z',
      }),
    ).toThrow()
  })

  it('rejects a missing createdAt', () => {
    expect(() =>
      ThreadMessageSchema.parse({
        id: VALID_UUID,
        direction: 'inbound',
        body: 'hi',
      }),
    ).toThrow()
  })

  it('rejects a missing body', () => {
    expect(() =>
      ThreadMessageSchema.parse({
        id: VALID_UUID,
        direction: 'inbound',
        createdAt: '2026-05-26T18:14:23.000Z',
      }),
    ).toThrow()
  })

  it('accepts an empty-string body (filter responsibility is upstream)', () => {
    const parsed = ThreadMessageSchema.parse({
      id: VALID_UUID,
      direction: 'inbound',
      body: '',
      createdAt: '2026-05-26T18:14:23.000Z',
    })
    expect(parsed.body).toBe('')
  })
})

describe('THREAD_MESSAGE_LIMIT', () => {
  it('is 200', () => {
    expect(THREAD_MESSAGE_LIMIT).toBe(200)
  })
})
