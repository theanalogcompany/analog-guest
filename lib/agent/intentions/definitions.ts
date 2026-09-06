// TAC-324: first-touch intentions. A conversational goal Sana carries into a
// conversation she doesn't control — this file is the extension point for
// every future intent set (returning guests, lapsed guests, whatever comes
// after), which is why the shape below doesn't assume first visits: a future
// definition can supply its own `isSatisfied` and window without touching
// derive.ts at all.
//
// v1 ships exactly two. An earlier draft had four (`share_item_context` and
// `plant_next_visit` were cut) — neither is a goal Sana carries into a
// conversation; they're what a good reply to an answered order question
// looks like, which is persona/voice territory, not something independently
// pursuable or capped.

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type IntentionKey = 'learn_first_order' | 'invite_contact_save'

export const INTENTION_KEYS: readonly IntentionKey[] = [
  'learn_first_order',
  'invite_contact_save',
]

export interface IntentionSatisfactionFacts {
  /**
   * Any transaction row exists for this guest at this venue, any source
   * (guest_reported, square, toast, manual, csv_upload, mock). "Have we
   * heard what they ordered" doesn't distinguish HOW we heard it. Known,
   * accepted consequence: a mid-pilot historical CSV import would close
   * `learn_first_order` for a guest we never actually heard from — unlikely
   * inside a 3-day window on a freshly enrolled guest, not worth branching
   * for.
   */
  hasQualifyingTransaction: boolean
}

export interface IntentionDefinition {
  key: IntentionKey
  /**
   * Rendered verbatim as one line in the "## What you're hoping to get to"
   * block. Phrased as a state Sana is in ("you haven't heard...") rather
   * than an instruction ("ask...") — the difference is the whole ticket.
   */
  promptLine: string
  /**
   * What this intention means, for the post-send classifier
   * (lib/ai/classify-intention-prompts.ts) that decides which open
   * intentions a sent message actually raised. Lives here, not as a
   * separate lookup keyed on IntentionKey in lib/ai, so this file stays the
   * single extension point: a new intention with no classifierDescription
   * fails `tsc`, rather than silently falling back to its own raw key as a
   * description at classification time.
   */
  classifierDescription: string
  /** How long this intention stays open after guest creation, regardless of prompt state. */
  expiresAfterMs: number
  /**
   * Whether this intention can be independently observed as done, beyond
   * having been prompted once. When false, prompted-once IS closure — the
   * uniform derivation rule in derive.ts still applies ("open until
   * satisfied, prompted, or expired"), this predicate just never fires.
   */
  isSatisfied: (facts: IntentionSatisfactionFacts) => boolean
}

// TAC-324 plan-review: deliberately its OWN constant, NOT imported from
// lib/agent/extract-reported-order.ts's REPORTED_ORDER_WINDOW_DAYS (7). The
// two express different things — the extractor is how long we still LISTEN
// for a self-reported order; this is how long Sana still ASKS about one.
// Listening longer than we ask is correct and costs nothing (a guest who
// volunteers their drink on day five still gets it recorded, nobody was
// pestered). Asking as long as we listen produces exactly the "system
// catching up on a backlog" failure this ticket exists to prevent.
//
// The constraint between them is an inequality, not an equality:
// LEARN_FIRST_ORDER_WINDOW_DAYS must stay <= REPORTED_ORDER_WINDOW_DAYS.
// Asserted in derive.test.ts rather than enforced by importing one from the
// other, so the two constants can independently move for independent reasons
// without one file silently dragging the other.
export const LEARN_FIRST_ORDER_WINDOW_DAYS = 3

export const INVITE_CONTACT_SAVE_WINDOW_DAYS = 14

export const INTENTION_DEFINITIONS: readonly IntentionDefinition[] = [
  {
    key: 'learn_first_order',
    promptLine: "You haven't heard what this guest ordered yet.",
    classifierDescription:
      'asks the guest what they ordered, what they got, or how their drink/food was',
    expiresAfterMs: LEARN_FIRST_ORDER_WINDOW_DAYS * MS_PER_DAY,
    isSatisfied: (facts) => facts.hasQualifyingTransaction,
  },
  {
    key: 'invite_contact_save',
    promptLine: "You haven't told them to save your number.",
    classifierDescription:
      'tells the guest to save this number, text anytime, or otherwise invites them to keep in touch',
    expiresAfterMs: INVITE_CONTACT_SAVE_WINDOW_DAYS * MS_PER_DAY,
    // Never independently observable — we cannot know whether a guest saved
    // a contact. Prompted-once is the only closure; derive.ts's uniform
    // "prompted -> closed" check handles that, so this always returns false.
    isSatisfied: () => false,
  },
]
