// The ig.me link a scan code travels on.
//
// `https://ig.me/m/<username>?ref=<code>` opens a DM thread with the venue's
// Instagram account and makes Meta attach a `referral` to the opening event.
// Meta delivers the `ref` verbatim, and `handle-events.ts` already persists it
// to `messages.referral_ref` on BOTH referral paths -- the one carrying a
// message and the standalone bare-scan event. That column has existed since
// migration 048 and, until now, was read by nothing.
//
// PURE, no imports. The link is a string built from two values; the venue
// lookup belongs to the caller. Same split as `isScanReferral`
// (lib/schemas/referral-source.ts), which is the other half of this round
// trip and is deliberately dependency-free for the same reason: the agent
// runtime needs it and must not import the Instagram transport for it.
//
// ONE DEFINITION, SERVER-SIDE. When a printer or counter display eventually
// renders this, it is handed the finished URL rather than a template plus a
// code. A device that assembles the link itself is a second definition of it,
// and the first thing to drift would be the query parameter name -- which only
// Meta's delivery would reveal, long after the QR was printed.

/** Meta's link host for opening a DM thread. */
const IG_ME_HOST = 'https://ig.me/m'

/**
 * Why a venue might have no scan link. Distinguished rather than collapsed to
 * a boolean because the two have different fixes: one is a venue that has not
 * been given its handle, the other is a stored handle that cannot go in a URL.
 */
export type ScanLinkError =
  'venue_has_no_instagram_username' | 'instagram_username_not_url_safe'

/**
 * Instagram handles are 1-30 chars of letters, digits, underscore and period.
 * Checked rather than trusted: `venues.instagram_username` is hand-set in
 * Studio, like `instagram_account_id` before it, so a stray space or a pasted
 * full URL is the realistic input. Encoding such a value would produce a link
 * that resolves to nothing, and the failure would surface as "guests scan and
 * nothing happens" rather than as a bad handle.
 */
const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/

export type ScanLinkResult =
  { ok: true; url: string } | { ok: false; error: ScanLinkError }

/**
 * Build the ig.me link for a code.
 *
 * The code is NOT percent-encoded, and does not need to be: `issueScanCode`
 * emits base64url, whose alphabet is URL-safe by construction. Encoding it
 * anyway would be harmless today and would quietly start double-encoding the
 * day the code alphabet changed, so the constraint is stated at the issuer and
 * relied on here rather than papered over.
 */
export function buildScanLink(input: {
  instagramUsername: string | null
  code: string
}): ScanLinkResult {
  const handle = input.instagramUsername?.trim() ?? ''
  if (handle === '') {
    return { ok: false, error: 'venue_has_no_instagram_username' }
  }
  if (!HANDLE_RE.test(handle)) {
    return { ok: false, error: 'instagram_username_not_url_safe' }
  }
  return { ok: true, url: `${IG_ME_HOST}/${handle}?ref=${input.code}` }
}
