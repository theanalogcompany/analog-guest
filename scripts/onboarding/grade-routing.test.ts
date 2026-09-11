import { describe, expect, it } from 'vitest'
import { gradeRouting } from './grade-routing'

describe('gradeRouting', () => {
  it('passes when actual matches expected', () => {
    const g = gradeRouting({ expectedRoute: 'send', actualRoute: 'send' })
    expect(g.verdict).toBe('pass')
  })

  it('fails when actual does not match expected', () => {
    const g = gradeRouting({ expectedRoute: 'queue', actualRoute: 'send' })
    expect(g.verdict).toBe('fail')
  })

  it('is not_applicable when expected_route is unknown', () => {
    const g = gradeRouting({ expectedRoute: 'unknown', actualRoute: 'send' })
    expect(g.verdict).toBe('not_applicable')
  })

  it('is not_applicable when there is no actual route (e.g. the scenario failed/refused)', () => {
    const g = gradeRouting({ expectedRoute: 'send', actualRoute: null })
    expect(g.verdict).toBe('not_applicable')
  })

  it('treats drop as a routing failure, not not_applicable', () => {
    const g = gradeRouting({ expectedRoute: 'send', actualRoute: 'drop' })
    expect(g.verdict).toBe('fail')
  })
})
