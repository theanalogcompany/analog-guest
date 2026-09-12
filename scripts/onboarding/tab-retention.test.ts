import { describe, expect, it } from 'vitest'
import { buildTimestampedTabName, selectTabsToDelete } from './tab-retention'

describe('buildTimestampedTabName', () => {
  it('formats an ISO timestamp with a hyphen, not a colon, in the time component', () => {
    expect(buildTimestampedTabName('Run', '2026-09-11T18:42:07.123Z')).toBe('Run 2026-09-11 18-42')
  })

  it('works for the Report prefix too', () => {
    expect(buildTimestampedTabName('Report', '2026-01-05T00:05:00.000Z')).toBe('Report 2026-01-05 00-05')
  })

  it('throws on a malformed timestamp rather than producing a bad tab name', () => {
    expect(() => buildTimestampedTabName('Run', 'not-a-date')).toThrow()
  })
})

describe('selectTabsToDelete', () => {
  it('deletes nothing when at or under the keep count', () => {
    const titles = ['Run 2026-09-01 10-00', 'Run 2026-09-02 10-00']
    expect(selectTabsToDelete(titles, 'Run', 10)).toEqual([])
    expect(selectTabsToDelete(titles, 'Run', 2)).toEqual([])
  })

  it('deletes the oldest tabs beyond the keep count', () => {
    const titles = [
      'Run 2026-09-01 10-00',
      'Run 2026-09-02 10-00',
      'Run 2026-09-03 10-00',
      'Run 2026-09-04 10-00',
    ]
    expect(selectTabsToDelete(titles, 'Run', 2)).toEqual(['Run 2026-09-01 10-00', 'Run 2026-09-02 10-00'])
  })

  it('sorts lexicographically without needing Date parsing (fixed-width zero-padded format)', () => {
    // Deliberately out of chronological order in the input array.
    const titles = ['Run 2026-09-03 09-00', 'Run 2026-01-01 00-00', 'Run 2026-12-31 23-59']
    expect(selectTabsToDelete(titles, 'Run', 1)).toEqual(['Run 2026-01-01 00-00', 'Run 2026-09-03 09-00'])
  })

  it('never confuses Report tabs with Run tabs', () => {
    const titles = ['Run 2026-09-01 10-00', 'Report 2026-09-01 10-00', 'Report 2026-09-02 10-00']
    expect(selectTabsToDelete(titles, 'Report', 1)).toEqual(['Report 2026-09-01 10-00'])
    expect(selectTabsToDelete(titles, 'Run', 1)).toEqual([])
  })

  it('ignores a legacy plain "Report"/"Run" tab and unrelated tabs', () => {
    const titles = ['Report', 'Run', 'Scenarios', 'Topics', 'Report 2026-09-01 10-00']
    expect(selectTabsToDelete(titles, 'Report', 0)).toEqual(['Report 2026-09-01 10-00'])
  })
})
