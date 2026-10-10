import { BrandPersonaSchema } from '@/lib/schemas/brand-persona'

// `{length_clause}` for the v2 frame: how long THIS venue's own team writes.
//
// Why this is not a literal in template.ts. That file is the GLOBAL default
// row (venue NULL), so a hardcoded "8 to 25 words" would put one venue's
// measurements into every venue's prompt - and decision 0010 rules that how a
// venue texts is measured from its team's own replies and never written by
// us. Same reason `{instagram_clause}` exists.
//
// Why it is not IN template.ts at all: that file has no imports of its own,
// and `bubbles.tsx` imports from it on the strength of that - a schema import
// there would pull server code into the client bundle.
//
// THE NUMBERS ARE THE VENUE'S, taken from `wordsPerReply`:
//
//   median -> p75   the usual band
//   p90             the "rare, needs a reason" ceiling
//
// p90 is the same figure v1's length check uses as its ceiling, so the prompt
// asks for what the check measures rather than for a second, nearby number.
//
// PER REPLY, not per bubble (owner-ruled 2026-10-09). The sentence says "your
// replies", and this venue's `splitShare` is 1.0 - every reply its team sends
// is several messages - so the two units give genuinely different numbers
// (12-22-40 per reply against 8-13-22 per bubble) and mixing them would ask
// for a bubble length while calling it a reply.
//
// Returns '' for a venue with no measured profile, which renders the frame
// byte-identically to v2.14.0. It leads with a space because it is appended
// mid-paragraph in `# Texting style`.
export function replyLengthClause(brandPersona: unknown): string {
  const parsed = BrandPersonaSchema.safeParse(brandPersona)
  if (!parsed.success) return ''
  const spread = parsed.data.voiceProfile?.wordsPerReply
  if (spread === undefined) return ''

  const { median, p75, p90 } = spread
  // A terse venue can have median === p75, and "usually 9 to 9 words" reads
  // as a bug rather than as a measurement. Degenerate bands collapse to the
  // single number instead of being rendered as a range.
  const band =
    p75 > median ? `${median} to ${p75} words` : `about ${median} words`
  // Same guard one level up: a ceiling at or under the band says nothing, so
  // the sentence is dropped rather than contradicting the band it follows.
  const ceiling = p90 > p75 ? ` Over ${p90} is rare and needs a reason.` : ''
  return ` Your replies are usually ${band}.${ceiling}`
}
