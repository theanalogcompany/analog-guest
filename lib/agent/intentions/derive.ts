import type { MessageCategory } from '@/lib/ai'
import { bodyMentionsMenuItem } from '@/lib/agent/extract-reported-order'
import type { MenuItem } from '@/lib/schemas'
import type { IntentionRules } from '@/lib/schemas/intention-rules'
import {
  INTENTION_DEFINITIONS,
  type IntentionDefinition,
  type IntentionKey,
  type IntentionSatisfactionFacts,
  rearmsOnNewerEvent,
  resolveIntentionKey,
} from './definitions'
import type { IntentionRows, PromptedIntentionRow } from './load'

// TAC-324 / TAC-380. Pure: no DB access. build-runtime-context.ts loads every
// fact this needs and passes it in, mirroring filterEligibleMechanics, which is
// also what makes every open/closed/expired combination a plain unit test.
//
// One uniform rule, with no branching on an intention's key: an intention is
// OPEN once it has become eligible and until it is prompted, satisfied or
// expired. Everything intention-specific lives on its definition.

export interface OpenIntention {
  key: IntentionKey
  promptLine: string
  /**
   * When this intention became askable. Carried through to recording so a
   * prompt written before its eligibility row landed can create that row with
   * the right anchor in the same step.
   */
  eligibleAt: Date
}

/**
 * An intention to record as eligible on this turn, handed by handle-inbound to
 * recordIntentionEligibility. Either seen eligible with no row for it yet, or
 * RE-ARMED: an event-armed intention whose existing row a strictly newer event
 * supersedes (see deriveOpenIntentions).
 */
export interface NewlyEligibleIntention {
  key: IntentionKey
  eligibleAt: Date
  /** True when this moves an existing row to a newer anchor rather than creating one. */
  rearm: boolean
}

export interface IntentionStateEntry {
  eligibleAt: Date | null
  promptedAt: Date | null
}

function isExpired(def: IntentionDefinition, eligibleAt: Date, now: Date): boolean {
  return now.getTime() - eligibleAt.getTime() > def.expiresAfterMs
}

/**
 * Whether a prompted event-armed intention is open again because a newer event
 * re-armed it. A re-arm keeps the row's last prompt, as evidence for the brake,
 * and moves eligible_at past it. A prompt always lands at or after the anchor it
 * asked about (an anchor is never later than the turn that renders it), so a
 * prompt older than the anchor belongs to an earlier arming. First-contact
 * intentions never re-arm, so they never reopen.
 */
function isReopened(def: IntentionDefinition, eligibleAt: Date, promptedAt: Date): boolean {
  return rearmsOnNewerEvent(def.armsOn) && promptedAt.getTime() < eligibleAt.getTime()
}

/**
 * The shared core, used by the agent and the Command Center alike: which
 * intentions are open, in priority order, given each one's recorded state.
 *
 * Knows nothing about arming, gates or the brake. Those decide what BECOMES
 * eligible and whether anything renders, not what "open" means.
 */
export function deriveIntentionState(input: {
  entries: ReadonlyMap<IntentionKey, IntentionStateEntry>
  facts: IntentionSatisfactionFacts
  now: Date
}): OpenIntention[] {
  const open: OpenIntention[] = []
  for (const def of INTENTION_DEFINITIONS) {
    const entry = input.entries.get(def.key)
    if (!entry || entry.eligibleAt === null) continue // never became eligible
    // Prompted -> closed, unless a newer event has re-armed it since.
    if (entry.promptedAt !== null && !isReopened(def, entry.eligibleAt, entry.promptedAt)) continue
    if (isExpired(def, entry.eligibleAt, input.now)) continue // window run from eligibility
    if (def.isSatisfied(input.facts)) continue // an observable proxy closed it
    open.push({ key: def.key, promptLine: def.promptLine, eligibleAt: entry.eligibleAt })
  }
  return open
}

