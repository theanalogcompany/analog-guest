// TAC-324 introduced intentions; TAC-380 redefines the set. An intention is a
// conversational goal Sana carries into a conversation she doesn't control,
// and this file is the ONE extension point for adding one: a definition
// supplies its own arming, gate, window and satisfaction predicate, and
// derive.ts applies a single uniform rule to every definition without ever
// branching on its key.
//
// Intentions GATHER; followups SPEND what was gathered. A goal belongs here
// only if something observable closes it.
//
// Closure under TAC-380 is PROMPTED-ONCE for all seven: raising an intention
// once closes it, whether or not the guest replied. `isSatisfied` adds a
// second, independent closure wherever a proxy exists. Closing on the guest's
// actual ANSWER is TAC-385, which upgrades these in place without changing the
// definitions.
//
// Prompted-once is per ARMING. First-contact intentions arm once and never
// again. The two event-armed intentions re-arm when a strictly newer
// recommendation or order arrives (rearmsOnNewerEvent): a new one is a new thing
// to ask about, not a repeat of the old one.
//
// Retired by TAC-380: `invite_contact_save` (a guest saving a contact is
// unobservable, so it was a permanent open loop) and `learn_first_order`
// (renamed understand_order). Cut before building: the two capture-only
// intentions, because volunteered information already lands in contextUpdate,
// and `they_said_theyd_come`, whose closing move is an outbound — a followup.

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type IntentionKey =
  | 'understand_order'
  | 'got_the_recommendation'
  | 'did_they_like_it'
  | 'learn_name'
  | 'are_they_local'
  | 'their_rhythm'
  | 'why_theyre_here'

/**
 * What makes an intention relevant at all, before its gate is checked.
 *
 * It also fixes the anchor expiry runs from (`eligible_at`, TAC-380 ruling 5).
 * For `first_contact` that is the turn the gate was first seen open, and for
 * `qr_scan_enrollment` the enrollment. For the two event-armed kinds it is the
 * moment the event became part of a DIFFERENT conversation — once it is older
 * than `followup_rules.recent_conversation_hours` (ruling 2) — so each perishes
 * a fixed time after that, however late the gate opened. A strictly newer event
 * re-arms the two event-armed kinds (rearmsOnNewerEvent).
 */
export type IntentionArmsOn =
  /**
   * `created_via = 'qr_scan'`. Scanning the sign at pickup confirms a visit,
   * which is what lets understand_order ask what someone ordered without
   * breaking R1 (never reference an action the guest's history doesn't
   * confirm). A guest who texted in without scanning is never asked.
   */
  | { kind: 'qr_scan_enrollment' }
  /** Every guest. */
  | { kind: 'first_contact' }
  /**
   * An open recommendation to the guest: the NEWEST one that is askable now
   * (ruling 1), once it is older than the conversation window (ruling 2).
   */
  | { kind: 'open_recommendation' }
  /**
   * A recorded order (any transaction row for the guest): the NEWEST one that
   * is askable now, once it is older than the conversation window (ruling 2).
   * Newest rather than first ever, for ruling 1's reason: a guest whose first
   * order was long ago would otherwise never be asked about a later one.
   */
  | { kind: 'recorded_order' }

/**
 * Whether a strictly newer event re-arms an intention that already has a row
 * (TAC-380 acceptance criteria, corrected 2026-09-14).
 *
 * First-contact intentions never re-arm: asking a guest's name twice is
 * nagging. Event-armed ones do: a new recommendation or order is a new thing to
 * ask about, and without re-arming a guest whose window ran out would never be
 * asked about any later one, because there is one row per guest per intention.
 *
 * An exhaustive switch, so a new arming kind fails `tsc` until someone decides.
 */
export function rearmsOnNewerEvent(armsOn: IntentionArmsOn): boolean {
  switch (armsOn.kind) {
    case 'qr_scan_enrollment':
    case 'first_contact':
      return false
    case 'open_recommendation':
    case 'recorded_order':
      return true
  }
}

