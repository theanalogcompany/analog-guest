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
  | 'hows_it_so_far'
  | 'check_back_on_order'
  | 'are_they_new_here'
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
 * `visit_confirmed` the earliest confirmed visit. For the two event-armed kinds it is the
 * moment the event became part of a DIFFERENT conversation — once it is older
 * than `followup_rules.recent_conversation_hours` (ruling 2) — so each perishes
 * a fixed time after that, however late the gate opened. A strictly newer event
 * re-arms the two event-armed kinds (rearmsOnNewerEvent).
 */
export type IntentionArmsOn =
  /**
   * A CONFIRMED VISIT (TAC-436 ruling 3), anchored to the earliest one on
   * record. A visit is what lets understand_order ask what someone ordered
   * without breaking R1 (never reference an action the guest's history doesn't
   * confirm) — scanning the sign is one way to confirm it, and used to be the
   * only one this armed on.
   *
   * Two sources today, resolved by the caller (build-runtime-context):
   *   - `created_via = 'qr_scan'`, anchored to enrollment. The sign is at
   *     pickup, so the scan itself is the visit.
   *   - a commitment acknowledged at the counter, anchored to
   *     `acknowledged_at`. Someone at the venue confirmed the guest showed up.
   *
   * DELIBERATELY NOT `guests.last_visit_at`, which reads like the obvious
   * source and is inert here: all three of its writers run downstream of a
   * transaction row that already exists, and a transaction SATISFIES this
   * intention, so arming on it would close the intention in the same breath it
   * opened it.
   *
   * A guest simply saying they came in, naming nothing they ordered, is
   * recorded nowhere today. That third source is TAC-386's to supply, and it
   * lands here without touching derive.ts (ruled 2026-09-17, audit question 2).
   */
  | { kind: 'visit_confirmed' }
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
   * TAC-558: the EARLIEST recorded order, armed as soon as one exists, with NO
   * conversation-window hold.
   *
   * READ THE CONTRAST WITH `recorded_order` ABOVE, because the two are one word
   * apart and mean opposite things. That one takes the NEWEST order and HOLDS
   * it until the order has left the conversation it happened in, because
   * "did you try it?" a minute after the order is absurd. This one takes the
   * EARLIEST and holds nothing, because the question it arms is about the
   * GUEST, not about the order: whether they are new here is just as askable in
   * the same sitting, and a 48-hour hold would push it out of the counter
   * session entirely, which is the only moment it naturally fits.
   *
   * A transaction existing is how "the order is captured" is read (TAC-558,
   * approved 2026-09-29). Deliberately STRONGER than "understand_order closed":
   * that intention also closes on prompted-once, i.e. we asked and the guest
   * never answered, in which case the order was not captured at all.
   *
   * THAT IS ALSO WHAT MAKES A RACE WITH understand_order STRUCTURALLY
   * IMPOSSIBLE rather than merely unlikely: a transaction satisfies
   * understand_order through its own isSatisfied, so the two can never be open
   * on one turn. See the priority comment on are_they_new_here.
   */
  | { kind: 'first_recorded_order' }
  /**
   * TAC-575: the guest has just named what they got, on a visit that is still
   * happening. Armed on THAT TURN, anchored to that message.
   *
   * THE THIRD ORDER-SHAPED KIND, and it is neither of the two above.
   * `recorded_order` waits for the order to leave the conversation, because
   * "did you like it?" a minute later is absurd; this one exists for exactly
   * that minute, because "how is it so far?" is only askable while the cup is
   * in their hand. `first_recorded_order` reads a transaction; this cannot,
   * because the order extractor runs after the reply is sent and no
   * transaction exists on the turn that names the order.
   *
   * Resolved by the caller (resolveSameVisitOrderAt, lib/agent/visit-checkin.ts)
   * from the scan and the menu-name prefilter, and passed in as
   * `sameVisitOrderAt`. Null on every turn that is not that moment, which
   * leaves an already-open row exactly as it is.
   */
  | { kind: 'same_visit_order' }
  /**
   * TAC-575: this visit is still owed its one check-back, the guest is still
   * chatting, and enough time has passed since the order to ask again.
   *
   * The in-conversation half of the check-back. The timed half
   * (lib/agent/visit-checkin-timeout.ts) only fires for a guest who has gone
   * quiet, so a guest who keeps writing would never be checked back on; this
   * arms the question onto one of their turns instead.
   *
   * Resolved by the caller (resolveCheckbackDueAt, lib/agent/visit-checkin.ts)
   * and passed in as `checkbackDueAt`. The anchor is the order plus the delay,
   * NOT the current turn, so it is the same instant on every turn of the visit
   * and never looks like a newer event than itself.
   */
  | { kind: 'checkback_due' }

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
    case 'visit_confirmed':
    case 'first_contact':
    // TAC-558. Whether a guest is new here is asked once and never again: a
    // second order is not a new thing to ask about, it is the answer arriving
    // by another route (and hasRepeatVisitsOnRecord closes the intention on it).
    case 'first_recorded_order':
      return false
    case 'open_recommendation':
    case 'recorded_order':
    // TAC-575. A later visit is a new drink to ask about. What stops a second
    // ask INSIDE one visit is not this: the caller withholds the event once a
    // check-in row exists for the day (resolveSameVisitOrderAt).
    case 'same_visit_order':
    // TAC-575. A later visit's check-in is a later order, so a newer anchor.
    case 'checkback_due':
      return true
  }
}