/**
 * One definition of the satisfaction facts, shared by build-runtime-context and
 * the Command Center loader, so the two can never disagree about whether a
 * guest's name or home base is "on record".
 */
export function buildSatisfactionFacts(input: {
  hasQualifyingTransaction: boolean
  firstName: string | null
  homeBase: string | undefined
}): IntentionSatisfactionFacts {
  return {
    hasQualifyingTransaction: input.hasQualifyingTransaction,
    hasFirstName: input.firstName !== null && input.firstName.trim().length > 0,
    hasHomeBase: input.homeBase !== undefined && input.homeBase.trim().length > 0,
  }
}

/**
 * The unanswered-prompt brake (TAC-380 §3): once the guest's last `streak`
 * prompts each went unanswered, suppress every intention.
 *
 * WHAT "UNANSWERED" MEANS — and why it is not the ticket's original wording.
 * The ticket said "saw no subsequent inbound". That is false on every turn it
 * could be checked: prompts are only recorded on the sent reply to an inbound,
 * and the brake is only evaluated on an inbound turn, so the current message
 * follows every earlier prompt, and the older of any two prompts is always
 * followed by the inbound the newer one replied to. Defined that way the brake
 * reads correctly and never fires — comp_regex_backstop's shape.
 *
 * So a prompt counts as ANSWERED when the guest's next inbound arrived within
 * `conversationWindowMs` of it, meaning they replied in that exchange, and as
 * UNANSWERED otherwise: they came back later, about something else. The window
 * is followup_rules.recent_conversation_hours, the same definition followups
 * use for "this guest is in a conversation right now" (ruling 1).
 *
 * This measures "replied in the same exchange", not "answered the question".
 * That is the crudeness TAC-385 upgrades.
 *
 * - One prompt per SENT MESSAGE. A single send can raise two intentions, and
 *   counting rows would let one ignored message fill a streak of two.
 * - Pessimistic closures are not prompts: nothing may have been asked.
 * - A prompt older than `inboundHistoryFrom` is LEFT OUT, neither answered nor
 *   unanswered. The loaded inbound history has a horizon and an answer beyond
 *   it is invisible. Counting that prompt as unanswered would brake a guest who
 *   replied to everything, and the brake can't lift on its own: nothing
 *   renders, so no newer prompt is ever recorded. Ruling 1 put under-braking on
 *   the right side, so a prompt that can't be judged doesn't count.
 */
export function isIntentionBrakeEngaged(input: {
  prompted: readonly PromptedIntentionRow[]
  inboundTimes: readonly Date[]
  conversationWindowMs: number
  /** Where the loaded inbound history starts. Earlier prompts can't be judged. */
  inboundHistoryFrom: Date
  streak: number
}): boolean {
  if (input.streak <= 0) return false

  const promptTimeByMessage = new Map<string, number>()
  for (const row of input.prompted) {
    if (row.promptSource === 'pessimistic') continue
    if (row.promptedAt.getTime() < input.inboundHistoryFrom.getTime()) continue
    const messageKey = row.messageId ?? `prompted-at:${row.promptedAt.toISOString()}`
    const t = row.promptedAt.getTime()
    const existing = promptTimeByMessage.get(messageKey)
    if (existing === undefined || t < existing) promptTimeByMessage.set(messageKey, t)
  }

  const latest = [...promptTimeByMessage.values()].sort((a, b) => b - a).slice(0, input.streak)
  if (latest.length < input.streak) return false

  return latest.every(
    (promptedAt) => !wasAnswered(promptedAt, input.inboundTimes, input.conversationWindowMs),
  )
}

/** A prompt counts as answered when the guest's next inbound came within the conversation window. */
function wasAnswered(
  promptedAt: number,
  inboundTimes: readonly Date[],
  conversationWindowMs: number,
): boolean {
  return inboundTimes.some((d) => {
    const t = d.getTime()
    return t > promptedAt && t - promptedAt <= conversationWindowMs
  })
}