/**
 * The right to ask (TAC-380 §3). `conversational` requires BOTH the venue's
 * floor on `recognition.signals.responseRate` AND a minimum lifetime reply
 * count. The reply count is what staggers intentions. The ratio cannot:
 * normalizeResponseRate reads 0 until three responses have been sent, then
 * jumps straight to ~100 for a guest who replies to everything.
 *
 * `defaultMinReplies` is a PLACEHOLDER. A venue overrides it per key through
 * `venue_configs.intention_rules.min_replies`.
 */
export type IntentionGate =
  | { kind: 'none' }
  | { kind: 'conversational'; defaultMinReplies: number }

export interface IntentionSatisfactionFacts {
  /**
   * Any transaction row exists for this guest at this venue, from any source.
   * "Have we heard what they ordered" doesn't care HOW we heard it.
   */
  hasQualifyingTransaction: boolean
  /**
   * `guests.first_name` is non-empty.
   *
   * KNOWN CONSEQUENCE (TAC-380 Probe 1): updateGuestContext writes first_name
   * verbatim with no validation, and THE-157 rules out .min()/.max() on the
   * LLM-facing schema. So an arbitrary string a guest offers as their name
   * closes learn_name permanently, on top of rendering back into every later
   * prompt. Documented and accepted; validating it is not this ticket.
   */
  hasFirstName: boolean
  /** The parsed guest context carries a home_base. */
  hasHomeBase: boolean
}

export interface IntentionDefinition {
  key: IntentionKey
  /**
   * Tie-break among open intentions: lower renders first, and the prompt tells
   * the model to take the first line that fits. Gaps of 10 leave room to
   * insert without renumbering.
   */
  priority: number
  armsOn: IntentionArmsOn
  gate: IntentionGate
  /**
   * Rendered verbatim as one line in the "## What you're hoping to get to"
   * block. Phrased as a state Sana is in ("you don't know...") rather than an
   * instruction ("ask...") — the difference is the whole mechanism.
   */
  promptLine: string
  /**
   * What this intention means, for the post-send classifier
   * (lib/ai/classify-intention-prompts.ts) that decides which open intentions
   * a sent message actually raised. Lives here rather than as a lookup in
   * lib/ai so this file stays the single extension point: a new intention
   * with no description fails `tsc`.
   */
  classifierDescription: string
  /**
   * Plain-English statement of how this intention closes, for the read-only
   * Command Center viewer (TAC-379). `isSatisfied` is a predicate and cannot
   * be rendered as data, so the intent is stated separately. Display-only:
   * `OpenIntention` carries `key`, `promptLine` and `eligibleAt`, so this can
   * never reach the prompt.
   */
  satisfactionLabel: string
  /**
   * How long the intention stays open after it became ELIGIBLE (`eligible_at`),
   * regardless of prompt state. Measured from eligibility rather than guest
   * creation (TAC-380 ruling 5): from creation, one-per-turn raising would
   * leave only the top few intentions ever asked and every lower one expiring
   * unraised, which makes the priority list decorative.
   */
  expiresAfterMs: number
  /**
   * An observable proxy that closes this intention independently of having
   * been raised. `() => false` where none exists, and prompted-once is then the
   * only closure until TAC-385.
   */
  isSatisfied: (facts: IntentionSatisfactionFacts) => boolean
}

// Carried over from TAC-324 under understand_order's name, and still
// deliberately its OWN constant rather than REPORTED_ORDER_WINDOW_DAYS (7):
// the extractor is how long we still LISTEN for a self-reported order, this is
// how long Sana still ASKS about one. Listening longer than asking is free;
// asking as long as listening is the "catching up on a backlog" failure. Only
// the inequality UNDERSTAND_ORDER_WINDOW_DAYS <= REPORTED_ORDER_WINDOW_DAYS is
// asserted (derive.test.ts).
export const UNDERSTAND_ORDER_WINDOW_DAYS = 3

