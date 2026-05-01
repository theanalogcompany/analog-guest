import { describe, expect, it } from 'vitest'
import { computeMessageStats, type MessageStatRow } from './compute-message-stats'

const HOUR_MS = 60 * 60 * 1000
const ZERO = new Date('2026-05-01T08:00:00Z')

function at(offsetHours: number, direction: 'inbound' | 'outbound'): MessageStatRow {
  return { direction, createdAt: new Date(ZERO.getTime() + offsetHours * HOUR_MS) }
}

describe('computeMessageStats — counts', () => {
  it('returns zeros for an empty conversation', () => {
    const r = computeMessageStats([])
    expect(r).toEqual({
      totalMessages: 0,
      outboundCount: 0,
      inboundCount: 0,
      repliedCount: 0,
      responseRatePct: 0,
      responseWindowHours: 24,
    })
  })

  it('counts inbound + outbound separately', () => {
    const r = computeMessageStats([at(0, 'outbound'), at(1, 'inbound'), at(2, 'outbound')])
    expect(r.outboundCount).toBe(2)
    expect(r.inboundCount).toBe(1)
    expect(r.totalMessages).toBe(3)
  })
})

describe('computeMessageStats — response rate', () => {
  it('counts an outbound as replied when an inbound arrives within window', () => {
    // outbound at 0h, inbound at 2h → replied (within 24h)
    const r = computeMessageStats([at(0, 'outbound'), at(2, 'inbound')])
    expect(r.repliedCount).toBe(1)
    expect(r.responseRatePct).toBe(100)
  })

  it('does NOT count an outbound as replied when inbound arrives outside window', () => {
    // outbound at 0h, inbound at 25h → outside 24h window
    const r = computeMessageStats([at(0, 'outbound'), at(25, 'inbound')])
    expect(r.repliedCount).toBe(0)
    expect(r.responseRatePct).toBe(0)
  })

  it('rounds the percentage', () => {
    // 2 outbound, 1 inbound within window of the first → 50%
    const r = computeMessageStats([
      at(0, 'outbound'),
      at(1, 'inbound'),
      at(48, 'outbound'),
    ])
    expect(r.responseRatePct).toBe(50)
  })

  it('only counts the first inbound within window per outbound (no double-credit)', () => {
    // 2 outbound back-to-back, 2 inbound after the first; second outbound should
    // also find an inbound within window from the second inbound's timing.
    const r = computeMessageStats([
      at(0, 'outbound'),
      at(2, 'outbound'),
      at(3, 'inbound'),
      at(4, 'inbound'),
    ])
    // Both outbound see inbound within window → repliedCount = 2.
    expect(r.outboundCount).toBe(2)
    expect(r.repliedCount).toBe(2)
    expect(r.responseRatePct).toBe(100)
  })

  it('is robust to unsorted input', () => {
    // Same as the previous case but shuffled; sort is internal to the helper.
    const r = computeMessageStats([
      at(4, 'inbound'),
      at(0, 'outbound'),
      at(3, 'inbound'),
      at(2, 'outbound'),
    ])
    expect(r.outboundCount).toBe(2)
    expect(r.repliedCount).toBe(2)
  })

  it('respects a custom window', () => {
    // outbound at 0h, inbound at 5h → outside a 4h window, inside the default 24h
    const r = computeMessageStats([at(0, 'outbound'), at(5, 'inbound')], 4)
    expect(r.repliedCount).toBe(0)
    expect(r.responseRatePct).toBe(0)
    expect(r.responseWindowHours).toBe(4)
  })
})
