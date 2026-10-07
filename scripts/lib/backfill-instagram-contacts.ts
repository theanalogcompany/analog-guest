// TAC-515: the pure half of the Instagram history import, split out because
// the entry script calls main() at the top level, so importing it would start
// a run (the split scripts/lib/instagram-smoke.ts makes for the same reason).
//
// Everything that DECIDES is here: which side of a conversation is the venue,
// which messages are imported and which are skipped and why, and what the dry
// run may conclude about Meta's identifiers. The entry script only reads,
// writes and prints, and it runs the same planner for --dry-run and --confirm,
// so a dry run cannot describe an import the real run would not make.
//
// THE TWO SKIP RULES are what make the import inert, and each is a rule about
// TIME because almost every scan in this repo keys on messages.created_at:
//
//   too_recent   nothing from the last 24 hours. The warm-close timer derives
//                its due set from Instagram rows created in the last two hours,
//                and a staff reply imported minutes after it was sent would be
//                a row it can act on. 24 hours also puts every imported row
//                outside Meta's reply window by construction. A rerun a day
//                later picks these up.
//   after_live   for a guest who already has messages this import did not
//                write, nothing dated at or after the oldest of them. The
//                import only ever extends a thread BACKWARDS, so it can never
//                sit between a live inbound and its reply, and the reply
//                check, the coalescing window, the inquiry follow-up and the
//                scan greeting all read rows after a live one.
//
// No `@/` import that constructs a client: types only.

import type {
  ConversationMessage,
  ConversationParticipant,
  InstagramConversation,
} from '@/lib/messaging/instagram/fetch-conversations'

export const INSTAGRAM_BACKFILL_CREATED_VIA = 'instagram_backfill'

export const BACKFILL_TOO_RECENT_MS = 24 * 60 * 60 * 1000

export type BackfillArgs = {
  venue?: string
  dryRun: boolean
  confirm: boolean
  rollback: boolean
  includeGuestsWithLiveMessages: boolean
  unrecognised: string[]
}

export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const out: BackfillArgs = {
    dryRun: false,
    confirm: false,
    rollback: false,
    includeGuestsWithLiveMessages: false,
    unrecognised: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--venue') out.venue = argv[++i]
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--confirm') out.confirm = true
    else if (arg === '--rollback') out.rollback = true
    else if (arg === '--include-guests-with-live-messages')
      out.includeGuestsWithLiveMessages = true
    else out.unrecognised.push(arg)
  }
  return out
}

/** Why these arguments cannot start a run, or null when they can. */
export function backfillArgsError(args: BackfillArgs): string | null {
  // An unknown flag is refused, never ignored: `--rolback --confirm` would
  // otherwise be a real import.
  if (args.unrecognised.length > 0)
    return `unrecognised argument(s): ${args.unrecognised.join(' ')}`
  if (!args.venue || args.venue.startsWith('--'))
    return '--venue <slug> is required'
  if (args.dryRun === args.confirm)
    return 'pass exactly one of --dry-run or --confirm'
  if (args.includeGuestsWithLiveMessages && !args.rollback)
    return '--include-guests-with-live-messages only applies to --rollback'
  return null
}

export type VenueAccount = { userId: string; username: string | null }

export type ConversationSkipReason =
  /** Not exactly two participants: a group thread has no single guest. */
  | 'not_one_to_one'
  /** Neither participant, or both, matched the token's own account. */
  | 'venue_side_unidentified'
  /** Meta listed the conversation or a participant in a form we cannot read. */
  | 'unreadable'
  /** An unknown person, and nothing in the thread could be imported. */
  | 'no_importable_messages'
  /**
   * An unknown person who has importable messages FROM the venue and none of
   * their own. The venue's own activity never creates a guest (ruled
   * 2026-09-18, handle-events.ts): staff messaging a supplier is not a guest.
   */
  | 'no_inbound_from_guest'
  /** A live webhook created this guest while the run was working on it. */
  | 'guest_created_concurrently'
  | 'guest_write_failed'