/**
 * TAC-380: where the guest's loaded inbound history starts, for the brake.
 *
 * Inbound history comes from the context build's message query: `historyCutoff`
 * back, capped at `rowCap` rows, then folded into at most `responseCap`
 * responses. When neither cap bit, the whole window was loaded and visibility
 * starts at the cutoff. When either did, older rows may have been dropped, so
 * visibility starts at the oldest response actually loaded — never earlier than
 * the cutoff.
 *
 * Exactly `responseCap` responses that happen to be the whole window read as
 * capped. That only moves the start later and excludes more prompts, which is
 * the under-braking direction ruling 1 chose.
 *
 * Takes the oldest by time rather than by position, so it does not depend on
 * the caller's ordering.
 */
export function resolveInboundHistoryFrom(input: {
  recentMessages: readonly { createdAt: Date }[]
  responseCap: number
  rowsFetched: number
  rowCap: number
  historyCutoff: Date
}): Date {
  const capped =
    input.recentMessages.length >= input.responseCap || input.rowsFetched >= input.rowCap
  if (!capped || input.recentMessages.length === 0) return input.historyCutoff
  const oldest = Math.min(...input.recentMessages.map((m) => m.createdAt.getTime()))
  return new Date(Math.max(oldest, input.historyCutoff.getTime()))
}

export interface DeriveOpenIntentionsInput {
  now: Date
  // TAC-436 removed `guest` from this input. Arming read createdVia/createdAt
  // directly to decide understand_order; ruling 3 moved that resolution to the
  // caller as `visitConfirmedAt`, leaving nothing here that reads the guest.
  // Removed rather than left dead, so a future qr_scan branch has to be added
  // back deliberately instead of finding the field already in scope.
  /** recognition.signals.responseRate, normalized 0-100. */
  responseRate: number
  /** Lifetime inbound message count at this venue (RawSignals.repliedMessageCount). */
  repliedMessageCount: number
  rules: IntentionRules
  facts: IntentionSatisfactionFacts
  /**
   * TAC-436 ruling 3: the EARLIEST confirmed visit on record, or null when no
   * visit is confirmed. Arms understand_order.
   *
   * Earliest, not latest, because the window runs from the anchor: a guest who
   * has been in several times should not have the ask renewed by each visit —
   * understand_order is about the first order we never heard, and TAC-380's
   * re-arming is deliberately off for it (rearmsOnNewerEvent).
   *
   * Resolved by build-runtime-context from QR enrollment and acknowledged
   * arrivals. See IntentionArmsOn.visit_confirmed for why last_visit_at is not
   * one of them.
   */
  visitConfirmedAt: Date | null
  /** created_at of every open recommendation to this guest, in any order. */
  openRecommendationTimes: readonly Date[]
  /**
   * updated_at of the same recommendations. Only the mid-conversation hold reads
   * these: a repeated recommendation is deduped onto its existing row (TAC-318),
   * which bumps updated_at and never created_at, so without them "did you try
   * it?" could follow a re-suggestion in the same exchange.
   */
  openRecommendationTouchedTimes: readonly Date[]
  /**
   * True when the open recommendations couldn't be read. got_the_recommendation
   * is then held for the turn: the read fails closed, as the read at
   * build-runtime-context.ts:203 does, where an empty list would silently lift the
   * hold. Orders need no equivalent: a failed visit-history read fails the whole
   * context build.
   */
  openRecommendationsUnreadable: boolean
  /** occurred_at of this guest's recorded orders at this venue, in any order. */
  recordedOrderTimes: readonly Date[]
  /** null means the rows could not be read, and the derivation fails CLOSED: nothing renders. */
  rows: IntentionRows | null
  /** The guest's inbound times in the loaded history, including the current message. */
  inboundTimes: readonly Date[]
  conversationWindowMs: number
  /**
   * Where that loaded history starts. The brake ignores prompts older than
   * this; see isIntentionBrakeEngaged.
   */
  inboundHistoryFrom: Date
}

