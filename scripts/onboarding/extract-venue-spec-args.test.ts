import { describe, expect, it } from 'vitest'
import { parseArgs, shouldRefuseOverwrite } from './extract-venue-spec-args'

// argv[0]/argv[1] are the node binary + script path in real process.argv;
// parseArgs slices them off, so tests prefix every case with two placeholders.
function argv(...args: string[]): string[] {
  return ['node', 'extract-venue-spec.ts', ...args]
}

describe('parseArgs', () => {
  it('parses a bare slug with all flags defaulted', () => {
    expect(parseArgs(argv('mock-sextant'))).toEqual({
      slug: 'mock-sextant',
      dryRun: false,
      force: false,
      interviewDate: null,
    })
  })

  it('parses --dry-run and --force', () => {
    expect(parseArgs(argv('mock-sextant', '--dry-run', '--force'))).toEqual({
      slug: 'mock-sextant',
      dryRun: true,
      force: true,
      interviewDate: null,
    })
  })

  it('parses --interview-date with a valid YYYY-MM-DD value', () => {
    expect(parseArgs(argv('mock-sextant', '--interview-date', '2026-08-30'))).toEqual({
      slug: 'mock-sextant',
      dryRun: false,
      force: false,
      interviewDate: '2026-08-30',
    })
  })

  it('rejects --interview-date with a malformed value', () => {
    expect(parseArgs(argv('mock-sextant', '--interview-date', 'next-tuesday'))).toBeNull()
  })

  it('rejects --interview-date with no value at all', () => {
    expect(parseArgs(argv('mock-sextant', '--interview-date'))).toBeNull()
  })

  it('rejects --interview-date immediately followed by another flag', () => {
    expect(parseArgs(argv('mock-sextant', '--interview-date', '--dry-run'))).toBeNull()
  })

  it('rejects an unknown flag', () => {
    expect(parseArgs(argv('mock-sextant', '--bogus'))).toBeNull()
  })

  it('rejects a missing slug', () => {
    expect(parseArgs(argv('--dry-run'))).toBeNull()
  })

  it('rejects a second positional argument', () => {
    expect(parseArgs(argv('mock-sextant', 'extra'))).toBeNull()
  })
})

describe('shouldRefuseOverwrite (TAC-346 overwrite guard)', () => {
  it('refuses when a 06- file exists and neither --dry-run nor --force is set', () => {
    expect(shouldRefuseOverwrite(true, false, false)).toBe(true)
  })

  it('does not refuse when no 06- file exists', () => {
    expect(shouldRefuseOverwrite(false, false, false)).toBe(false)
  })

  it('does not refuse under --dry-run even when a 06- file exists', () => {
    expect(shouldRefuseOverwrite(true, true, false)).toBe(false)
  })

  it('does not refuse under --force even when a 06- file exists', () => {
    expect(shouldRefuseOverwrite(true, false, true)).toBe(false)
  })
})