export type MessageSkipReason =
  /** Meta listed it in a form we cannot read (no usable id). */
  | 'unreadable'
  /** Only the id came back, and Meta refused the fetch by id. */
  | 'detail_unavailable'
  | 'no_timestamp'
  /** Sent by neither the venue nor the conversation's guest. */
  | 'unknown_sender'
  /** No text: an attachment, a share, a reaction. */
  | 'no_text'
  | 'too_recent'
  | 'after_live'
  /** Importable, but its conversation was skipped as a whole. */
  | 'conversation_skipped'

export function emptyMessageSkips(): Record<MessageSkipReason, number> {
  return {
    unreadable: 0,
    detail_unavailable: 0,
    no_timestamp: 0,
    unknown_sender: 0,
    no_text: 0,
    too_recent: 0,
    after_live: 0,
    conversation_skipped: 0,
  } satisfies Record<MessageSkipReason, number>
}

export function emptyConversationSkips(): Record<
  ConversationSkipReason,
  number
> {
  return {
    not_one_to_one: 0,
    venue_side_unidentified: 0,
    unreadable: 0,
    no_importable_messages: 0,
    no_inbound_from_guest: 0,
    guest_created_concurrently: 0,
    guest_write_failed: 0,
  } satisfies Record<ConversationSkipReason, number>
}

export type VenueSideMatch = 'user_id' | 'username'

export type ConversationSides =
  | {
      ok: true
      venue: ConversationParticipant
      guest: ConversationParticipant
      /**
       * Which of the account's two identifiers named the venue's participant.
       * Meta documents participant ids as Instagram-scoped and says nothing
       * about which id the account itself appears under, so both are tried
       * and the run reports which one matched.
       */
      matchedBy: VenueSideMatch
    }
  | { ok: false; reason: 'not_one_to_one' | 'venue_side_unidentified' }

function sameHandle(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
}

function venueMatch(
  participant: ConversationParticipant,
  account: VenueAccount,
): VenueSideMatch | null {
  if (participant.id === account.userId) return 'user_id'
  if (sameHandle(participant.username, account.username)) return 'username'
  return null
}

export function resolveConversationSides(
  conversation: InstagramConversation,
  account: VenueAccount,
): ConversationSides {
  if (conversation.participants.length !== 2)
    return { ok: false, reason: 'not_one_to_one' }
  const [first, second] = conversation.participants
  const firstMatch = venueMatch(first, account)
  const secondMatch = venueMatch(second, account)
  // Both matching is as unusable as neither: there is no guest to file under.
  if ((firstMatch === null) === (secondMatch === null))
    return { ok: false, reason: 'venue_side_unidentified' }
  return firstMatch !== null
    ? { ok: true, venue: first, guest: second, matchedBy: firstMatch }
    : {
        ok: true,
        venue: second,
        guest: first,
        matchedBy: secondMatch ?? 'user_id',
      }
}

export type MessageDirection = 'inbound' | 'outbound'

/** Who sent it, or null when it is neither side of this conversation. */
export function messageDirection(
  message: ConversationMessage,
  sides: Extract<ConversationSides, { ok: true }>,
): MessageDirection | null {
  if (message.fromId !== null) {
    if (message.fromId === sides.venue.id) return 'outbound'
    if (message.fromId === sides.guest.id) return 'inbound'
  }
  if (sameHandle(message.fromUsername, sides.venue.username)) return 'outbound'
  if (sameHandle(message.fromUsername, sides.guest.username)) return 'inbound'
  return null
}

export type PlannedMessage = {
  mid: string
  direction: MessageDirection
  body: string
  at: Date
}