// Event-armed intentions are perishable (TAC-380 ruling 3): "did you get the
// Pink Panther?" is worthless a fortnight later. Measured from the moment the
// event became askable — once it is older than
// followup_rules.recent_conversation_hours (ruling 2) — not from the event
// itself, so the whole window stays askable at any configured conversation
// length. PLACEHOLDER.
export const EVENT_ARMED_WINDOW_DAYS = 3

// First-contact intentions carry no perishable event, so they get room to find
// a natural opening. Measured from the turn the gate first opened. PLACEHOLDER.
export const FIRST_CONTACT_WINDOW_DAYS = 14

const DEFINITIONS = {
  understand_order: {
    key: 'understand_order',
    priority: 10,
    armsOn: { kind: 'qr_scan_enrollment' },
    gate: { kind: 'none' },
    promptLine: "You haven't heard what this guest ordered yet.",
    // Deliberately says nothing about how the drink or food WAS: that belongs
    // to did_they_like_it. Left in, a "how was your drink?" send would close
    // the wrong intention.
    classifierDescription: 'asks the guest what they ordered or what they got',
    satisfactionLabel:
      'Closes once raised, or once any transaction exists for this guest, from any source.',
    expiresAfterMs: UNDERSTAND_ORDER_WINDOW_DAYS * MS_PER_DAY,
    isSatisfied: (facts) => facts.hasQualifyingTransaction,
  },
  got_the_recommendation: {
    key: 'got_the_recommendation',
    priority: 20,
    armsOn: { kind: 'open_recommendation' },
    gate: { kind: 'conversational', defaultMinReplies: 3 },
    promptLine: "You suggested something to this guest and haven't heard whether they tried it.",
    classifierDescription: 'asks whether the guest tried something the venue suggested to them',
    satisfactionLabel:
      'Closes once raised. Whether the guest actually tried the suggestion is not observed until TAC-385.',
    expiresAfterMs: EVENT_ARMED_WINDOW_DAYS * MS_PER_DAY,
    // No item-match proxy, deliberately. A recommendation's description is
    // free prose, and a lossy match against transaction items that
    // false-positives would close this silently.
    isSatisfied: () => false,
  },
  did_they_like_it: {
    key: 'did_they_like_it',
    priority: 30,
    armsOn: { kind: 'recorded_order' },
    gate: { kind: 'conversational', defaultMinReplies: 3 },
    promptLine: 'You know what this guest ordered, but not whether they liked it.',
    classifierDescription:
      "asks how the guest's drink or food was, or whether they enjoyed what they ordered",
    satisfactionLabel:
      'Closes once raised. Whether the guest liked it is not observed until TAC-385.',
    expiresAfterMs: EVENT_ARMED_WINDOW_DAYS * MS_PER_DAY,
    isSatisfied: () => false,
  },
  learn_name: {
    key: 'learn_name',
    priority: 40,
    armsOn: { kind: 'first_contact' },
    gate: { kind: 'conversational', defaultMinReplies: 3 },
    promptLine: "You don't know this guest's name yet.",
    classifierDescription: "asks the guest's name or what to call them",
    satisfactionLabel: 'Closes once raised, or once a first name is on record for this guest.',
    expiresAfterMs: FIRST_CONTACT_WINDOW_DAYS * MS_PER_DAY,
    // See IntentionSatisfactionFacts.hasFirstName for the Probe 1 consequence.
    isSatisfied: (facts) => facts.hasFirstName,
  },
  are_they_local: {
    key: 'are_they_local',
    priority: 50,
    armsOn: { kind: 'first_contact' },
    gate: { kind: 'conversational', defaultMinReplies: 5 },
    promptLine: "You don't know whether this guest lives or works nearby.",
    classifierDescription:
      "asks whether the guest lives or works nearby, or where they're coming from",
    satisfactionLabel: 'Closes once raised, or once a home base is on record for this guest.',
    expiresAfterMs: FIRST_CONTACT_WINDOW_DAYS * MS_PER_DAY,
    isSatisfied: (facts) => facts.hasHomeBase,
  },
  their_rhythm: {
    key: 'their_rhythm',
    priority: 60,
    armsOn: { kind: 'first_contact' },
    gate: { kind: 'conversational', defaultMinReplies: 8 },
    // TIME OF DAY, never frequency (TAC-380 ruling 2). R23 bans stating or
    // implying how often a guest visits, and the real trip is the turn AFTER
    // the question — "since you're in most mornings" — when the model uses the
    // answer. No rewording saves a goal that is about frequency; one about time
    // of day ("see you in the morning") never produces a count to state.
    // definitions.test.ts guards the wording.
    promptLine: "You don't know what time of day this guest tends to come by.",
    classifierDescription:
      'asks what time of day the guest usually comes by, such as mornings or afternoons',
    satisfactionLabel:
      'Closes once raised. The time of day the guest prefers is not observed until TAC-385.',
    expiresAfterMs: FIRST_CONTACT_WINDOW_DAYS * MS_PER_DAY,
    isSatisfied: () => false,
  },
  why_theyre_here: {
    key: 'why_theyre_here',
    priority: 70,
    armsOn: { kind: 'first_contact' },
    gate: { kind: 'conversational', defaultMinReplies: 11 },
    promptLine: "You don't know what brings this guest in.",
    classifierDescription: 'asks what brings the guest in, or what they come in for',
    satisfactionLabel: 'Closes once raised. The reason itself is not observed until TAC-385.',
    expiresAfterMs: FIRST_CONTACT_WINDOW_DAYS * MS_PER_DAY,
    isSatisfied: () => false,
  },
} satisfies Record<IntentionKey, IntentionDefinition>

