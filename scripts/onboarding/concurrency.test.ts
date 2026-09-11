import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './concurrency'

describe('mapWithConcurrency', () => {
  it('preserves output order regardless of completion order', async () => {
    const delays = [30, 10, 20, 5]
    const out = await mapWithConcurrency(delays, 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms))
      return i
    })
    expect(out).toEqual([0, 1, 2, 3])
  })

  it('never runs more than `limit` at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    await mapWithConcurrency(items, 3, async (item) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return item
    })
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })

  it('handles an empty input array', async () => {
    const out = await mapWithConcurrency([], 4, async (x: number) => x)
    expect(out).toEqual([])
  })

  it('handles limit greater than item count', async () => {
    const out = await mapWithConcurrency([1, 2], 10, async (x) => x * 2)
    expect(out).toEqual([2, 4])
  })

  it('propagates a thrown error from fn', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom')
        return x
      }),
    ).rejects.toThrow('boom')
  })
})