export type ConversationPlan = {
  /** Oldest first, the order they are written in. */
  toInsert: PlannedMessage[]
  /** Messages whose Meta id is already a provider_message_id of ours. */
  alreadyStored: number
  /**
   * Of those, the ones an earlier import did NOT write. Only these are
   * evidence about Meta's ids: a row this script wrote under Meta's id matches
   * Meta's id by construction and proves nothing about the webhook's.
   */
  alreadyStoredLive: number
  /** Of the live ones, how many we hold with the direction derived here. */
  directionAgreed: number
  directionDisagreed: number
  /**
   * Messages dated inside the period we were already recording this guest. If
   * Meta's ids are the webhook's, some of these must be among alreadyStored.
   */
  datedInLivePeriod: number
  skipped: Record<MessageSkipReason, number>
  /** The oldest message being imported: a new guest's first_contacted_at. */
  firstContactedAt: Date | null
  lastInboundAt: Date | null
  lastInteractionAt: Date | null
}

export type PlanConversationInput = {
  messages: readonly ConversationMessage[]
  sides: Extract<ConversationSides, { ok: true }>
  /** Rows we already hold for these Meta ids, and whether an import wrote each. */
  storedByMid: ReadonlyMap<string, { direction: string; imported: boolean }>
  /** This guest's oldest message the import did not write, or null. */
  oldestLiveMessageAt: Date | null
  now: Date
}

/**
 * Pure. What importing this conversation would write and what it would leave.
 *
 * "Already stored" is decided FIRST, before either skip rule, because it is
 * the evidence the dry run reads: a live guest's recent messages are exactly
 * the ones both rules would skip, and counting them as skipped would hide
 * whether Meta's ids matched ours.
 */
export function planConversation(
  input: PlanConversationInput,
): ConversationPlan {
  const plan: ConversationPlan = {
    toInsert: [],
    alreadyStored: 0,
    alreadyStoredLive: 0,
    directionAgreed: 0,
    directionDisagreed: 0,
    datedInLivePeriod: 0,
    skipped: emptyMessageSkips(),
    firstContactedAt: null,
    lastInboundAt: null,
    lastInteractionAt: null,
  }
  const liveFrom = input.oldestLiveMessageAt

  for (const message of input.messages) {
    const direction = messageDirection(message, input.sides)
    const inLivePeriod =
      liveFrom !== null &&
      message.createdAt !== null &&
      message.createdAt.getTime() >= liveFrom.getTime()
    if (inLivePeriod) plan.datedInLivePeriod += 1

    const stored = input.storedByMid.get(message.id)
    if (stored !== undefined) {
      plan.alreadyStored += 1
      if (!stored.imported) {
        plan.alreadyStoredLive += 1
        if (direction !== null) {
          if (stored.direction === direction) plan.directionAgreed += 1
          else plan.directionDisagreed += 1
        }
      }
      continue
    }

    if (message.needsDetail) plan.skipped.detail_unavailable += 1
    else if (message.createdAt === null) plan.skipped.no_timestamp += 1
    else if (direction === null) plan.skipped.unknown_sender += 1
    else if (message.text === null) plan.skipped.no_text += 1
    else if (
      input.now.getTime() - message.createdAt.getTime() <
      BACKFILL_TOO_RECENT_MS
    )
      plan.skipped.too_recent += 1
    else if (inLivePeriod) plan.skipped.after_live += 1
    else
      plan.toInsert.push({
        mid: message.id,
        direction,
        body: message.text,
        at: message.createdAt,
      })
  }

  plan.toInsert.sort((a, b) => a.at.getTime() - b.at.getTime())
  for (const message of plan.toInsert) {
    if (plan.firstContactedAt === null) plan.firstContactedAt = message.at
    plan.lastInteractionAt = message.at
    if (message.direction === 'inbound') plan.lastInboundAt = message.at
  }
  return plan
}

export type CheckVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

export type IdentifierCheck = {
  name: string
  verdict: CheckVerdict
  detail: string
}

export type IdentifierEvidence = {
  /** Instagram guests this venue had before the run, imports excluded. */
  existingInstagramGuests: number
  /** Conversations whose guest participant id is one of THOSE guests. */
  knownLiveGuests: number
  datedInLivePeriod: number
  /** Matches against rows an import did not write. */
  alreadyStoredLive: number
  directionAgreed: number
  directionDisagreed: number
}