/**
 * The right to ask (TAC-380 §3). Three kinds, and `gateOpen` switches on them
 * exhaustively so a fourth fails `tsc` until someone decides what it requires.
 *
 * `conversational` requires BOTH the venue's floor on
 * `recognition.signals.responseRate` AND a minimum lifetime reply count.
 * `replies_only` (TAC-436) requires the count alone. The count is what staggers
 * intentions; the ratio cannot, because normalizeResponseRate reads 0 until
 * three responses have been sent, then jumps straight to ~100 for a guest who
 * replies to everything.
 *
 * `defaultMinReplies` is a PLACEHOLDER. A venue overrides it per key through
 * `venue_configs.intention_rules.min_replies`.
 */
export type IntentionGate =
  | { kind: 'none' }
  | { kind: 'conversational'; defaultMinReplies: number }
  /**
   * TAC-436 ruling 2: the reply count WITHOUT the response-rate floor.
   *
   * The floor is unreachable early by construction. normalizeResponseRate
   * returns 0 until three outbound responses exist, and the floor defaults to
   * 50, so every conversational-gated intention is closed on a guest's first
   * turns no matter how they behave. The four first-contact intentions became
   * eligible strictly after the only licence to raise them had expired.
   *
   * DECLARED PER INTENTION, NEVER INFERRED FROM `armsOn`. Arming and gating are
   * orthogonal here on purpose: a future first-contact intention that should
   * wait for a proven responder writes `conversational` and gets it. Nothing in
   * this file branches on `armsOn.kind` to decide a gate.
   *
   * NEVER OPEN BEFORE THE VENUE HAS ANSWERED THIS GUEST ONCE (TAC-575, ruled
   * 2026-10-06: "never ask the name in the first reply"). That is a rule of
   * the gate kind, applied in derive.ts off `venueHasAnsweredBefore`, and not
   * a per-intention number: this type carried a `firstMessageMinReplies` until
   * then, on which `learn_name` alone said 0, and every cold DM got a name ask
   * as the second bubble of its first reply. A count cannot say "first reply"
   * anyway. A guest who sends three messages before we answer has a count of
   * three and has still been told nothing.
   */
  | {
      kind: 'replies_only'
      defaultMinReplies: number
    }

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
  /**
   * TAC-558: the record shows MORE THAN ONE visit for this guest, so we already
   * know they have been in before and there is nothing to ask.
   *
   * THE RAW TRANSACTION ROW COUNT, deliberately, where are_they_new_here ARMS
   * off the PARSED visit list. Arm on what the model can SEE (## Visit history
   * is built from the parsed projection, so an unparseable row shows the model
   * no order to anchor on); close on what the RECORD knows. A guest with five
   * rows of which four have unparseable raw_data must not be asked whether this
   * is their first time, and the parsed count would say it is.
   *
   * Read POSITIVELY by isSatisfied, which is what keeps the Command Center
   * loader's fail-closed branch honest - see the note at
   * load-venue-intentions.ts, which warns that the guarantee holds only while
   * every isSatisfied does.
   */
  hasRepeatVisitsOnRecord: boolean
  /**
   * TAC-558: the guest's own account of their history at this venue is on file
   * (`guests.context.guest_details.history_here`).
   *
   * The `hasHomeBase` shape exactly: a free-form string the agent captured
   * through contextUpdate, which both closes the intention and renders back into
   * the ## Guest context block on later turns.
   */
  hasVenueHistoryOnFile: boolean
}