export interface DeriveOpenIntentionsResult {
  /** Open intentions in priority order. Always empty while the brake is engaged. */
  open: OpenIntention[]
  /** Seen eligible this turn with no row yet, or re-armed — the caller persists these. */
  newlyEligible: NewlyEligibleIntention[]
  brakeEngaged: boolean
}

/** One arming of an intention: the anchor it records, and the event behind it. */
interface Arming {
  /** The `eligible_at` anchor its window runs from (ruling 5). */
  eligibleAt: Date
  /** What armed it. A re-arm needs one strictly newer than the stored anchor. */
  eventAt: Date
}

/**
 * Returned instead of an arming when an intention is held for the turn: its
 * newest event is still mid-conversation (ruling 2), or, for recommendations,
 * the events couldn't be read, so the hold can't be judged and fails closed, as
 * the read at build-runtime-context.ts:203 does. The turn is skipped, never the
 * intention.
 */
const HELD = 'held'

/**
 * The NEWEST event, armed once it has left the conversation it happened in
 * (ruling 2). The anchor is the moment it left.
 *
 * While that newest event is still mid-conversation this returns
 * HELD and never falls back to an older event. The rendered line
 * doesn't say which event it is about, and ## Active commitments lists every
 * open recommendation, so arming off an older one would let the model ask about
 * the one it just suggested, in the exchange where it suggested it. Found in
 * review; an earlier version fell back.
 *
 * `touchedTimes` hold without arming: later activity on the same events, such
 * as a recommendation repeated in this conversation.
 */
function newestEventArming(
  times: readonly Date[],
  conversationWindowMs: number,
  now: number,
  touchedTimes: readonly Date[] = [],
): Arming | typeof HELD | null {
  let newest: number | null = null
  for (const time of times) {
    const at = time.getTime()
    if (!Number.isFinite(at)) continue
    if (newest === null || at > newest) newest = at
  }
  if (newest === null) return null
  if (newest + conversationWindowMs > now) return HELD // still the conversation it happened in
  if (touchedTimes.some((t) => t.getTime() + conversationWindowMs > now)) return HELD // re-suggested in this conversation
  return { eventAt: new Date(newest), eligibleAt: new Date(newest + conversationWindowMs) }
}

/**
 * How this intention arms right now, or null when nothing arms it.
 *
 * - visit_confirmed: the earliest confirmed visit (TAC-436 ruling 3).
 *   understand_order is ungated and belongs to the first exchange after one.
 * - first_contact: this turn, the first turn its gate is seen open.
 * - open_recommendation / recorded_order (event-armed): the NEWEST event (ruling
 *   1), anchored at the moment it became part of a DIFFERENT conversation, i.e.
 *   once it is older than the conversation window (ruling 2). Until then the
 *   intention neither arms nor renders; see newestEventArming.
 *   That is followup_rules.recent_conversation_hours, the same number followups
 *   and the brake use; there is no second one. "Did you try it?" a minute after
 *   suggesting it is absurd, and raising it closes the intention.
 *
 *   The anchor is that moment, not the event itself. Anchored at the event, the
 *   askable time left would be the window minus the conversation length, and a
 *   venue configured at 72 hours or more would never reach these at all.
 *
 *   Newest rather than the first ever: recommendations never leave `open`, so
 *   arming off the first one would block any guest with an old recommendation
 *   for good (the invite_contact_save shape), and the same holds for a guest
 *   whose first order is long past.
 */
function armingFor(
  def: IntentionDefinition,
  input: DeriveOpenIntentionsInput,
): Arming | typeof HELD | null {
  const now = input.now.getTime()
  switch (def.armsOn.kind) {
    case 'visit_confirmed':
      return input.visitConfirmedAt === null
        ? null
        : { eligibleAt: input.visitConfirmedAt, eventAt: input.visitConfirmedAt }
    case 'first_contact':
      return { eligibleAt: input.now, eventAt: input.now }
    case 'open_recommendation':
      // Fail closed, as the read at build-runtime-context.ts:203 does: with the
      // recommendations unreadable the hold can't be judged, so hold rather than
      // let "did you try it?" follow a suggestion made in this exchange.
      if (input.openRecommendationsUnreadable) return HELD
      return newestEventArming(
        input.openRecommendationTimes,
        input.conversationWindowMs,
        now,
        input.openRecommendationTouchedTimes,
      )
    case 'recorded_order':
      return newestEventArming(input.recordedOrderTimes, input.conversationWindowMs, now)
  }
}

