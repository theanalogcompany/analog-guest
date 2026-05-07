import { describe, expect, it } from 'vitest'
import { normalizeAntiPattern } from './append-anti-patterns'

// dedupeAndAppendAntiPatterns is DB-touching and not unit-tested per CLAUDE.md.
// normalizeAntiPattern is pure; its behavior is the equality basis for dedupe,
// so it gets coverage here even though it's a one-liner — drift on this
// function silently lets duplicate rules through.

describe('normalizeAntiPattern', () => {
  it('lowercases, collapses internal whitespace, trims edges', () => {
    expect(normalizeAntiPattern('  Rule:   Avoid  EM-Dashes  ')).toBe('rule: avoid em-dashes')
  })

  it('treats whitespace-different rules as equivalent', () => {
    expect(normalizeAntiPattern('rule: be   terse')).toBe(normalizeAntiPattern('rule: be terse'))
  })

  it('treats case-different rules as equivalent', () => {
    expect(normalizeAntiPattern('Rule: be Terse')).toBe(normalizeAntiPattern('rule: be terse'))
  })

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeAntiPattern('   \n\t   ')).toBe('')
  })
})
