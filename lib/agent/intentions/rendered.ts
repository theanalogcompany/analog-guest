// BY PATH, not through the @/lib/schemas barrel. dispatch-operator-outbound.test.ts
// factory-mocks that barrel for PendingCommitmentSchema, and under such a mock a
// barrel import here throws "No parseRenderedIntentions export is defined on the
// mock". That throw would land at the dispatch call site, which is SYNCHRONOUS and
// after the guest has already received the message — turning a successful send
// into a 500 on the operator's approve. Same reasoning as record.ts's own
// by-path import one hop away; the hazard does not stop at the first hop.
import { parseRenderedIntentions, type RenderedIntention } from '@/lib/schemas/rendered-intentions'
import { INTENTION_DEFINITION_BY_KEY, resolveIntentionKey } from './definitions'
import type { OpenIntention } from './derive'

// TAC-385 PR 1. The two ends of the messages.rendered_intentions carrier.
//
// A NEW FILE rather than an addition to derive.ts / definitions.ts / record.ts,
// and deliberately so: PR 1's structural guarantee is that it changes no file
// which decides when an intention CLOSES. Those three are untouched. This one
// only moves a rendered set through the operator queue so the dispatch path can
// record the ask that the auto-send path already records.

/**
 * Write side: the rendered set, ready for the jsonb column.
 *
 * `promptLine` is deliberately NOT carried. Recording reads only
 * `classifierDescription`, which lives on the definition, so storing the line
 * would be a second copy of a constant that can go stale against it. The read
 * side reconstructs it from INTENTION_DEFINITION_BY_KEY.
 */
export function buildRenderedIntentionsPayload(
  open: readonly OpenIntention[],
): RenderedIntention[] {
  return open.map((o) => ({ key: o.key, eligibleAt: o.eligibleAt.toISOString() }))
}

/**
 * Read side: the raw jsonb column back into the OpenIntention shape
 * recordIntentionPrompts takes.
 *
 * Every failure mode DROPS THE ENTRY rather than throwing, because this runs
 * inside the operator's approve tap and a draft must always be dispatchable:
 *
 *   - a malformed payload or entry      (parseRenderedIntentions)
 *   - a key with no live definition     — a retired intention. resolveIntentionKey
 *     covers the learn_first_order -> understand_order alias; anything else is
 *     genuinely gone, and recording against it would write a row the derivation
 *     can never read.
 *   - an unparseable eligibleAt         — the anchor is what makes the stamp
 *     land on the right arming, so an entry without a usable one is worse than
 *     no entry at all.
 *
 * A dropped entry means that intention is not recorded as asked, so it stays
 * open and may be asked again. That is the direction TAC-385 §4 chose: annoying
 * beats invisible.
 */
export function parseRenderedIntentionsForRecording(value: unknown): OpenIntention[] {
  const open: OpenIntention[] = []
  for (const entry of parseRenderedIntentions(value)) {
    const key = resolveIntentionKey(entry.key)
    if (key === null) {
      console.warn(
        `[rendered-intentions] dropping "${entry.key}": no live intention definition. Not recording it as asked.`,
      )
      continue
    }
    const eligibleAt = new Date(entry.eligibleAt)
    if (!Number.isFinite(eligibleAt.getTime())) {
      console.warn(
        `[rendered-intentions] dropping "${entry.key}": unparseable eligibleAt "${entry.eligibleAt}".`,
      )
      continue
    }
    open.push({
      key,
      promptLine: INTENTION_DEFINITION_BY_KEY[key].promptLine,
      eligibleAt,
    })
  }
  return open
}
