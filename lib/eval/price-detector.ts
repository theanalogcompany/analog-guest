// Does a reply put a price in front of the guest? THE one definition.
//
// Shared by `scripts/measurement/price-discretion.ts` (which measures the rate
// across eight questions) and the `forbidVolunteeredPrice` ceiling in
// `regression-scenarios.ts` (which guards two of them forever). Two copies
// would let the harness that tuned the prompt and the harness that protects it
// disagree about what they are counting, and the protecting one would be the
// copy nobody re-read.
//
// Pure: no DB, no model, no Next. Same shape and same reason as
// `lib/ai/emoji-cadence.ts`, which is the one definition of an emoji for the
// same family of checks.
//
// A PATTERN WITH OPTIONAL SLOTS, never a phrase list (scripts/CLAUDE.md #7).
// The no-figure arm is the half that matters: "there's a small upcharge for
// oat" volunteers the charge without a number, and a digits-only detector
// scores it clean - which would flatter any fix that merely taught the model
// to drop the digits while still bringing cost up unasked.
//
// DELIBERATELY NOT MATCHED: the bare words "free", "extra" and "more". "Extra
// shot" is an item on this menu and "nut free" is a dietary answer, so both
// appear in correct replies that volunteer nothing - matching them would make
// the detector asymmetric in exactly the direction that flatters a fix.

/** A currency figure, a bare decimal, or a cents amount. */
const FIGURE = /\$\s?\d|\b\d+\s?(?:cents?|c\b)|\b\d+\.\d{2}\b/i

/** Naming a charge without a figure. */
const CHARGE_WITHOUT_FIGURE =
  /\b(?:upcharge|surcharge|extra charge|costs? extra|charge for|price list|a bit more|slightly more)\b/i

/**
 * True when the text quotes a price or names a charge.
 *
 * Says nothing about whether that was WRONG - a guest who asked what something
 * costs should get exactly this. The caller owns that half: the measurement
 * harness scores it as the defect on its withhold set and as the requirement
 * on its quote set, from this same function, which is what makes the two rates
 * comparable.
 */
export function mentionsPrice(text: string): boolean {
  return FIGURE.test(text) || CHARGE_WITHOUT_FIGURE.test(text)
}