/**
 * Whether an intention's last prompt went unanswered, by the brake's own rule.
 * A re-arm waits on it. Re-arming past an ignored question would ask a guest who
 * stopped answering after every new order, and a single re-arming intention
 * can't build the brake's streak of two on its own, because its row only ever
 * holds its latest prompt. Found in review.
 *
 * A pessimistic closure asked nothing, and a prompt older than the visible
 * inbound history can't be judged; neither holds a re-arm up (ruling 1's
 * direction), so a held re-arm lifts once its prompt ages out of that history.
 */
function lastPromptWentUnanswered(
  prompt: PromptedIntentionRow | undefined,
  input: DeriveOpenIntentionsInput,
): boolean {
  if (prompt === undefined || prompt.promptSource === 'pessimistic') return false
  const promptedAt = prompt.promptedAt.getTime()
  if (promptedAt < input.inboundHistoryFrom.getTime()) return false
  return !wasAnswered(promptedAt, input.inboundTimes, input.conversationWindowMs)
}

/**
 * TAC-436: whether this is the guest's FIRST-EVER inbound at this venue.
 *
 * Read off `repliedMessageCount`, the lifetime inbound count the gate already
 * compares against, rather than a separately-plumbed flag that could drift from
 * it. The webhook INSERTs the inbound before handing off to the agent
 * (app/api/webhooks/sendblue/route.ts), so on a first-ever message the count is
 * 1; `<= 1` also covers a count of 0 rather than depending on that ordering.
 *
 * Deliberately NOT `recentMessages.length === 0`, which is a 14-day window and
 * is also true for a guest returning after a long gap.
 *
 * Safe because deriveOpenIntentions only ever runs on an inbound turn:
 * build-runtime-context guards the whole derivation on `input.currentMessage`
 * and sets `openIntentions: []` otherwise.
 */
export function isFirstEverInboundTurn(repliedMessageCount: number): boolean {
  return repliedMessageCount <= 1
}

/**
 * The right to ask. An exhaustive switch, so a fourth gate kind fails `tsc`
 * until someone decides what it requires.
 *
 * `replies_only` (TAC-436 ruling 2) drops the response-rate floor, which is
 * unreachable in a guest's first turns by construction — see IntentionGate.
 * Its first-message count is stated per intention and is NOT venue-overridable:
 * `min_replies` tunes the ongoing stagger, not the opening exchange.
 */
function gateOpen(def: IntentionDefinition, input: DeriveOpenIntentionsInput): boolean {
  switch (def.gate.kind) {
    case 'none':
      return true
    case 'replies_only': {
      const minReplies = isFirstEverInboundTurn(input.repliedMessageCount)
        ? def.gate.firstMessageMinReplies
        : (input.rules.min_replies[def.key] ?? def.gate.defaultMinReplies)
      return input.repliedMessageCount >= minReplies
    }
    case 'conversational': {
      const minReplies = input.rules.min_replies[def.key] ?? def.gate.defaultMinReplies
      return (
        input.responseRate >= input.rules.response_rate_floor &&
        input.repliedMessageCount >= minReplies
      )
    }
  }
}

