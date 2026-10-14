// TAC-586, TAC-587: what a stored stamp prints. Pure.
//
// The row holds the decision (kind, label, date), its purchase holds the
// instant the time is read from, and the venue's settings hold the words
// around it (name, city). A re-render reads the CURRENT settings and timezone,
// so a stamp re-drawn after a venue renames itself carries the new name; with
// both unchanged, a re-render is pixel-identical.
//
// THE TIME IS DERIVED ON EVERY RENDER, never stored (TAC-587): the purchase's
// `occurred_at` in the venue's timezone, the same conversion `stamped_on`
// was made with at insert. The two agree only while `occurred_at` holds
// still. The Square ingest re-upserts it on every event for a payment, and
// falls back to the ingest time when the event carries no `created_at`
// (lib/pos/square/map.ts), so a later event can move the time a re-drawn
// stamp prints while its stored date stays put.

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

/**
 * `occurredAt` in `timezone` → `1:22 PM`: 12-hour clock, no leading zero.
 * Built from parts, never from the formatted string, because some ICU builds
 * put a narrow no-break space before the period and the stamp's fonts may
 * not have it. Null on a timezone this runtime cannot use.
 */
export function formatStampTime(
  occurredAt: Date,
  timezone: string,
): string | null {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(occurredAt)
  } catch {
    return null
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value
  const hour = part('hour')
  const minute = part('minute')
  const period = part('dayPeriod')?.toUpperCase()
  if (hour === undefined || minute === undefined) return null
  if (period !== 'AM' && period !== 'PM') return null
  return `${hour}:${minute} ${period}`
}

export function stampFace(
  stamp: {
    kind: StampKind
    label: string | null
    stampedOn: string
    occurredAt: Date
  },
  settings: PassportSettings,
  timezone: string,
): StampFace | null {
  const date = formatStampDate(stamp.stampedOn)
  if (date === null) return null
  const time = formatStampTime(stamp.occurredAt, timezone)
  if (time === null) return null
  return {
    kind: stamp.kind,
    label: stamp.label,
    date,
    time,
    venueName: settings.venueName,
    cityShort: settings.cityShort,
    cityLong: settings.cityLong,
  }
}
