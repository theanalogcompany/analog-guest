// Deterministic unverified-link detector for agent drafts (TAC-509). Sits
// alongside DASH_REGEX and matchSelfTalk inside generateMessage's per-attempt
// regen loop (lib/ai/generate-message.ts) — same role, same placement, same
// shared attempt budget.
//
// The failure this catches: the agent puts a link in a guest-facing reply that
// nobody curated. A wrong URL is worse than a wrong phone number because it
// LOOKS right — lemils.com/products/* resolves to a live Shopify store, so a
// fabricated slug is a 404 in the guest's hand rather than an obvious error.
// The model can build one of those from what it knows about Shopify without
// any link ever appearing in its source material, so a groundedness check
// against retrieved knowledge would not catch it either.
//
// THE ALLOWLIST IS CURATED, NOT DERIVED. `allowedUrls` comes from
// `venue_info.links` (lib/schemas/venue-info.ts) and from nothing else — not
// retrieved knowledge, not the composed prompt, not `venue_info.contact`.
// That is the whole guarantee: a link is sendable because a human put it on a
// list, not because it appeared somewhere in context. An empty list is a
// normal state and means no link may be sent.
//
// Pure and dependency-free, mirroring self-talk-detector.ts. Deliberately NOT
// exported from lib/ai/index.ts: stages.test.ts mocks that barrel, and a pure
// function the tests need for real must not arrive mocked (same reasoning as
// emoji-cadence.ts and self-talk-detector.ts).

/**
 * Trailing characters stripped from a matched token before it is judged.
 *
 * Sentence punctuation and closing brackets only. A guest-facing sentence ends
 * "...at https://lemils.com/products/budan." and the full stop is prose, not
 * path. The closers also make the markdown form `[label](<https://x>)` reduce
 * to the bare URL, which matters because the prompt asks for plain text but
 * the model occasionally reaches for markdown anyway.
 *
 * "/" is NOT in this set: it is handled separately by stripOneTrailingSlash,
 * which treats exactly one trailing slash as insignificant on BOTH sides of
 * the comparison.
 */
const TRAILING_NOISE = new Set(['.', ',', '!', '?', ';', ':', ')', ']', '}', '>', '"', "'"])

/**
 * One URL-shaped token.
 *
 * Two alternatives, scheme-first so a scheme-prefixed link is consumed whole
 * rather than having its host matched by the second branch:
 *
 *   1. http:// or https:// followed by any run of non-space characters.
 *   2. A schemeless host — one or more dot-separated labels ending in an
 *      alphabetic TLD of 2+ characters — with an optional port and path.
 *
 * The alphabetic-TLD requirement on branch 2 is what keeps ordinary prose out:
 * "e.g" and "i.e" fail it (one-character last label), and "3.50" fails it
 * (numeric). Branch 2 matching a bare host is fine and expected — isUrl below
 * is what decides a bare domain is not a link.
 */
const URL_TOKEN =
  /https?:\/\/[^\s]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?/gi

/**
 * The same token pattern wrapped in ONE capture group, for
 * `String.prototype.split`.
 *
 * split() with a capturing delimiter retains the matches, so the result
 * alternates: even indices are the prose between URLs, odd indices are the
 * URLs themselves. That lets a caller transform prose while leaving links
 * byte-identical — see `replaceDashes` in generate-message.ts, where rewriting
 * a dash inside a URL would both break the link and then fail the allowlist
 * check that the untouched URL would have passed.
 *
 * Derived from URL_TOKEN's own source rather than retyped, so the two cannot
 * drift apart. Adding a capture group to URL_TOKEN itself would change the
 * shape of every `matchAll` result that already reads it.
 */
export const URL_TOKEN_SPLITTER = new RegExp(`(${URL_TOKEN.source})`, 'gi')

const SCHEME = /^https?:\/\//i

/** Strip trailing sentence punctuation and closing brackets, repeatedly. */
function trimTrailingNoise(token: string): string {
  let end = token.length
  while (end > 0 && TRAILING_NOISE.has(token[end - 1]!)) end--
  return token.slice(0, end)
}