/**
 * The agent's full derivation for one inbound turn: record state, plus live
 * arming and gating for intentions with no row yet, plus re-arming, plus the
 * brake.
 *
 * ELIGIBILITY IS STICKY for first-contact intentions. Once a row exists, that
 * row decides and the gate is never re-checked. A guest whose response rate
 * later drops keeps what was already eligible; disengagement is the brake's job.
 *
 * EVENT-ARMED INTENTIONS RE-ARM on a strictly newer event (rearmsOnNewerEvent),
 * whether the existing row was prompted, ran out unraised, or is still open.
 * Strictly newer means the event happened AFTER the row's stored eligible_at,
 * i.e. after the earlier event had already become askable. That is ruling 2's
 * one definition of a different visit: a second recommendation made in the same
 * conversation as the first is the same thing to ask about, and asking again is
 * the nagging re-arming must not become. Comparing against the stored anchor,
 * never an old event recomputed through today's window, means lengthening
 * recent_conversation_hours can't make an event look newer than itself.
 *
 * A re-arm is a fresh arming: the gate, satisfaction and expiry are checked
 * again. Its write moves eligible_at and nothing else. The row keeps its last
 * prompt, so the brake still counts it, and the intention reads as open again
 * because that prompt predates the new anchor (isReopened). A re-arm waits while
 * that last prompt went unanswered (lastPromptWentUnanswered).
 *
 * WHILE AN EVENT-ARMED INTENTION'S NEWEST EVENT IS MID-CONVERSATION it neither
 * arms nor renders, even off an older event, and even as an already-open row.
 * The turn is skipped, not the intention (newestEventArming). If the open
 * recommendations couldn't be read, got_the_recommendation is held the same way:
 * that read fails closed, as the read at build-runtime-context.ts:203 does.
 */
export function deriveOpenIntentions(input: DeriveOpenIntentionsInput): DeriveOpenIntentionsResult {
  if (input.rows === null) return { open: [], newlyEligible: [], brakeEngaged: false }

  const entries = new Map<IntentionKey, IntentionStateEntry>()
  const keysWithRows = new Set<IntentionKey>()
  const lastPromptByKey = new Map<IntentionKey, PromptedIntentionRow>()
  for (const row of input.rows.prompted) {
    // A retired key resolves to null and is skipped; a renamed one resolves to
    // its successor (resolveIntentionKey).
    const key = resolveIntentionKey(row.intentionKey)
    if (key === null) continue
    keysWithRows.add(key)
    lastPromptByKey.set(key, row)
    entries.set(key, {
      eligibleAt: row.eligibleAt ?? row.promptedAt,
      promptedAt: row.promptedAt,
    })
  }
  for (const row of input.rows.eligible) {
    const key = resolveIntentionKey(row.intentionKey)
    if (key === null) continue
    keysWithRows.add(key)
    if (row.eligibleAt === null || entries.has(key)) continue
    entries.set(key, { eligibleAt: row.eligibleAt, promptedAt: null })
  }

  const newlyEligible: NewlyEligibleIntention[] = []
  // Event-armed intentions held this turn (see HELD). None of them renders,
  // open row or not; the intentions themselves are kept.
  const held = new Set<IntentionKey>()
  for (const def of INTENTION_DEFINITIONS) {
    const existing = entries.get(def.key)
    // Sticky unless this intention re-arms: an existing row decides.
    if (existing !== undefined && !rearmsOnNewerEvent(def.armsOn)) continue
    // A re-armable row with no anchor could never be stamped closed, because its
    // stamp is guarded on eligible_at, so it would be asked every turn. Nothing
    // writes one; leave it alone rather than render it.
    if (existing === undefined && keysWithRows.has(def.key) && rearmsOnNewerEvent(def.armsOn)) continue

    const armed = armingFor(def, input)
    if (armed === HELD) {
      held.add(def.key)
      continue
    }
    if (armed === null) continue
    if (existing !== undefined) {
      if (existing.eligibleAt === null) continue
      if (armed.eventAt.getTime() <= existing.eligibleAt.getTime()) continue // not strictly newer
      if (lastPromptWentUnanswered(lastPromptByKey.get(def.key), input)) continue
    }

    if (!gateOpen(def, input)) continue
    if (def.isSatisfied(input.facts)) continue // no point recording a closed intention
    if (isExpired(def, armed.eligibleAt, input.now)) continue
    // A re-armed row keeps its last prompt; isReopened reads it as open again.
    entries.set(def.key, { eligibleAt: armed.eligibleAt, promptedAt: existing?.promptedAt ?? null })
    if (existing !== undefined) {
      newlyEligible.push({ key: def.key, eligibleAt: armed.eligibleAt, rearm: true })
    } else if (!keysWithRows.has(def.key)) {
      newlyEligible.push({ key: def.key, eligibleAt: armed.eligibleAt, rearm: false })
    }
  }

  const brakeEngaged = isIntentionBrakeEngaged({
    prompted: input.rows.prompted,
    inboundTimes: input.inboundTimes,
    conversationWindowMs: input.conversationWindowMs,
    inboundHistoryFrom: input.inboundHistoryFrom,
    streak: input.rules.unanswered_streak,
  })

  return {
    open: brakeEngaged
      ? []
      : deriveIntentionState({ entries, facts: input.facts, now: input.now }).filter(
          (o) => !held.has(o.key),
        ),
    newlyEligible,
    brakeEngaged,
  }
}