/**
 * When an intention may be raised during a guest's first conversation.
 *
 * A NAMED UNION rather than a boolean, kept that way after TAC-575 removed its
 * third state (`'after_warm_close'`, which only are_they_new_here ever used):
 * the discipline of this file is that a definition declares its own behaviour
 * and nothing branches on a key, and a state added later fails `tsc` in
 * derive.ts's switch instead of falling through to allowed.
 */
export type FirstConversationPolicy =
  /**
   * Raisable during the first conversation, once its own gate opens. Not "from
   * the very first message": a replies_only gate stays shut until the venue
   * has answered the guest once (see IntentionGate).
   */
  | 'allowed'
  /** Never on a first conversation; arrives intact on the second. */
  | 'suppressed'

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
   * TAC-567, amended twice by TAC-568 and again by TAC-575: may this intention
   * be raised during the guest's FIRST conversation?
   *
   * It had a third state for a week ('after_warm_close'). The ruling history is
   * worth carrying because the first two amendments landed on 2026-09-30 and
   * the second reverses half of the first:
   *
   *   TAC-567 allowed three intentions on a first conversation
   *   (understand_order, learn_name, are_they_new_here), after a fresh scan
   *   asked four questions across three messages and read as an interview.
   *
   *   TAC-568's morning ruling removed are_they_new_here outright: armed and
   *   open, the model declined to raise it, and the visit stalled with no
   *   close. A conversation that ENDS on an optional question ends on whether
   *   the model felt like asking it.
   *
   *   TAC-568's amendment put it back CONDITIONALLY, and the argument is one
   *   removing it entirely could not answer: are_they_new_here closes on
   *   `hasRepeatVisitsOnRecord`, so by the guest's second visit the record
   *   already shows 2+ visits and the intention is satisfied before it is ever
   *   eligible. "Never on a first conversation" therefore meant "never at all"
   *   — a defined intention with no reachable moment. It is now allowed on a
   *   first conversation ONCE THE WARM CLOSE HAS BEEN SENT, which is the point
   *   the ruled flow has finished its two questions and anything further is the
   *   guest choosing to keep talking.
   *
   *   TAC-575 (ruled 2026-10-06) reopened the first conversation to the
   *   getting-to-know-you pool, "only while they keep engaging, one question
   *   at a time": name, first time or regular, then local, rhythm and why
   *   they are here. What keeps that from being the four-question interview
   *   TAC-567 was written against is no longer this field. It is the reply
   *   counts (3, 3, 5, 8, 11), which a guest only reaches by continuing to
   *   write, the one-question-per-turn rule, and the brake. The two that ask
   *   about a PAST order or suggestion stay suppressed: neither has a past
   *   to ask about inside the sitting it happened in. The warm close no
   *   longer gates anything here; what follows a close is the caller's
   *   `quietAfterWarmClose` (derive.ts).
   *
   * DECLARED PER INTENTION, NEVER INFERRED FROM `armsOn` OR `priority`.
   * `first_contact` arms intentions on both sides of this line, so there is no
   * structural property to read it off. Nothing in derive.ts branches on an
   * intention's key; it reads this field.
   *
   * SUPPRESSION IS NOT CLOSURE, and it is applied in two places
   * (deriveOpenIntentions): the arming loop skips a suppressed intention, so no
   * eligible_at row is written and its window does not start ticking on a
   * question nobody may ask; and the open set is filtered, which is the actual
   * guarantee because it also covers a row that already exists, since
   * first-contact eligibility is sticky and the gate is never re-checked. The
   * intention arrives intact later.
   *
   * "First conversation" is TAC-560's one definition, isFirstConversation in
   * lib/agent/warm-close.ts, resolved by the caller and passed in.
   */
  onFirstConversation: FirstConversationPolicy
  /**
   * TAC-575: is raising this left to the model's judgement, or required?
   *
   * EVERY INTENTION BUT ONE IS 'when_it_fits', which is the whole design of
   * this file: a goal carried into a conversation the agent does not control,
   * raised when there is a natural opening and usually not at all (measured
   * raise rate 37% from the best block position).
   *
   * 'always' is for a question that is part of a ruled sequence rather than a
   * hope: "how is it so far?" comes right after the guest names their order
   * (ruled 2026-10-06), and a one-in-three chance of asking it would make the
   * check-back, the sign-off and the complaint follow-up that hang off the
   * answer a matter of luck. While one is open it renders ALONE, with a
   * paragraph that says to ask it, and everything else waits a turn
   * (deriveOpenIntentions and the serializer's MUST_ASK_PARAGRAPH).
   *
   * It still goes out through `intentionQuestion` as its own last message
   * (decision 0007) and still closes prompted-once through the post-send
   * classifier. Only the model's licence to skip it is removed, and only in
   * prose: a reply that already asks a question still drops it in code
   * (composeReplyWithIntention), and it comes back open next turn.
   */
  raise: 'when_it_fits' | 'always'
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
// required.
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

