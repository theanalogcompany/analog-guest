// TAC-586: what a stored stamp prints. Pure.
//
// The row holds the decision (kind, label, date) and the venue's settings
// hold the words around it (name, city). A re-render reads the CURRENT
// settings, so a stamp re-drawn after a venue renames itself carries the new
// name; with settings unchanged, a re-render is pixel-identical.

import type { PassportSettings } from '@/lib/schemas'

import type { StampKind } from './decide'
import type { StampFace } from './render/stamp-svg'

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const

/**
 * `2026-10-30` → `30 OCT 2026`, the only date format a stamp carries
 * (stamp-spec.md). The input is already the venue-local date, so no timezone
 * is applied here. Null for anything that is not a calendar date.
 */
export function formatStampDate(isoDate: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (match === null) return null
  const month = MONTHS[Number(match[2]) - 1]
  if (month === undefined) return null
  return `${match[3]} ${month} ${match[1]}`
}

export function stampFace(
  stamp: { kind: StampKind; label: string | null; stampedOn: string },
  settings: PassportSettings,
): StampFace | null {
  const date = formatStampDate(stamp.stampedOn)
  if (date === null) return null
  return {
    kind: stamp.kind,
    label: stamp.label,
    date,
    venueName: settings.venueName,
    cityShort: settings.cityShort,
    cityLong: settings.cityLong,
  }
}