/**
 * Current-turn-only suppression of `understand_order`. TAC-323's extractor runs
 * post-send under waitUntil, so on the exact turn a guest names their order no
 * transaction exists yet and understand_order still derives open — which would
 * put "you haven't heard what this guest ordered yet" in the prompt for the
 * very message answering it. That contradiction is the likeliest path to a
 * re-ask.
 *
 * Uses the prefilter, not the LLM extractor: pure string work answering "does
 * this message name a menu item", which is enough to avoid contradicting a
 * message visible in the thread.
 *
 * Writes nothing and closes nothing, so it costs exactly one turn: the next
 * turn's derivation recomputes from recorded state alone.
 */
export function applyCurrentTurnSuppression(
  open: readonly OpenIntention[],
  currentInboundBody: string | null,
  menuItems: readonly Pick<MenuItem, 'name'>[],
): OpenIntention[] {
  if (currentInboundBody === null) return [...open]
  if (!bodyMentionsMenuItem(currentInboundBody, menuItems)) return [...open]
  return open.filter((o) => o.key !== 'understand_order')
}

/**
 * The intentions that actually RENDER on this turn, once it is classified.
 *
 * TAC-380 trap 4. This is the single predicate both the prompt mapper
 * (buildAiRuntime) and the recording gate (handle-inbound) read. Ruling 4
 * closes intentions pessimistically when the classifier fails twice, so
 * recording against anything wider than what was rendered would close
 * intentions the guest never saw.
 *
 * - `opt_out` (TAC-328): a guest asking to stop being contacted never shares a
 *   prompt with a goal to pursue.
 * - `comp_complaint` (TAC-436): an apology turn never carries an intention
 *   question. **This entry MUST stay in step with shouldRenderOpenIntentions in
 *   lib/ai/prompts/serializers.ts**, which is the render-side half of the same
 *   suppression. Adding a category there and not here does not leak a question
 *   into the reply — the block genuinely does not render — it does something
 *   quieter and worse: the post-send classifier is still offered intentions the
 *   prompt never showed, so a false positive closes one the guest never saw,
 *   and a double classifier failure closes ALL of them pessimistically. Caught
 *   by TAC-436's own gate run, on a comp_complaint turn reporting four
 *   intentions offered against a reply generated without the block.
 * - A pending knowledge-gap question (ruling 6): the venue owes the guest an
 *   answer before it asks anything new. This burns a turn, not the intention —
 *   a suppressed intention is never recorded, so it stays open.
 *
 * A null category (no classification yet) suppresses nothing here; the
 * serializer keeps its own opt_out check as a second line of defence.
 */
export function renderableIntentions(
  open: readonly OpenIntention[],
  category: MessageCategory | null,
  hasPendingQuestion: boolean,
): OpenIntention[] {
  if (category === 'opt_out' || category === 'comp_complaint' || hasPendingQuestion) return []
  return [...open]
}