// TAC-575. "How is it so far?" is about a drink in the guest's hand, so it is
// the shortest-lived intention here by two orders of magnitude. Two hours, the
// bound the warm close uses for "the moment has gone" (WARM_CLOSE_MAX_AGE_MS).
// It only matters when the question could not be asked on the turn it armed
// (the reply already asked something, or was held): after this it is not
// asked late.
export const HOWS_IT_SO_FAR_WINDOW_MS = 2 * 60 * 60 * 1000

const DEFINITIONS = {
  understand_order: {
    key: 'understand_order',
    priority: 10,
    armsOn: { kind: 'visit_confirmed' },
    gate: { kind: 'none' },
    // The one question with no gate: it is the reason the guest scanned at
    // all, and the opener asks it outright.
    onFirstConversation: 'allowed',
    raise: 'when_it_fits',
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
  hows_it_so_far: {
    key: 'hows_it_so_far',
    // Straight after the order and ahead of everything about the guest
    // (TAC-575, ruled 2026-10-06: order, compliment, how is it, THEN the name).
    // 12 sits between understand_order (10), which the turn that arms this has
    // just answered, and the getting-to-know-you questions from 40 up.
    priority: 12,
    armsOn: { kind: 'same_visit_order' },
    // No gate: the guest answering "what did you get?" is the licence. It can
    // therefore ride a guest's first reply, which is the ruled flow and not an
    // exception to "no getting-to-know-you question in a first reply": that
    // rule belongs to the replies_only gate, and this is not one of those.
    gate: { kind: 'none' },
    onFirstConversation: 'allowed',
    // The one required question. See `raise`.
    raise: 'always',
    // A STATE, like every line here, and it names the item nowhere: the guest's
    // own message is in the thread, and a line that quoted an example drink
    // would be the thing a model reproduces.
    promptLine:
      "This guest has just told you what they got, and you don't know yet how it is.",
    // Scoped to SO FAR and to what they JUST got, so it does not collide with
    // did_they_like_it ("whether they enjoyed what they ordered"), which is
    // suppressed on a first conversation and cannot render beside this anyway:
    // this renders alone.
    classifierDescription:
      'asks how the item the guest has just got is so far, or how it is treating them',
    satisfactionLabel:
      'Closes once raised. A later visit re-arms it. What the guest answers is recorded on the visit check-in, not here.',
    expiresAfterMs: HOWS_IT_SO_FAR_WINDOW_MS,
    isSatisfied: () => false,
  },
  check_back_on_order: {
    key: 'check_back_on_order',
    // Beside hows_it_so_far and for the same reason: it is about the order,
    // and it comes before anything about the guest. The two are never open
    // together. This one needs a check-in row, and a check-in row closes that
    // one (build-runtime-context).
    priority: 13,
    armsOn: { kind: 'checkback_due' },
    gate: { kind: 'none' },
    onFirstConversation: 'allowed',
    // REQUIRED, like hows_it_so_far and for its reason. The ruling says the
    // reply "works the check-back in" once five minutes have passed; left to
    // judgement it would be worked in about one time in three, and the guest
    // who keeps chatting is the one the timer never reaches.
    raise: 'always',
    // A STATE, and it says why this is a second ask rather than a first: the
    // model can see its own earlier "how is it?" in the thread, and R41 tells
    // it not to reuse a line, so it has to know this is a deliberate return to
    // the subject and not a repeat to avoid.
    promptLine:
      "A little while ago this guest told you what they got, and they still haven't said how it is: they hadn't tried it yet, or didn't say. You're checking back on it now.",
    classifierDescription:
      'checks back on how the item the guest got earlier in this visit is, after they had not tried it yet or had not said',
    satisfactionLabel:
      "Closes once raised, and takes the visit's one check-back with it. Also closes when the timed check-back goes out or the guest says how it is.",
    expiresAfterMs: HOWS_IT_SO_FAR_WINDOW_MS,
    isSatisfied: () => false,
  },
  are_they_new_here: {
    key: 'are_they_new_here',
    // RIGHT AFTER THE NAME (TAC-575, ruled 2026-10-06: "their name, first time
    // vs regular, then the existing pool"). It was 15 under TAC-558, first among
    // everything it could meet; the ruled order puts the name ahead of it, and
    // both share rung 3, so `priority` is the only thing that orders them.
    //
    // It still cannot co-occur with understand_order at priority 10: arming
    // requires a transaction, and a transaction satisfies understand_order
    // through its own isSatisfied, so the two are mutually exclusive by
    // construction.
    priority: 45,
    armsOn: { kind: 'first_recorded_order' },
    // Rung 3, shared with learn_name, which is what gives `priority` real work
    // to do: both open, the name renders first, and the restraint paragraph
    // says take the first only.
    gate: {
      kind: 'replies_only',
      defaultMinReplies: 3,
    },
    // HISTORY, superseded by the last paragraph below. Under TAC-568 this was
    // held until after the warm close on a first conversation.
    //
    // TAC-567 put this on the first conversation because the ruled flow was
    // meant to END on it. The device test showed the opposite: armed and open,
    // the model declined to raise it, and the visit stalled on "nice to meet
    // you" with no close. A first conversation cannot END on an optional
    // question.
    //
    // The morning ruling removed it outright; the amendment the same day put it
    // back conditionally, because removing it meant it would never be asked AT
    // ALL. isSatisfied closes this on hasRepeatVisitsOnRecord, so by the second
    // visit the record shows 2+ visits and the intention is already satisfied —
    // "not on a first conversation" and "never" are the same sentence for this
    // one intention. That is exactly the trap of reading a suppression rule off
    // a general principle instead of this intention's own closure.
    //
    // TAC-575 (ruled 2026-10-06) took the warm close out of it: the question is
    // the second thing the first conversation gets to know, after the name, and
    // the close is triggered by a lull rather than by anything this waits on.
    // The history above is why it was never simply 'suppressed'.
    onFirstConversation: 'allowed',
    raise: 'when_it_fits',
    // Ruled verbatim by Jaipal, 2026-09-29. THIS IS THE ORIGINAL WORDING, ruled
    // back after a second one was tried and measured worse. Read the history
    // before rewording it, because the obvious fix has been tried.
    //
    // WORDING 1 (this line) MEASURED AS A TEMPLATE. Over 20 conversations, 12
    // questions raised, "have you been" in 11 of them. The diagnosis at the time
    // was that the model was lifting "has been coming here for a while" straight
    // out of this line.
    //
    // WORDING 2 WAS "This guest's history with the café before today is unknown
    // to you." - no phrase a guest would say, so nothing to lift. It was worse on
    // both counts. ON-TARGET rate HALVED: 10/20 for this line against 4/20 and
    // 6/20 across two runs, because an abstract line does not tell the model what
    // to ASK, so it asked about where the guest lives, or their name, or the
    // neighbourhood. Each of those closes this intention prompted-once having
    // learned nothing, which is worse than a repeated phrase. And variety FAILED
    // ANYWAY: wording 2 shares no phrase with its own questions and still
    // produced "have you been coming" in 3 of its 4 on-target questions.
    //
    // SO THE REPETITION IS NOT COPIED FROM HERE. "have you been...?" is how
    // English asks whether someone has done something before, and no wording
    // tested changes that. Rewording this line to chase phrasing variety is a
    // road already walked; the mechanism route is TAC-564's.
    //
    // NO QUOTED EXAMPLE: no double quote appears in any promptLine but
    // learn_name's. Necessary and, as wording 2 showed, NOT sufficient against
    // verbatim repetition.
    //
    // BOTH SIDES NAMED, and this is what buys the on-target rate. Naming only the
    // first ("you don't know whether this is their first visit") primes a yes/no;
    // naming neither is wording 2.
    //
    // NEWNESS, NEVER DURATION. Deliberately not "how long this guest has been
    // coming", which invites "a couple of years, few times a month" and then
    // trips R23 on the NEXT turn when the model uses the answer. That is the
    // same trap their_rhythm was scoped to time of day to avoid.
    promptLine:
      "You don't know whether this guest is on their first visit or has been coming here for a while.",
    classifierDescription:
      "asks whether this is the guest's first visit or whether they have been coming here for a while",
    satisfactionLabel:
      "Closes once raised, once the record shows more than one visit, or once the guest's own account of their history here is on file.",
    // The first-contact window, not the 3-day event one: this question is about
    // the guest rather than a perishable event, and TAC-519 found intentions are
    // rarely raised, so a 3-day window on a rarely-read block mostly expires
    // unasked. Measured from the earliest recorded order. PLACEHOLDER.
    expiresAfterMs: FIRST_CONTACT_WINDOW_DAYS * MS_PER_DAY,
    // TWO proxies, both read positively. The record already knowing they are a
    // returner is as good a closure as the guest telling us.
    isSatisfied: (facts) =>
      facts.hasRepeatVisitsOnRecord || facts.hasVenueHistoryOnFile,
  },
  got_the_recommendation: {
    key: 'got_the_recommendation',
    priority: 20,
    armsOn: { kind: 'open_recommendation' },
    gate: { kind: 'conversational', defaultMinReplies: 3 },
    // TAC-567: not on a first visit. A suggestion made in that first sitting is
    // not something to follow up inside it.
    onFirstConversation: 'suppressed',
    raise: 'when_it_fits',
    promptLine:
      "You suggested something to this guest and haven't heard whether they tried it.",
    classifierDescription:
      'asks whether the guest tried something the venue suggested to them',
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
    // TAC-567: not on a first visit. "how'd you like it?" is the exact fourth
    // question the ruled flow deletes; the device transcript shows the agent
    // inventing it in the body on turn 2.
    onFirstConversation: 'suppressed',
    raise: 'when_it_fits',
    promptLine:
      'You know what this guest ordered, but not whether they liked it.',
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
    // TAC-575 (ruled 2026-10-06): not before the guest has sent three messages,
    // and never in the first reply (the gate kind's own rule, see IntentionGate).
    // It used to waive the count on a first-ever message, which put "by the way,
    // what's your name?" in the second bubble of every cold DM's first reply,
    // including a real guest's who never wrote again.
    //
    // THE COUNT IS INBOUND ROWS, and a counter scan is one (its body is empty).
    // So a guest who scanned reaches three on their second typed message, and a
    // guest who simply messaged on their third. A venue can lower the count
    // through intention_rules.min_replies; it cannot open the first reply.
    gate: {
      kind: 'replies_only',
      defaultMinReplies: 3,
    },
    // The first of the getting-to-know-you questions (TAC-575). It is no longer
    // the first conversation's closing moment: TAC-568 sent the warm close on
    // the turn that stored a name, and TAC-575 moved the close to a lull.
    onFirstConversation: 'allowed',
    raise: 'when_it_fits',
    // TAC-541 ruling 3. THE SHAPE IS PART OF THE LINE, and the generic
    // restraint paragraph is what made that necessary: "one short question on
    // the end is fine" is true of every intention here, and on a name it
    // produced a bare "what's your name?" bolted onto an unrelated reply. The
    // guest's own "why?" (device test, 2026-09-26) is the evidence.
    //
    // WHY A NAME NEEDS ITS OWN SHAPE WHERE THE OTHERS DO NOT: the natural human
    // move is to offer your own name first, and TAC-541 ruling 1 removes that
    // move permanently. The speaker is the venue, so there is no name to trade.
    // What replaces it is a lighter frame, and Jaipal's own wording is quoted
    // as the model to follow rather than paraphrased.
    //
    // STILL A STATE, NOT AN INSTRUCTION, which is this field's whole mechanism
    // (see promptLine's own docstring). "Asked at all" is load-bearing: it
    // shapes the FORM if the ask happens and says nothing about whether to ask,
    // which remains entirely the restraint paragraph's call. Do not invert it
    // to "Ask their name".
    promptLine:
      'You don\'t know this guest\'s name yet. Asked at all, it goes on the end as a light aside, always with something softening it in front, the way "by the way, what\'s your name?" reads. A bare "what\'s your name?" tacked onto a reply about something else is the one shape to avoid: without the softener in front of it, it reads as a demand rather than an aside.',
    classifierDescription: "asks the guest's name or what to call them",
    satisfactionLabel:
      'Closes once raised, or once a first name is on record for this guest.',
    expiresAfterMs: FIRST_CONTACT_WINDOW_DAYS * MS_PER_DAY,
    // See IntentionSatisfactionFacts.hasFirstName for the Probe 1 consequence.
    isSatisfied: (facts) => facts.hasFirstName,
  },
  are_they_local: {
    key: 'are_they_local',
    priority: 50,
    armsOn: { kind: 'first_contact' },
    gate: {
      kind: 'replies_only',
      defaultMinReplies: 5,
    },
    // TAC-575: back on a first visit, behind its own reply count. See
    // onFirstConversation.
    onFirstConversation: 'allowed',
    raise: 'when_it_fits',
    promptLine: "You don't know whether this guest lives or works nearby.",
    classifierDescription:
      "asks whether the guest lives or works nearby, or where they're coming from",
    satisfactionLabel:
      'Closes once raised, or once a home base is on record for this guest.',
    expiresAfterMs: FIRST_CONTACT_WINDOW_DAYS * MS_PER_DAY,
    isSatisfied: (facts) => facts.hasHomeBase,
  },
  their_rhythm: {
    key: 'their_rhythm',
    priority: 60,
    armsOn: { kind: 'first_contact' },
    gate: {
      kind: 'replies_only',
      defaultMinReplies: 8,
    },
    // TAC-575: back on a first visit, behind its own reply count. See
    // onFirstConversation.
    onFirstConversation: 'allowed',
    raise: 'when_it_fits',
    // TIME OF DAY, never frequency (TAC-380 ruling 2). R23 bans stating or
    // implying how often a guest visits, and the real trip is the turn AFTER
    // the question — "since you're in most mornings" — when the model uses the
    // answer. No rewording saves a goal that is about frequency; one about time
    // of day ("see you in the morning") never produces a count to state.
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
    gate: {
      kind: 'replies_only',
      defaultMinReplies: 11,
    },
    // TAC-575: back on a first visit, behind its own reply count. See
    // onFirstConversation.
    onFirstConversation: 'allowed',
    raise: 'when_it_fits',
    promptLine: "You don't know what brings this guest in.",
    classifierDescription:
      'asks what brings the guest in, or what they come in for',
    satisfactionLabel:
      'Closes once raised. The reason itself is not observed until TAC-385.',
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
export const INTENTION_DEFINITION_BY_KEY: Readonly<
  Record<IntentionKey, IntentionDefinition>
> = DEFINITIONS

/** Every definition, in priority order. The derivation iterates this. */
export const INTENTION_DEFINITIONS: readonly IntentionDefinition[] = (
  Object.values(DEFINITIONS) as IntentionDefinition[]
).sort((a, b) => a.priority - b.priority)

/** Every intention key, in priority order. */
export const INTENTION_KEYS: readonly IntentionKey[] =
  INTENTION_DEFINITIONS.map((d) => d.key)

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
