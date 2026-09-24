import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  VENUE_PROCESSING,
  VENUE_STATUSES,
  isVenueProcessingHalted,
  isVenueStatus,
  parseVenueStatus,
} from './status'

describe('parseVenueStatus', () => {
  it('passes through all four real values', () => {
    expect(parseVenueStatus('pending')).toBe('pending')
    expect(parseVenueStatus('active')).toBe('active')
    expect(parseVenueStatus('paused')).toBe('paused')
    expect(parseVenueStatus('archived')).toBe('archived')
  })

  it('returns null for null and undefined, without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseVenueStatus(null)).toBeNull()
    expect(parseVenueStatus(undefined)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('degrades an unrecognized value to null and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseVenueStatus('inactive')).toBeNull()
    expect(parseVenueStatus('Paused')).toBeNull()
    expect(parseVenueStatus('')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('isVenueStatus rejects anything outside the list', () => {
    expect(isVenueStatus('pending')).toBe(true)
    expect(isVenueStatus('archived')).toBe(true)
    expect(isVenueStatus('inactive')).toBe(false)
    expect(isVenueStatus(null)).toBe(false)
    expect(isVenueStatus(undefined)).toBe(false)
  })
})

describe('isVenueProcessingHalted', () => {
  it('halts the two values that mean stop', () => {
    expect(isVenueProcessingHalted('paused')).toBe(true)
    expect(isVenueProcessingHalted('archived')).toBe(true)
  })

  // THE LIVE-DATA TEST. Production is inverted: Le Mil's, the only real
  // venue, is 'pending', and both mock venues are 'active' (checked
  // 2026-09-23). So an allow-list admitting only 'active' would read as
  // obviously correct and would switch the pilot venue off the day it
  // merged. This is the assertion that kills that mutant.
  it('PROCESSES pending, because the live venue is pending', () => {
    expect(isVenueProcessingHalted('pending')).toBe(false)
  })

  it('processes active', () => {
    expect(isVenueProcessingHalted('active')).toBe(false)
  })

  // Fail OPEN, and deliberately: a value outside the CHECK can only arrive by
  // someone widening the constraint ahead of the code. Halting on it would
  // take a venue silent for a deploy-ordering mistake.
  it('PROCESSES an unreadable status rather than halting, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(isVenueProcessingHalted('inactive')).toBe(false)
    expect(isVenueProcessingHalted('suspended')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('processes a null or absent status without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(isVenueProcessingHalted(null)).toBe(false)
    expect(isVenueProcessingHalted(undefined)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // Case matters. Postgres stores exactly what the CHECK permits, so a
  // case-folding match would only ever admit a value the column cannot hold,
  // while making the predicate look more forgiving than it is.
  it('does not case-fold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(isVenueProcessingHalted('PAUSED')).toBe(false)
    warn.mockRestore()
  })
})

describe('VENUE_PROCESSING', () => {
  // `satisfies Record<VenueStatus, VenueProcessing>` is the real guard and it
  // is a compile-time one. This says the same thing at runtime so the totality
  // is visible to a reader who is not running tsc.
  it('decides every status, with no extras', () => {
    expect(Object.keys(VENUE_PROCESSING).sort()).toEqual([...VENUE_STATUSES].sort())
  })

  it('halts exactly two of the four', () => {
    const halted = VENUE_STATUSES.filter((s) => VENUE_PROCESSING[s] === 'halted')
    expect([...halted].sort()).toEqual(['archived', 'paused'])
  })
})

// The list and migration 001's CHECK must name the same statuses. One added to
// either alone is a status that cannot be written, or one that is written and
// never decided on.
describe('VENUE_STATUSES matches the venues.status CHECK', () => {
  // Anchored to the `create table venues` block, NOT to the first
  // `check (status in (` in the file. Migration 001 has three of those:
  // venues (line 36), guests (188) and messages (319) — and guests.status is
  // ('new','active','paused','opted_out'), which shares two values with this
  // list. A regex that matched the wrong block could pass while comparing
  // against a different table's vocabulary.
  function venuesTableBlock(): string {
    const sql = readFileSync(join(__dirname, '../../db/migrations/001_initial_schema.sql'), 'utf8')
    const block = sql.match(/create table venues \(([\s\S]*?)\n\);/)
    expect(block).not.toBeNull()
    return block?.[1] ?? ''
  }

  // Guard the guard: if the extraction ever silently matches nothing or the
  // wrong table, this fails instead of the comparison below passing vacuously.
  it('extracts the venues table and not another one', () => {
    const block = venuesTableBlock()
    expect(block).toContain('messaging_phone_number')
    expect(block).not.toContain('opted_out')
  })

  it('lists exactly the values the CHECK permits', () => {
    const check = venuesTableBlock().match(/check \(status in \(([^)]*)\)\)/)
    expect(check).not.toBeNull()
    const values = (check?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
    expect([...values].sort()).toEqual([...VENUE_STATUSES].sort())
  })
})