/**
 * Every definition, keyed by its intention key.
 *
 * A TOTAL map (`satisfies Record<IntentionKey, …>`), so a key added to the
 * union without a definition fails `tsc`. TAC-324 shipped this as a
 * `readonly IntentionDefinition[]`, which is not exhaustiveness-checked — the
 * same trap TAC-381 found in TERMINAL_STATUSES.
 */
export const INTENTION_DEFINITION_BY_KEY: Readonly<Record<IntentionKey, IntentionDefinition>> =
  DEFINITIONS

/** Every definition, in priority order. The derivation iterates this. */
export const INTENTION_DEFINITIONS: readonly IntentionDefinition[] = (
  Object.values(DEFINITIONS) as IntentionDefinition[]
).sort((a, b) => a.priority - b.priority)

/** Every intention key, in priority order. */
export const INTENTION_KEYS: readonly IntentionKey[] = INTENTION_DEFINITIONS.map((d) => d.key)

/**
 * Narrow a raw `guest_intention_prompts.intention_key` to a live key. The
 * column is bare text with no FK, so a retired key (the orphaned
 * invite_contact_save row) is a real value, not an error.
 */
export function isIntentionKey(key: string): key is IntentionKey {
  return Object.prototype.hasOwnProperty.call(DEFINITIONS, key)
}

/**
 * TAC-380: keys renamed without all of their rows migrated yet.
 *
 * Migration 040 renames learn_first_order to understand_order, but rows the OLD
 * code writes between applying 040 and deploying keep the old key until the
 * backfill block is re-run. Read as the new key, a guest asked in that window is
 * not asked again. Retired keys (invite_contact_save) are deliberately absent:
 * they resolve to nothing.
 */
const LEGACY_KEY_ALIASES: Readonly<Record<string, IntentionKey>> = {
  learn_first_order: 'understand_order',
}

/** Resolve a raw row key to a live intention key, following renames. Null for a retired key. */
export function resolveIntentionKey(key: string): IntentionKey | null {
  if (isIntentionKey(key)) return key
  return Object.prototype.hasOwnProperty.call(LEGACY_KEY_ALIASES, key)
    ? LEGACY_KEY_ALIASES[key]
    : null
}
