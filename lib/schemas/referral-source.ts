// TAC-518: what `messages.referral_source` holds, and what counts as a scan.
//
// Meta puts a `referral` on the event that opens a thread from an ig.me link.
// Its `source` is the only part any code reads: `SHORTLINK` is Meta's own
// statement that the thread was opened from such a link, which for us is the
// venue's QR sign at the pickup counter. The `ref` value beside it is stored
// and consulted by nothing until TAC-506 makes it per-venue.
//
// ONE definition, two readers, deliberately. TAC-492's guest creation
// (lib/messaging/instagram/handle-events.ts) turns a scan into
// `guests.created_via = 'qr_scan'` at the moment a guest is created; TAC-518
// reads the same fact off THIS TURN's message row, which is the only way a
// returning guest's scan can be seen at all. Those two must not drift into
// separate spellings of "this came from the link", so the predicate lives here
// rather than in either caller.
//
// Domain-free and dependency-free, on the message-channel.ts model: the agent
// runtime needs it and must not import the Instagram transport for it.
//
// Permissive at the live boundary, per CLAUDE.md's strict-offline /
// permissive-live split. Migration 048 put no CHECK on referral_source — the
// column is written on the webhook path, where a rejected insert loses the
// guest's message — so an unrecognized value is possible by design and is NOT
// a scan. It is not an error either: Meta documents other sources (ads, a
// customer-chat plugin), and a guest arriving through one of those genuinely
// is not standing at the counter.

/** Meta's `referral.source` for a thread opened from an ig.me link. */
export const SCAN_REFERRAL_SOURCE = 'SHORTLINK'

/**
 * Whether a stored `referral_source` means the guest opened the thread from
 * the venue's link.
 *
 * Exact match, deliberately: no trimming, no case folding. Meta sends an
 * uppercase constant, and widening this is how a value nobody has seen starts
 * arming a first-touch path. A null, an empty string, or any other source is
 * not a scan.
 */
export function isScanReferral(source: string | null | undefined): boolean {
  return source === SCAN_REFERRAL_SOURCE
}