/**
 * Pure. What this run shows about Meta's identifiers, which is what the whole
 * import leans on: a guest is matched by participant id, and a message is
 * deduped against the live webhook by message id.
 *
 * Each check is INCONCLUSIVE, never PASS, when there was nothing to compare:
 * an account we have never recorded proves nothing either way. FAIL means we
 * HAD rows that should have matched and none did, which is the shape two
 * different id spaces would produce, and --confirm refuses on it.
 */
export function identifierChecks(
  evidence: IdentifierEvidence,
): IdentifierCheck[] {
  const guest: IdentifierCheck =
    evidence.knownLiveGuests > 0
      ? {
          name: 'guest ids',
          verdict: 'PASS',
          detail: `${evidence.knownLiveGuests} conversation(s) matched a guest the webhook created, by participant id`,
        }
      : evidence.existingInstagramGuests === 0
        ? {
            name: 'guest ids',
            verdict: 'INCONCLUSIVE',
            detail:
              'this venue has no Instagram guests on record to compare against',
          }
        : {
            name: 'guest ids',
            verdict: 'FAIL',
            detail: `the venue has ${evidence.existingInstagramGuests} Instagram guest(s) on record and no conversation matched any of them: participant ids are not the ids the webhook stores`,
          }

  const message: IdentifierCheck =
    evidence.alreadyStoredLive > 0
      ? {
          name: 'message ids',
          verdict: 'PASS',
          detail: `${evidence.alreadyStoredLive} message(s) matched a row the webhook stored, by Meta's message id (${evidence.datedInLivePeriod} were dated inside a period we were recording)`,
        }
      : evidence.datedInLivePeriod === 0
        ? {
            name: 'message ids',
            verdict: 'INCONCLUSIVE',
            detail:
              'no message was dated inside a period we were already recording, so there was nothing to match',
          }
        : {
            name: 'message ids',
            verdict: 'FAIL',
            detail: `${evidence.datedInLivePeriod} message(s) were dated inside a period we were recording and none matched a stored row: Meta's message id here is not the webhook's mid, so a later webhook would double every import`,
          }

  const direction: IdentifierCheck =
    evidence.directionDisagreed > 0
      ? {
          name: 'direction',
          verdict: 'FAIL',
          detail: `${evidence.directionDisagreed} matched message(s) are stored with the opposite direction to the one this run derived: the venue's side of a conversation is being misread`,
        }
      : evidence.directionAgreed > 0
        ? {
            name: 'direction',
            verdict: 'PASS',
            detail: `${evidence.directionAgreed} matched message(s) are stored with the same direction this run derived`,
          }
        : {
            name: 'direction',
            verdict: 'INCONCLUSIVE',
            detail: 'no matched message to compare a direction against',
          }

  return [guest, message, direction]
}

/**
 * Pure. Could the daily follow-up engine log a perk-unlock task for a guest
 * this import creates, from the import alone?
 *
 * An imported guest has no visits, so recognition leaves them in the lowest
 * state; the engine's perk detector fires for a mechanic whose `min_state`
 * that state meets. So the question is whether perk unlock is on AND an active
 * mechanic asks for no more than the lowest state.
 *
 * WHAT THIS DOES NOT COVER. Imported messages do feed one recognition signal,
 * the response rate (default weight 0.1, so at most 10 points against a
 * lowest band that is 25 wide by default). A venue with its own formula or
 * thresholds could let that alone lift a guest a band; this reads neither.
 */
export function perkUnlockCouldFire(input: {
  perkUnlockEnabled: boolean
  activeMechanicMinStates: readonly string[]
  lowestState: string
}): boolean {
  return (
    input.perkUnlockEnabled &&
    input.activeMechanicMinStates.some((state) => state === input.lowestState)
  )
}

/** A trimmed non-empty handle, or null. The column refuses a blank one. */
export function usernameForInsert(
  participant: ConversationParticipant,
): string | null {
  const trimmed = participant.username?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}