/**
 * Remove exactly one trailing "/" (ruled 2026-09-21).
 *
 * `https://lemils.com` and `https://lemils.com/` are the same destination and
 * a venue's stored list should not have to guess which form the model will
 * write.
 *
 * Exactly one, not a greedy strip: "…/products//" reduces to "…/products/",
 * which still does not match a listed "…/products". A doubled slash is a
 * different path, and holding it is the safe direction.
 *
 * Kept SEPARATE from canonicalizeUrl below, and isUrl must call THIS one.
 * canonicalizeUrl supplies a missing scheme, and "https://" contains a "/",
 * so an isUrl built on it would read every bare domain as a link and undo
 * the rule that "lemils.com" is prose. The bare-domain tests are what catch
 * that mutant.
 */
function stripOneTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/**
 * The form both sides of the comparison are reduced to before matching
 * (TAC-509 follow-up, device UAT 2026-09-21).
 *
 * Two normalizations, and only two:
 *
 *   1. One trailing "/" comes off (stripOneTrailingSlash above).
 *   2. A MISSING scheme becomes "https://".
 *
 * (2) is what the device test failed on. Asked where to buy the beans, the
 * agent wrote `lemils.com/products/le-mils-budan-bold` — the right page,
 * written the way anyone writes a link in a DM — against a list holding
 * `https://lemils.com/products/le-mils-budan-bold`, and the draft was held.
 * A schemeless link and the https:// form of the same remainder are one
 * destination; nothing is gained by making the guest wait on an operator for
 * the difference.
 *
 * Applied to BOTH sides, like the trailing slash, so it is one canonical form
 * rather than a special case in the comparison. That also makes it symmetric:
 * a listed schemeless entry matches a drafted https:// link. The device
 * failure only needed one direction, but a one-directional rule would be a
 * second thing to remember at every read, and the reverse case is the same
 * destination by the same argument.
 *
 * An EXPLICIT scheme is never rewritten, so `http://` still does not match a
 * listed `https://`: http is a different, downgradeable destination, not an
 * omission. Nothing else is reconciled either — case, query string and path
 * stay significant, so `…/Products/Budan` and `…/products/budan?v=1` are
 * still held against a listed `…/products/budan`.
 */
function canonicalizeUrl(url: string): string {
  const trimmed = stripOneTrailingSlash(url)
  return SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * Is this token a link, as opposed to a bare domain mentioned in prose?
 *
 * A scheme makes it a link outright — "https://lemils.com/" is a deliberate
 * URL however short its path.
 *
 * Without a scheme it is a link only when a path survives removing the one
 * insignificant trailing slash. That is what keeps "lemils.com" sendable: the
 * venue's own knowledge entries say "on lemils.com", and the ticket is
 * explicit that bare domains are not URLs for this check. It follows from the
 * trailing-slash rule that "lemils.com/" is the same bare domain and is also
 * left alone, while "lemils.com/products/budan" is a link.
 */
function isUrl(token: string): boolean {
  if (SCHEME.test(token)) return true
  // stripOneTrailingSlash, NOT canonicalizeUrl: the latter supplies a missing
  // scheme, whose "//" would make every bare domain look like it had a path.
  return stripOneTrailingSlash(token).includes('/')
}

/**
 * Every link in a drafted body, in order of appearance, de-duplicated.
 *
 * Bare domains are excluded — see isUrl. An email address contributes nothing:
 * its host has no path, so it fails isUrl on the same rule.
 */
export function extractUrls(body: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of body.matchAll(URL_TOKEN)) {
    const raw = match[0]
    const index = match.index ?? 0
    // An address like "shopper@lemils.com" would otherwise contribute its
    // host. Harmless today (a bare host is not a link) but wrong in principle,
    // and it would start mattering if anyone widened isUrl.
    if (index > 0 && body[index - 1] === '@') continue
    const token = trimTrailingNoise(raw)
    if (token.length === 0 || !isUrl(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/**
 * Links in the body that are not on the venue's curated list.
 *
 * Exact string comparison, after trailing-noise trimming and after
 * canonicalizeUrl has reconciled the single trailing slash and the implied
 * scheme on both sides. A one-character difference in a slug is a different
 * link and is reported.
 *
 * An empty or missing `allowedUrls` reports every link in the body, which is
 * the intended behaviour for a venue with no list: nothing is sendable.
 *
 * Returns the offending links verbatim (pre-canonicalization) so regen
 * feedback and the PostHog event can quote what the model actually wrote.
 */
export function findUnverifiedUrls(body: string, allowedUrls: readonly string[]): string[] {
  const allowed = new Set(allowedUrls.map((u) => canonicalizeUrl(u.trim())))
  return extractUrls(body).filter((url) => !allowed.has(canonicalizeUrl(url)))
}
