// TAC-377: how precisely a recorded visit's timestamp is known.
//
// `transactions.occurred_at_precision` and `guests.last_visit_precision` both
// hold this. It exists because a self-reported visit ("just grabbed a
// cortado") and a Square receipt are both real evidence of a relationship,
// but only one of them pins the visit to a moment the venue can vouch for —
// and `post_visit_day_N` followups are scheduled off that moment, so firing
// them against a guess reads as the system inventing a visit.
//
//   pinned      — the timestamp is the visit time. A present-tense report
//                 while the venue was open: the message IS the receipt.
//   approximate — the timestamp is the best available anchor, not the visit
//                 time. Any past-tense report, or a present-tense one sent
//                 while the venue was shut.
//
// NULL is a third, deliberate state and is NOT a synonym for either: it means
// nothing ever recorded a precision for this row. Every row predating this
// migration is null, and so is every future Square write until that path
// opts in. See `detectPostVisitReason` for why null is treated as permissive.
export type VisitTimePrecision = 'pinned' | 'approximate'

/**
 * Narrow a raw DB value to `VisitTimePrecision`, or null.
 *
 * Permissive at the live boundary, per CLAUDE.md's strict-offline /
 * permissive-live split: an unrecognized value degrades to null (the
 * "nobody recorded this" state) rather than throwing inside an agent run.
 * The CHECK constraint in migration 036 is the strict half — a bad value
 * can't be written in the first place, so this only ever fires on a
 * hand-edited row.
 */
export function parseVisitPrecision(value: string | null | undefined): VisitTimePrecision | null {
  if (value === 'pinned' || value === 'approximate') return value
  if (value !== null && value !== undefined) {
    console.warn(`[visit-precision] unrecognized precision "${value}", treating as unrecorded`)
  }
  return null
}
