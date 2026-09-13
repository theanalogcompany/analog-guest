import { describe, expect, it, vi } from 'vitest'
import { parseVisitPrecision } from './visit-precision'

describe('parseVisitPrecision', () => {
  it('passes through the two real values', () => {
    expect(parseVisitPrecision('pinned')).toBe('pinned')
    expect(parseVisitPrecision('approximate')).toBe('approximate')
  })

  // null is the third state, not an error: it means nobody ever recorded a
  // precision for this row. Every row predating migration 036 is null.
  it('returns null for null and undefined, without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseVisitPrecision(null)).toBeNull()
    expect(parseVisitPrecision(undefined)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // The permissive-live half of the strict-offline / permissive-live split:
  // migration 036's CHECK constraint is what actually stops a bad value being
  // written, so this branch only ever fires on a hand-edited row — and it
  // degrades rather than throwing inside an agent run.
  it('degrades an unrecognized value to null and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseVisitPrecision('PINNED')).toBeNull()
    expect(parseVisitPrecision('exact')).toBeNull()
    expect(parseVisitPrecision('')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  // Degrading to null means PERMISSIVE at the post-visit gate, never
  // blocking. A garbage value must not silently suppress a guest's
  // followups — if it ever should, that is a separate, deliberate decision.
  it('degrades toward the permissive state, not the blocking one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseVisitPrecision('garbage')).not.toBe('approximate')
    warn.mockRestore()
  })
})
