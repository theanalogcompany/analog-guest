// TAC-515: import a venue's existing Instagram conversations, once, so the
// agent can tell someone who has been messaging the shop for months from
// someone new, and has their recent history. Run by hand, by a person who
// means it, with the venue owner's agreement to importing message content.
//
//   npm run backfill-instagram-contacts -- --venue <slug> --dry-run
//   npm run backfill-instagram-contacts -- --venue <slug> --confirm
//   npm run backfill-instagram-contacts -- --venue <slug> --rollback --dry-run
//   npm run backfill-instagram-contacts -- --venue <slug> --rollback --confirm
//   npm run backfill-instagram-contacts -- --venue <slug> --attachments-only --dry-run
//   npm run backfill-instagram-contacts -- --venue <slug> --attachments-only --confirm [--limit <n>]
//   npm run backfill-instagram-contacts -- --venue <slug> --media-only --dry-run
//   npm run backfill-instagram-contacts -- --venue <slug> --media-only --confirm [--limit <n>]
//
// --attachments-only AND --media-only (TAC-582) ARE DIFFERENT RUNS, each
// described above its own function. The first writes `message_attachments`
// rows for messages we already hold and never a guest or a message. The
// second imports the photos, videos and reel shares this import skipped for
// having no text, as new message rows, for guests we already hold.
// Everything from here to the imports is about the import itself.
//
// WHAT IT WRITES, and nothing else:
//
//   guests    one per person the account has a one-to-one conversation with
//             and who is not already a guest here, keyed on
//             (venue_id, instagram_scoped_id) exactly as the webhook keys them
//             (lib/messaging/instagram/handle-events.ts), with
//             created_via 'instagram_backfill'. first_contacted_at is the
//             oldest message imported, which is the EARLIEST WE CAN SEE (Meta
//             returns at most 20 a conversation), not necessarily the first
//             they ever sent. A guest we already hold is never updated.
//   messages  inbound and outbound, shaped like the webhook's own message and
//             echo rows, under Meta's message id so a rerun or a later live
//             webhook cannot double one. created_at is META'S time for the
//             message; provider_sent_at is NULL.
//   ledger    one instagram_backfill_messages row per imported message,
//             written BEFORE the message (migration 075).
//
// HISTORY ONLY. Nothing here calls the agent, a dispatcher or a scheduler, and
// the only Graph module it imports has no POST in it. What keeps LATER code
// from acting on an imported row is the two skip rules in
// scripts/lib/backfill-instagram-contacts.ts (nothing from the last 24 hours;
// nothing dated after a guest's oldest live message) and provider_sent_at
// being NULL: the 24-hour reply window reads only rows that have one
// (lib/messaging/instagram/window.ts), so an imported row never opens it.
//
// WHAT AN IMPORTED ROW DOES CHANGE, on purpose (ruled 2026-10-07): the guest's
// NEXT REAL message is handled as a returning guest's. first_contacted_at is
// old, so it is not a first conversation; recognition counts imported replies
// (lib/recognition/load-signals.ts has no time bound), so the reply-count
// gates on getting-to-know-you questions are already open; and the last 14
// days of imported messages are in the prompt as history, the venue's side as
// assistant turns. That is the point of the import. Nothing is SENT because
// of it until the guest writes.
//
// RUN IT OUTSIDE THE VENUE'S OPENING HOURS. The plan is read and then written,
// and a guest who messages in between is skipped rather than merged.
//
// --confirm READS EVERYTHING BEFORE IT WRITES ANYTHING. It builds the same plan
// --dry-run prints, checks Meta's identifiers against rows we already hold,
// and refuses on a FAIL. Meta does not document that a conversation's message
// id is the webhook's mid, and if it is not, every import would be doubled by
// the next live message. The first run against an account we were already
// recording is what proves it; a fresh account has nothing to compare and
// reads INCONCLUSIVE.
//
// RESUME IS A RERUN. Every write is keyed (the guest on its scoped id, the
// message on Meta's id), so a run interrupted anywhere is finished by running
// it again, and a rerun a day later picks up what `too_recent` held back.
//
// WHAT IT PRINTS: counts, reasons and verdicts. NEVER a handle, a scoped id, a
// message id or message text (TAC-458), in either mode.

import { randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { createAdminClient } from '@/lib/db/admin'
import type { ParsedAttachment } from '@/lib/messaging/attachments/kind'
import { deleteAttachmentsForGuests } from '@/lib/messaging/attachments/delete'
import {
  GUEST_MEDIA_BUCKET,
  rehostAttachment,
  storagePathFor,
} from '@/lib/messaging/attachments/rehost'
import {
  insertMessageAttachments,
  loadPendingAttachmentsForMessage,
} from '@/lib/messaging/attachments/store'
import { resolveInstagramAccessToken } from '@/lib/messaging/instagram/credentials-store'
import {
  fetchConversationPage,
  fetchMessageDetail,
  isGraphRateLimited,
  type ConversationMessage,
  type ConversationPage,
  type InstagramConversation,
} from '@/lib/messaging/instagram/fetch-conversations'
import {
  isTokenRejected,
  type GraphFailure,
  type GraphResult,
} from '@/lib/messaging/instagram/graph'
import { fetchConnectedAccount } from '@/lib/messaging/instagram/oauth-exchange'
import { loadThresholds } from '@/lib/recognition/compute-state'
import { computeRelationshipStrength } from '@/lib/recognition/compute-strength'
import { evaluateState } from '@/lib/recognition/evaluate-state'
import { GUEST_STATES } from '@/lib/recognition/types'
import { parseFollowupRules } from '@/lib/schemas'
import {
  controlCheck,
  createAttachmentsPlanner,
  emptyKindCounts,
  type StoredInstagramRow,
} from './lib/backfill-instagram-attachments'
import {
  MEDIA_ONLY_HOLD_BACK_DAYS,
  decideMediaMessage,
  emptyMediaSkips,
  scoreBounds,
  stateCouldMove,
  topCounts,
  type PlannedMediaMessage,
} from './lib/backfill-instagram-media'
import {
  INSTAGRAM_BACKFILL_CREATED_VIA,
  backfillArgsError,
  emptyConversationSkips,
  emptyMessageSkips,
  identifierChecks,
  messageDirection,
  parseBackfillArgs,
  perkUnlockCouldFire,
  planConversation,
  resolveConversationSides,
  usernameForInsert,
  type BackfillArgs,
  type ConversationPlan,
  type ConversationSkipReason,
  type MessageSkipReason,
  type VenueSideMatch,
} from './lib/backfill-instagram-contacts'

type AdminSupabaseClient = SupabaseClient<Database>
type MessageInsert = Database['public']['Tables']['messages']['Insert']
type GuestInsert = Database['public']['Tables']['guests']['Insert']

const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514'

/** Between any two Graph calls. Meta publishes no budget for this endpoint. */
const GRAPH_DELAY_MS = 300
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000]
const TRANSIENT_RETRY_MS = 5_000
/** Meta ids are long; this keeps an `in (...)` filter inside a safe URL. */
const ID_CHUNK = 10
const ROW_PAGE = 1000

const USAGE =
  'usage: npm run backfill-instagram-contacts -- --venue <slug> (--dry-run | --confirm) [--rollback [--include-guests-with-live-messages] | (--attachments-only | --media-only) [--limit <n>]]'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

/** Code, subcode, type and trace id only. Never Meta's message (graph.ts). */
function describeFailure(failure: GraphFailure): string {
  switch (failure.reason) {
    case 'timeout':
      return 'timed out'
    case 'network':
      return `network failure (${failure.errorName}${failure.causeCode ? `, ${failure.causeCode}` : ''})`
    case 'malformed_response':
      return `unreadable response (HTTP ${failure.httpStatus})`
    case 'graph_error':
      return `Meta refused it (HTTP ${failure.httpStatus}, code ${failure.code ?? 'none'}, subcode ${failure.subcode ?? 'none'}, type ${failure.type ?? 'none'}, fbtrace ${failure.fbtraceId ?? 'none'})`
  }
}

let graphCalls = 0
let rateLimitWaits = 0

/**
 * One polite Graph call: a fixed pause before it, a long backoff when Meta
 * throttles, one retry on a timeout or a dropped socket. Anything else comes
 * back as it is.
 */
async function callGraph<T>(
  request: () => Promise<GraphResult<T>>,
): Promise<GraphResult<T>> {
  let transientRetried = false
  let rateLimitAttempt = 0
  for (;;) {
    await sleep(GRAPH_DELAY_MS)
    graphCalls += 1
    const result = await request()
    if (result.ok) return result
    if (isGraphRateLimited(result.failure)) {
      const wait = RATE_LIMIT_BACKOFF_MS[rateLimitAttempt]
      if (wait === undefined) return result
      rateLimitAttempt += 1
      rateLimitWaits += 1
      console.log(`· Meta is throttling; waiting ${wait / 1000}s`)
      await sleep(wait)
      continue
    }
    const transient =
      result.failure.reason === 'timeout' || result.failure.reason === 'network'
    if (transient && !transientRetried) {
      transientRetried = true
      await sleep(TRANSIENT_RETRY_MS)
      continue
    }
    return result
  }
}

function die(message: string, code = 1): never {
  console.error(`✗ ${message}`)
  process.exit(code)
}

type Venue = { id: string; slug: string; instagramAccountId: string }

async function loadVenue(
  supabase: AdminSupabaseClient,
  slug: string,
): Promise<Venue> {
  const { data, error } = await supabase
    .from('venues')
    .select('id, slug, instagram_account_id')
    .eq('slug', slug)
    .maybeSingle()
  if (error || !data)
    die(`venue ${slug} not found${error ? `: ${error.message}` : ''}`)
  if (!data.instagram_account_id)
    die(
      `venue ${slug} has no instagram_account_id, so there is no account to import from`,
    )
  return {
    id: data.id,
    slug: data.slug,
    instagramAccountId: data.instagram_account_id,
  }
}

/**
 * Whether migration 075's ledger table is there. A dry run works without it
 * (it has no imported rows to tell apart yet); a write never does.
 */
async function ledgerAvailable(
  supabase: AdminSupabaseClient,
): Promise<{ available: boolean; error: string | null }> {
  const { error } = await supabase
    .from('instagram_backfill_messages')
    .select('message_id')
    .limit(1)
  return { available: !error, error: error?.message ?? null }
}

async function ledgerIdsForGuest(
  supabase: AdminSupabaseClient,
  guestId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('instagram_backfill_messages')
    .select('message_id')
    .eq('guest_id', guestId)
    .limit(ROW_PAGE)
  if (error) die(`could not read the import ledger: ${error.message}`)
  // A full page may be a truncated one, and oldestLiveMessageAt's reasoning
  // needs the WHOLE set. Meta exposes 20 messages a conversation, so one guest
  // reaching this takes dozens of reruns; refusing is cheaper than paging.
  if ((data ?? []).length >= ROW_PAGE)
    die(
      `a guest has ${ROW_PAGE} or more imported messages on the ledger, more than this script reads in one page. Refusing rather than plan from a partial ledger.`,
    )
  return new Set((data ?? []).map((row) => row.message_id))
}

/**
 * This guest's oldest message the import did not write, or null when every
 * message they have is an import's.
 *
 * Reads one more row than the guest has ledger entries: that many rows cannot
 * all be ledgered, and with the rows oldest first, the first one that is not
 * is the oldest live message.
 */
async function oldestLiveMessageAt(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
  ledgerIds: ReadonlySet<string>,
): Promise<Date | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, created_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .order('created_at', { ascending: true })
    .limit(ledgerIds.size + 1)
  if (error) die(`could not read a guest's messages: ${error.message}`)
  const live = (data ?? []).find((row) => !ledgerIds.has(row.id))
  return live ? new Date(live.created_at) : null
}

/**
 * The rows we already hold under these Meta ids, and whether an import wrote
 * each. That flag is what keeps a rerun honest: a row this script wrote under
 * Meta's id matches Meta's id by construction, so only a row the WEBHOOK
 * stored says anything about whether the two id spaces are one.
 */
async function loadStoredByMid(
  supabase: AdminSupabaseClient,
  mids: readonly string[],
  hasLedger: boolean,
): Promise<Map<string, { direction: string; imported: boolean }>> {
  const stored = new Map<string, { direction: string; imported: boolean }>()
  for (const ids of chunk(mids, ID_CHUNK)) {
    const { data, error } = await supabase
      .from('messages')
      .select('id, provider_message_id, direction')
      .in('provider_message_id', ids)
    // The code only. PostgREST quotes the filter in a parse error, and the
    // filter here is a list of Meta's message ids.
    if (error)
      die(`could not look up stored messages (${error.code ?? 'no code'})`)
    const rows = data ?? []
    const imported = new Set<string>()
    if (hasLedger && rows.length > 0) {
      const ledger = await supabase
        .from('instagram_backfill_messages')
        .select('message_id')
        .in(
          'message_id',
          rows.map((row) => row.id),
        )
      if (ledger.error)
        die(`could not read the import ledger: ${ledger.error.message}`)
      for (const row of ledger.data ?? []) imported.add(row.message_id)
    }
    for (const row of rows) {
      if (row.provider_message_id !== null)
        stored.set(row.provider_message_id, {
          direction: row.direction,
          imported: imported.has(row.id),
        })
    }
  }
  return stored
}

/**
 * Every page of the token's conversations, in Meta's order. A Graph failure
 * that survives callGraph's retries stops the run: a partial read would print
 * counts that look like the whole account.
 */
async function* conversationPages(
  token: string,
  withMedia: boolean,
): AsyncGenerator<ConversationPage> {
  const cursorsSeen = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const after: string | null = cursor
    const page: GraphResult<ConversationPage> = await callGraph(() =>
      fetchConversationPage(token, fetch, after, withMedia),
    )
    if (!page.ok)
      die(
        `could not list conversations: ${describeFailure(page.failure)}. Nothing was written by this pass; run it again.`,
      )
    yield page.value

    cursor = page.value.nextCursor
    if (cursor === null) return
    if (cursorsSeen.has(cursor))
      die(
        'Meta returned the same paging cursor twice. Stopping rather than loop; nothing was written by this pass.',
      )
    cursorsSeen.add(cursor)
  }
}

/**
 * A conversation's messages, with each one Meta listed as a bare id fetched
 * on its own. A message Meta refuses by id comes back as it was listed, still
 * `needsDetail`: that is its documented answer for one past a conversation's
 * newest 20, and the only per-message outcome there is.
 */
async function withDetails(
  conversation: InstagramConversation,
  token: string,
  withMedia: boolean,
  onFetch: () => void,
): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = []
  for (const message of conversation.messages) {
    if (!message.needsDetail) {
      messages.push(message)
      continue
    }
    onFetch()
    const detail = await callGraph(() =>
      fetchMessageDetail(message.id, token, fetch, withMedia),
    )
    if (detail.ok) {
      messages.push(detail.value)
      continue
    }
    // Only Meta refusing THIS message is a per-message outcome. A dead
    // socket, a throttle that outlasted the backoff or a rejected token
    // would land every remaining message in the same bucket and the run
    // would print a short read as a complete one.
    const refusedThisMessage =
      detail.failure.reason === 'graph_error' &&
      !isGraphRateLimited(detail.failure) &&
      !isTokenRejected(detail.failure)
    if (!refusedThisMessage)
      die(
        `could not read a message: ${describeFailure(detail.failure)}. Nothing was written by this pass; run it again.`,
      )
    messages.push(message)
  }
  return messages
}

type PlannedConversation = {
  /** The guest's Instagram-scoped id. Held in memory, never printed. */
  igsid: string
  username: string | null
  /** Our guest row, or null when this run would create one. */
  guestId: string | null
  plan: ConversationPlan
}

type Collected = {
  /** Items in Meta's pages, readable or not. */
  conversationsSeen: number
  /** Messages Meta listed in the conversations this run considered. */
  messagesSeen: number
  detailFetches: number
  truncatedConversations: number
  planned: PlannedConversation[]
  conversationSkips: Record<ConversationSkipReason, number>
  messageSkips: Record<MessageSkipReason, number>
  venueMatchedBy: Record<VenueSideMatch, number>
  knownGuests: number
  /** Of knownGuests, the ones the webhook created rather than an import. */
  knownLiveGuests: number
  newGuests: number
  alreadyStored: number
  alreadyStoredLive: number
  toInsert: number
  datedInLivePeriod: number
  directionAgreed: number
  directionDisagreed: number
}

/**
 * Read every conversation and plan it. Writes nothing, in either mode.
 * A Graph failure that survives callGraph's retries stops the run: a partial
 * read would print counts that look like the whole account. The one failure
 * that does not stop it is Meta refusing a single message by id, which is its
 * documented answer for a message past a conversation's newest 20.
 */
async function collect(
  supabase: AdminSupabaseClient,
  venue: Venue,
  token: string,
  account: { userId: string; username: string | null },
  hasLedger: boolean,
  now: Date,
): Promise<Collected> {
  const out: Collected = {
    conversationsSeen: 0,
    messagesSeen: 0,
    detailFetches: 0,
    truncatedConversations: 0,
    planned: [],
    conversationSkips: emptyConversationSkips(),
    messageSkips: emptyMessageSkips(),
    venueMatchedBy: { user_id: 0, username: 0 },
    knownGuests: 0,
    knownLiveGuests: 0,
    newGuests: 0,
    alreadyStored: 0,
    alreadyStoredLive: 0,
    toInsert: 0,
    datedInLivePeriod: 0,
    directionAgreed: 0,
    directionDisagreed: 0,
  }

  for await (const page of conversationPages(token, false)) {
    // Meta's own count of what the page held, so a conversation the parser
    // could not read is a counted skip rather than one that was never seen.
    out.conversationsSeen += page.rawCount
    out.conversationSkips.unreadable +=
      page.rawCount - page.conversations.length

    for (const conversation of page.conversations) {
      if (conversation.unreadableParticipants > 0) {
        out.conversationSkips.unreadable += 1
        continue
      }
      const sides = resolveConversationSides(conversation, account)
      if (!sides.ok) {
        out.conversationSkips[sides.reason] += 1
        continue
      }
      out.venueMatchedBy[sides.matchedBy] += 1
      if (conversation.hasMoreMessages) out.truncatedConversations += 1
      // Counted from Meta's list, before the planner sees any of them, so the
      // reconciliation in runImport has something that can disagree with it.
      // Messages in a conversation skipped above were never considered.
      out.messagesSeen +=
        conversation.messages.length + conversation.unreadableMessages
      out.messageSkips.unreadable += conversation.unreadableMessages

      const messages = await withDetails(conversation, token, false, () => {
        out.detailFetches += 1
      })

      const { data: guestRow, error: guestError } = await supabase
        .from('guests')
        .select('id, created_via')
        .eq('venue_id', venue.id)
        .eq('instagram_scoped_id', sides.guest.id)
        .maybeSingle()
      if (guestError) die(`could not look up a guest: ${guestError.message}`)
      const guestId = guestRow?.id ?? null

      const ledgerIds =
        guestId !== null && hasLedger
          ? await ledgerIdsForGuest(supabase, guestId)
          : new Set<string>()
      const liveFrom =
        guestId !== null
          ? await oldestLiveMessageAt(supabase, venue.id, guestId, ledgerIds)
          : null
      const storedByMid = await loadStoredByMid(
        supabase,
        messages.map((message) => message.id),
        hasLedger,
      )

      const plan = planConversation({
        messages,
        sides,
        storedByMid,
        oldestLiveMessageAt: liveFrom,
        now,
      })

      out.alreadyStored += plan.alreadyStored
      out.alreadyStoredLive += plan.alreadyStoredLive
      out.datedInLivePeriod += plan.datedInLivePeriod
      out.directionAgreed += plan.directionAgreed
      out.directionDisagreed += plan.directionDisagreed
      for (const reason of Object.keys(plan.skipped) as MessageSkipReason[])
        out.messageSkips[reason] += plan.skipped[reason]

      if (guestId === null) {
        // No guest is made for a thread with nothing to file under them: a
        // guest row with no message tells the agent nothing, and
        // first_contacted_at would have no message to take its time from.
        // Nor for one where only the venue wrote: the webhook never makes a
        // guest from the venue's own activity, and neither does this.
        const skip: ConversationSkipReason | null =
          plan.toInsert.length === 0
            ? 'no_importable_messages'
            : plan.lastInboundAt === null
              ? 'no_inbound_from_guest'
              : null
        if (skip !== null) {
          out.conversationSkips[skip] += 1
          out.messageSkips.conversation_skipped += plan.toInsert.length
          continue
        }
        out.newGuests += 1
      } else {
        out.knownGuests += 1
        if (guestRow?.created_via !== INSTAGRAM_BACKFILL_CREATED_VIA)
          out.knownLiveGuests += 1
      }
      out.toInsert += plan.toInsert.length
      out.planned.push({
        igsid: sides.guest.id,
        username: usernameForInsert(sides.guest),
        guestId,
        plan,
      })
    }
  }
  return out
}

type Written = {
  guestsCreated: number
  messagesInserted: number
  messagesAlreadyStored: number
  messagesFailed: number
  conversationSkips: Record<ConversationSkipReason, number>
}

function messageRow(
  id: string,
  venueId: string,
  guestId: string,
  message: ConversationPlan['toInsert'][number],
): MessageInsert {
  const at = message.at.toISOString()
  const base: MessageInsert = {
    id,
    venue_id: venueId,
    guest_id: guestId,
    // Named explicitly: the column defaults to 'text' (migration 048).
    channel: 'instagram',
    direction: message.direction,
    status: message.direction === 'inbound' ? 'received' : 'sent',
    body: message.body,
    // Set only by --media-only, where the links are what makes a row with no
    // text one a reader shows at all (MESSAGE_HAS_CONTENT_FILTER).
    media_urls: message.mediaUrls ?? [],
    provider_message_id: message.mid,
    // NULL on purpose. The reply window reads only rows that carry one, so an
    // imported inbound can never open it. The message's own time is created_at.
    provider_sent_at: null,
    created_at: at,
  }
  // The echo row's shape (handle-events.ts echoInsert): no review_state and no
  // generated_by, because nothing in Meta's history says whether a person or
  // an app sent it.
  return message.direction === 'outbound' ? { ...base, sent_at: at } : base
}

/**
 * One imported message: its ledger row, then the message under the same id.
 * Shared by the import and --media-only so that every row either of them
 * writes is one the rollback can find.
 */
async function insertLedgeredMessage(
  supabase: AdminSupabaseClient,
  venue: Venue,
  guestId: string,
  runId: string,
  message: ConversationPlan['toInsert'][number],
): Promise<
  | { status: 'inserted'; id: string }
  | { status: 'already_stored' }
  | { status: 'failed' }
> {
  const id = randomUUID()
  // The marker goes in BEFORE the thing it marks. A crash after this line
  // leaves a ledger row with no message, which a rollback steps over; the
  // reverse would leave an imported message nothing identifies.
  const ledger = await supabase.from('instagram_backfill_messages').insert({
    message_id: id,
    venue_id: venue.id,
    guest_id: guestId,
    run_id: runId,
  })
  if (ledger.error) {
    console.error(
      `✗ a ledger insert failed, so its message was not written: ${ledger.error.message}`,
    )
    return { status: 'failed' }
  }

  const { error } = await supabase
    .from('messages')
    .insert(messageRow(id, venue.id, guestId, message))
  if (!error) return { status: 'inserted', id }
  if (error.code === UNIQUE_VIOLATION) {
    // The live webhook, or another run, saved this id first. That is the
    // dedupe working, not a failure, and the ONLY error that proves our
    // row is not there, so it is the only one that takes the marker back.
    await supabase
      .from('instagram_backfill_messages')
      .delete()
      .eq('message_id', id)
    return { status: 'already_stored' }
  }
  // The marker STAYS. An insert can commit and still report an error
  // (a dropped response, a late timeout), and removing the marker then
  // would leave an imported message nothing identifies. A marker with
  // no message is harmless; the reverse is not.
  console.error(`✗ a message insert failed: ${error.message} (${error.code})`)
  return { status: 'failed' }
}

async function apply(
  supabase: AdminSupabaseClient,
  venue: Venue,
  planned: readonly PlannedConversation[],
  runId: string,
): Promise<Written> {
  const written: Written = {
    guestsCreated: 0,
    messagesInserted: 0,
    messagesAlreadyStored: 0,
    messagesFailed: 0,
    conversationSkips: emptyConversationSkips(),
  }

  for (const item of planned) {
    let guestId = item.guestId
    if (guestId === null) {
      const guest: GuestInsert = {
        venue_id: venue.id,
        instagram_scoped_id: item.igsid,
        instagram_username: item.username,
        created_via: INSTAGRAM_BACKFILL_CREATED_VIA,
        first_contacted_at: item.plan.firstContactedAt?.toISOString() ?? null,
        last_inbound_at: item.plan.lastInboundAt?.toISOString() ?? null,
        last_interaction_at: item.plan.lastInteractionAt?.toISOString() ?? null,
      }
      const { data, error } = await supabase
        .from('guests')
        .insert(guest)
        .select('id')
        .single()
      if (error?.code === CHECK_VIOLATION)
        die(
          `a CHECK on guests refused the row (${error.code}), most likely created_via 'instagram_backfill': is migration 075 applied? Nothing more was written.`,
        )
      if (error?.code === UNIQUE_VIOLATION) {
        // A live webhook made this guest since the plan was read. Their thread
        // is now live, and the plan's cut-off was made without knowing that.
        // The next run plans them as a known guest.
        written.conversationSkips.guest_created_concurrently += 1
        continue
      }
      if (error || !data) {
        console.error(
          `✗ a guest insert failed: ${error?.message ?? 'no row returned'} (${error?.code ?? 'no code'})`,
        )
        written.conversationSkips.guest_write_failed += 1
        continue
      }
      guestId = data.id
      written.guestsCreated += 1
    }

    for (const message of item.plan.toInsert) {
      const outcome = await insertLedgeredMessage(
        supabase,
        venue,
        guestId,
        runId,
        message,
      )
      if (outcome.status === 'inserted') written.messagesInserted += 1
      else if (outcome.status === 'already_stored')
        written.messagesAlreadyStored += 1
      else written.messagesFailed += 1
    }
  }
  return written
}

function printCounts(
  title: string,
  counts: Record<string, number>,
  indent = '    ',
): void {
  const entries = Object.entries(counts).filter(([, count]) => count > 0)
  if (entries.length === 0) {
    console.log(`${indent}${title}: none`)
    return
  }
  console.log(`${indent}${title}:`)
  for (const [reason, count] of entries)
    console.log(`${indent}  ${reason}: ${count}`)
}

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0)
}

/**
 * The follow-up engine is the one thing that scans every guest, imported or
 * not. Print what it could do with one, and say whether the import alone
 * could make it log a perk-unlock task.
 */
async function perkUnlockPreflight(
  supabase: AdminSupabaseClient,
  venue: Venue,
): Promise<boolean> {
  const config = await supabase
    .from('venue_configs')
    .select('followup_rules')
    .eq('venue_id', venue.id)
    .maybeSingle()
  if (config.error)
    die(`could not read the venue's follow-up rules: ${config.error.message}`)
  const mechanics = await supabase
    .from('mechanics')
    .select('min_state')
    .eq('venue_id', venue.id)
    .eq('is_active', true)
  if (mechanics.error)
    die(`could not read the venue's mechanics: ${mechanics.error.message}`)

  const rules = parseFollowupRules(config.data?.followup_rules ?? null)
  const minStates = (mechanics.data ?? []).map((row) => row.min_state)
  const byState: Record<string, number> = {}
  for (const state of minStates) byState[state] = (byState[state] ?? 0) + 1
  const couldFire = perkUnlockCouldFire({
    perkUnlockEnabled: rules.perk_unlock_enabled,
    activeMechanicMinStates: minStates,
    lowestState: GUEST_STATES[0],
  })

  console.log('\nPerk unlock (the follow-up engine scans every guest):')
  console.log(`    perk_unlock_enabled: ${rules.perk_unlock_enabled}`)
  printCounts('active mechanics by min_state', byState)
  console.log(
    couldFire
      ? `    ✗ COULD FIRE: perk unlock is on and an active mechanic asks only for '${GUEST_STATES[0]}', the state an imported guest starts in.`
      : `    ✓ cannot fire from an import alone: ${rules.perk_unlock_enabled ? `no active mechanic asks only for '${GUEST_STATES[0]}'` : 'perk unlock is off'}.`,
  )
  return couldFire
}

/**
 * The venue's token, and proof that it is this venue's: the one mistake that
 * would read another account's conversations as this venue's.
 */
async function resolveVenueToken(
  supabase: AdminSupabaseClient,
  venue: Venue,
): Promise<{
  token: string
  account: { userId: string; username: string | null }
}> {
  const resolved = await resolveInstagramAccessToken(supabase, venue.id)
  if (!resolved.ok)
    die(`could not resolve the venue's token: ${resolved.error}`)
  if (resolved.resolved === null)
    die(
      'no Instagram token: the venue has no stored credential and INSTAGRAM_ACCESS_TOKEN is not set',
    )
  const token = resolved.resolved.token
  console.log(
    `\nToken: ${resolved.resolved.source === 'venue' ? "the venue's own stored credential" : 'the shared env token (no stored credential for this venue)'}`,
  )

  const account = await callGraph(() => fetchConnectedAccount(token, fetch))
  if (!account.ok)
    die(
      `could not read the token's account: ${describeFailure(account.failure)}`,
    )
  // The one mistake that would file another account's conversations under
  // this venue. Compared, never printed.
  if (account.value.userId !== venue.instagramAccountId)
    die(
      "the token belongs to a different Instagram account than venues.instagram_account_id. Refusing: its conversations are not this venue's.",
    )
  console.log("    belongs to the venue's Instagram account: yes")
  return { token, account: account.value }
}

async function runImport(
  supabase: AdminSupabaseClient,
  venue: Venue,
  args: BackfillArgs,
): Promise<void> {
  const mode = args.confirm ? 'CONFIRM' : 'DRY RUN'
  const runId = randomUUID()
  console.log(
    `Instagram history import | venue=${venue.slug} | ${mode} | run=${runId}`,
  )

  const { token, account } = await resolveVenueToken(supabase, venue)

  const ledger = await ledgerAvailable(supabase)
  if (!ledger.available) {
    if (args.confirm)
      die(
        `the import ledger is not readable (${ledger.error}). Migration 075 has to be applied before --confirm.`,
      )
    console.log(
      '\n· Migration 075 is not applied (no import ledger). A dry run does not need it; --confirm does.',
    )
  }

  const perkCouldFire = await perkUnlockPreflight(supabase, venue)

  const existing = await supabase
    .from('guests')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venue.id)
    .not('instagram_scoped_id', 'is', null)
    .not('instagram_scoped_id', 'like', 'deleted:%')
    .neq('created_via', INSTAGRAM_BACKFILL_CREATED_VIA)
  if (existing.error)
    die(`could not count existing guests: ${existing.error.message}`)

  // A tombstoned scoped id (delete-venue-data.ts) is a person who asked Meta
  // to have their data erased. Their id no longer matches anything, so the
  // import would plan them as a new guest and write their messages back.
  const tombstoned = await supabase
    .from('guests')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venue.id)
    .like('instagram_scoped_id', 'deleted:%')
  if (tombstoned.error)
    die(`could not count erased guests: ${tombstoned.error.message}`)
  const erasedGuests = tombstoned.count ?? 0
  console.log(
    erasedGuests > 0
      ? `\n✗ This venue has ${erasedGuests} guest(s) erased by a deletion request. An import cannot tell them from new people and would restore their messages.`
      : '\nErased guests at this venue (deletion requests): 0',
  )

  console.log('\nReading conversations from Meta…')
  const collected = await collect(
    supabase,
    venue,
    token,
    account,
    ledger.available,
    new Date(),
  )

  console.log(
    `\nPlan (${graphCalls} Graph calls, ${rateLimitWaits} throttled):`,
  )
  console.log(`    conversations: ${collected.conversationsSeen}`)
  console.log(`      new guests: ${collected.newGuests}`)
  console.log(`      already-known guests: ${collected.knownGuests}`)
  printCounts('skipped', collected.conversationSkips, '      ')
  console.log(
    `    messages in the one-to-one conversations: ${collected.messagesSeen}`,
  )
  console.log(`      to import: ${collected.toInsert}`)
  console.log(`      already stored: ${collected.alreadyStored}`)
  printCounts('skipped', collected.messageSkips, '      ')
  console.log(
    `    venue side identified by: user_id ${collected.venueMatchedBy.user_id}, username ${collected.venueMatchedBy.username}`,
  )
  console.log(
    `    messages fetched one at a time (not expanded in the list): ${collected.detailFetches}`,
  )
  console.log(
    `    conversations Meta says hold more messages than it listed: ${collected.truncatedConversations}`,
  )

  // Two totals that were counted separately have to agree. A planner that
  // dropped a conversation or a message without a reason shows up here rather
  // than as a count that merely looks complete.
  const conversationsAccounted =
    collected.newGuests +
    collected.knownGuests +
    sum(collected.conversationSkips)
  const messagesAccounted =
    collected.toInsert + collected.alreadyStored + sum(collected.messageSkips)
  const reconciled =
    conversationsAccounted === collected.conversationsSeen &&
    messagesAccounted === collected.messagesSeen
  console.log(
    reconciled
      ? '    ✓ every conversation and message seen is accounted for above'
      : `    ✗ RECONCILIATION FAILED: conversations ${conversationsAccounted} accounted of ${collected.conversationsSeen} seen, messages ${messagesAccounted} of ${collected.messagesSeen}`,
  )

  console.log("\nMeta's identifiers against rows we already hold:")
  const checks = identifierChecks({
    existingInstagramGuests: existing.count ?? 0,
    knownLiveGuests: collected.knownLiveGuests,
    datedInLivePeriod: collected.datedInLivePeriod,
    alreadyStoredLive: collected.alreadyStoredLive,
    directionAgreed: collected.directionAgreed,
    directionDisagreed: collected.directionDisagreed,
  })
  for (const check of checks) {
    const mark =
      check.verdict === 'PASS' ? '✓' : check.verdict === 'FAIL' ? '✗' : '·'
    console.log(`    ${mark} ${check.name}: ${check.verdict} — ${check.detail}`)
  }
  const failed = checks.filter((check) => check.verdict === 'FAIL')
  const inconclusive = checks.filter(
    (check) => check.verdict === 'INCONCLUSIVE',
  )

  const blockers: string[] = []
  if (!reconciled) blockers.push('the counts do not reconcile')
  if (failed.length > 0)
    blockers.push(`${failed.length} identifier check(s) FAILED`)
  if (perkCouldFire)
    blockers.push('the follow-up engine could log a perk-unlock task')
  if (erasedGuests > 0)
    blockers.push('the venue has guests erased by a deletion request')

  if (args.dryRun) {
    console.log(
      blockers.length > 0
        ? `\n✗ DRY RUN: --confirm would REFUSE (${blockers.join('; ')}).`
        : inconclusive.length > 0
          ? `\n· DRY RUN: nothing was written. --confirm would proceed, with ${inconclusive.length} check(s) INCONCLUSIVE: nothing on record could contradict Meta's ids, so nothing here proves them either.`
          : '\n✓ DRY RUN: nothing was written. --confirm would proceed.',
    )
    process.exit(blockers.length > 0 ? 1 : 0)
  }

  if (blockers.length > 0)
    die(`refusing to write: ${blockers.join('; ')}. Nothing was written.`)

  console.log('\nWriting…')
  const written = await apply(supabase, venue, collected.planned, runId)
  console.log('\nWritten:')
  console.log(
    `    guests created: ${written.guestsCreated} (planned ${collected.newGuests})`,
  )
  console.log(
    `    messages imported: ${written.messagesInserted} (planned ${collected.toInsert})`,
  )
  console.log(
    `    messages stored by something else first: ${written.messagesAlreadyStored}`,
  )
  console.log(`    messages failed: ${written.messagesFailed}`)
  printCounts('conversations not written', written.conversationSkips)

  const clean =
    written.guestsCreated === collected.newGuests &&
    written.messagesInserted === collected.toInsert
  console.log(
    clean
      ? `\n✓ CONFIRM: written exactly as planned. Run ${runId}.`
      : `\n· CONFIRM: written, but not exactly as planned (see above). Run it again to finish; every write is keyed, so a rerun cannot double one. Run ${runId}.`,
  )
  process.exit(clean ? 0 : 3)
}

async function loadAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: T[] | null
    error: { message: string } | null
  }>,
  what: string,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += ROW_PAGE) {
    const { data, error } = await page(from, from + ROW_PAGE - 1)
    if (error) die(`could not read ${what}: ${error.message}`)
    rows.push(...(data ?? []))
    if ((data ?? []).length < ROW_PAGE) return rows
  }
}

/**
 * Delete what the import wrote for this venue: every ledgered message, then
 * every guest it created.
 *
 * A guest the import created who has since had a LIVE message is kept unless
 * --include-guests-with-live-messages is passed, because deleting the guest
 * cascades to that live conversation and everything hung off it. After a test
 * run the guest you tested with is exactly such a guest, which is what the
 * flag is for.
 */
async function runRollback(
  supabase: AdminSupabaseClient,
  venue: Venue,
  args: BackfillArgs,
): Promise<void> {
  const mode = args.confirm ? 'CONFIRM' : 'DRY RUN'
  console.log(
    `Instagram history import ROLLBACK | venue=${venue.slug} | ${mode}`,
  )

  const ledger = await ledgerAvailable(supabase)
  if (!ledger.available)
    die(
      `the import ledger is not readable (${ledger.error}), so there is nothing to roll back by`,
    )

  const ledgerRows = await loadAll(
    (from, to) =>
      supabase
        .from('instagram_backfill_messages')
        .select('message_id')
        .eq('venue_id', venue.id)
        .order('message_id')
        .range(from, to),
    'the import ledger',
  )
  const messageIds = ledgerRows.map((row) => row.message_id)

  const guests = await loadAll(
    (from, to) =>
      supabase
        .from('guests')
        .select('id')
        .eq('venue_id', venue.id)
        .eq('created_via', INSTAGRAM_BACKFILL_CREATED_VIA)
        .order('id')
        .range(from, to),
    'imported guests',
  )

  const ledgered = new Set(messageIds)
  const guestsWithLive: string[] = []
  const guestsImportOnly: string[] = []
  for (const guest of guests) {
    const rows = await loadAll(
      (from, to) =>
        supabase
          .from('messages')
          .select('id')
          .eq('venue_id', venue.id)
          .eq('guest_id', guest.id)
          .order('id')
          .range(from, to),
      "a guest's messages",
    )
    if (rows.some((row) => !ledgered.has(row.id))) guestsWithLive.push(guest.id)
    else guestsImportOnly.push(guest.id)
  }
  const guestsToDelete = args.includeGuestsWithLiveMessages
    ? [...guestsImportOnly, ...guestsWithLive]
    : guestsImportOnly

  console.log(`\n    imported messages on the ledger: ${messageIds.length}`)
  console.log(`    guests the import created: ${guests.length}`)
  console.log(`      with only imported messages: ${guestsImportOnly.length}`)
  console.log(
    `      with live messages since: ${guestsWithLive.length} (${args.includeGuestsWithLiveMessages ? 'DELETED TOO, with those conversations' : 'kept; pass --include-guests-with-live-messages to delete them and their live conversations'})`,
  )

  if (args.dryRun) {
    console.log(
      `\n· DRY RUN: nothing was deleted. --confirm would delete ${messageIds.length} message(s) and ${guestsToDelete.length} guest(s).`,
    )
    return
  }

  let messagesDeleted = 0
  let failures = 0
  let filesRemoved = 0
  for (const ids of chunk(messageIds, 100)) {
    // FILES BEFORE ROWS (TAC-582). Deleting a message cascades to its
    // attachment rows, and a row is the only record of where its file is in
    // the private bucket. The path is computed from the row's ids, never read
    // off it, for the reason lib/messaging/attachments/delete.ts gives.
    const attachments = await supabase
      .from('message_attachments')
      .select('id, venue_id, guest_id, message_id')
      .eq('venue_id', venue.id)
      .in('message_id', ids)
    if (attachments.error) {
      console.error(
        `✗ could not read attachment rows, so their messages were left: ${attachments.error.message}`,
      )
      failures += 1
      continue
    }
    const paths = (attachments.data ?? []).map((row) =>
      storagePathFor({
        venueId: row.venue_id,
        guestId: row.guest_id,
        messageId: row.message_id,
        id: row.id,
      }),
    )
    if (paths.length > 0) {
      const removed = await supabase.storage
        .from(GUEST_MEDIA_BUCKET)
        .remove(paths)
      if (removed.error) {
        console.error(
          `✗ could not remove files, so their messages were left: ${removed.error.message}`,
        )
        failures += 1
        continue
      }
      filesRemoved += paths.length
    }

    const { data, error } = await supabase
      .from('messages')
      .delete()
      .eq('venue_id', venue.id)
      .in('id', ids)
      .select('id')
    if (error) {
      console.error(`✗ a message delete failed: ${error.message}`)
      failures += 1
      // Its ledger rows stay, so the next rollback still knows about them.
      continue
    }
    messagesDeleted += (data ?? []).length
    const cleared = await supabase
      .from('instagram_backfill_messages')
      .delete()
      .eq('venue_id', venue.id)
      .in('message_id', ids)
    if (cleared.error) {
      console.error(`✗ a ledger delete failed: ${cleared.error.message}`)
      failures += 1
    }
  }

  let guestsDeleted = 0
  let guestsKeptForNewMessage = 0
  for (const guestId of guestsToDelete) {
    // Re-checked at the moment of the delete, one guest at a time. Deleting a
    // guest cascades to every message they have, and one who was import-only
    // when classified above may have written since.
    if (!args.includeGuestsWithLiveMessages) {
      const remaining = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venue.id)
        .eq('guest_id', guestId)
      if (remaining.error) {
        console.error(`✗ a guest re-check failed: ${remaining.error.message}`)
        failures += 1
        continue
      }
      if ((remaining.count ?? 0) > 0) {
        guestsKeptForNewMessage += 1
        continue
      }
    }
    // The same order for a guest: deleting one cascades to every attachment
    // row they have, a live message's included.
    const media = await deleteAttachmentsForGuests(supabase, venue.id, [
      guestId,
    ])
    if (!media.ok) {
      console.error(
        `✗ could not remove a guest's files, so the guest was left: ${media.error}`,
      )
      failures += 1
      continue
    }
    const { data, error } = await supabase
      .from('guests')
      .delete()
      .eq('venue_id', venue.id)
      .eq('created_via', INSTAGRAM_BACKFILL_CREATED_VIA)
      .eq('id', guestId)
      .select('id')
    if (error) {
      console.error(`✗ a guest delete failed: ${error.message}`)
      failures += 1
      continue
    }
    guestsDeleted += (data ?? []).length
  }

  console.log('\nDeleted:')
  console.log(
    `    messages: ${messagesDeleted} (ledger had ${messageIds.length}; a ledger row with no message is a write that never landed)`,
  )
  console.log(
    `    files asked to be removed from the guest-media bucket: ${filesRemoved}`,
  )
  console.log(`    guests: ${guestsDeleted} (planned ${guestsToDelete.length})`)
  if (guestsKeptForNewMessage > 0)
    console.log(
      `    guests kept because a message was still on them at delete time: ${guestsKeptForNewMessage}`,
    )
  if (failures > 0)
    die(`${failures} delete(s) failed. Run the rollback again.`, 3)
  console.log('\n✓ ROLLBACK: done.')
}

/**
 * Every Instagram row this venue holds under one of Meta's message ids, keyed
 * by that id, with what the plan needs to know about each.
 */
async function loadStoredInstagramRows(
  supabase: AdminSupabaseClient,
  venue: Venue,
  hasLedger: boolean,
): Promise<Map<string, StoredInstagramRow>> {
  const rows = await loadAll(
    (from, to) =>
      supabase
        .from('messages')
        .select('id, guest_id, direction, provider_message_id')
        .eq('venue_id', venue.id)
        .eq('channel', 'instagram')
        .not('provider_message_id', 'is', null)
        .order('id')
        .range(from, to),
    "the venue's Instagram messages",
  )
  const ledger = hasLedger
    ? await loadAll(
        (from, to) =>
          supabase
            .from('instagram_backfill_messages')
            .select('message_id')
            .eq('venue_id', venue.id)
            .order('message_id')
            .range(from, to),
        'the import ledger',
      )
    : []
  const imported = new Set(ledger.map((row) => row.message_id))

  const attachments = await loadAll(
    (from, to) =>
      supabase
        .from('message_attachments')
        .select('message_id, kind')
        .eq('venue_id', venue.id)
        .order('id')
        .range(from, to),
    "the venue's attachment rows",
  )
  const kindsByMessage = new Map<string, string[]>()
  for (const row of attachments) {
    const kinds = kindsByMessage.get(row.message_id)
    if (kinds) kinds.push(row.kind)
    else kindsByMessage.set(row.message_id, [row.kind])
  }

  // A tombstoned scoped id is a person who asked Meta to have their data
  // erased (delete-venue-data.ts). Their message rows are kept, redacted, and
  // nothing of theirs is fetched back onto them.
  const erased = await loadAll(
    (from, to) =>
      supabase
        .from('guests')
        .select('id')
        .eq('venue_id', venue.id)
        .like('instagram_scoped_id', 'deleted:%')
        .order('id')
        .range(from, to),
    'erased guests',
  )
  const erasedGuests = new Set(erased.map((row) => row.id))

  const byMid = new Map<string, StoredInstagramRow>()
  for (const row of rows) {
    if (row.provider_message_id === null) continue
    byMid.set(row.provider_message_id, {
      id: row.id,
      guestId: row.guest_id,
      direction: row.direction,
      imported: imported.has(row.id),
      storedKinds: kindsByMessage.get(row.id) ?? [],
      guestErased: erasedGuests.has(row.guest_id),
    })
  }
  return byMid
}

/**
 * One message's attachment rows, through the webhook's own writer, and then
 * the copy of each file that needs one, straight away: Meta's links are
 * signed and expire. Returns how many rows were written, or null when the
 * insert failed. `copies` is tallied in place, by outcome.
 */
async function writeAttachmentsAndCopy(
  supabase: AdminSupabaseClient,
  venue: Venue,
  messageId: string,
  guestId: string,
  attachments: readonly ParsedAttachment[],
  copies: Record<string, number>,
): Promise<number | null> {
  const stored = await insertMessageAttachments(supabase, {
    messageId,
    venueId: venue.id,
    guestId,
    attachments,
  })
  if (!stored.ok) {
    console.error(`✗ an attachment insert failed: ${stored.error}`)
    return null
  }
  if (stored.data.pending === 0) return stored.data.inserted

  const pending = await loadPendingAttachmentsForMessage(supabase, messageId)
  if (!pending.ok) {
    // The rows are written and still pending, so
    // `npm run rehost-pending-attachments` can pick them up.
    console.error(`✗ could not load rows to copy: ${pending.error}`)
    copies.left_pending = (copies.left_pending ?? 0) + stored.data.pending
    return stored.data.inserted
  }
  for (const attachment of pending.data) {
    const outcome = await rehostAttachment(supabase, attachment)
    const key =
      outcome.status === 'failed' ? `failed: ${outcome.reason}` : outcome.status
    copies[key] = (copies[key] ?? 0) + 1
  }
  return stored.data.inserted
}

/**
 * How a run's copies went, and whether any row at this venue is still waiting
 * for its file. Prints both; returns true when nothing failed and nothing
 * waits. A rerun of either mode skips a message that already has its rows, so
 * a copy that did not finish is NOT retried by one, and this is where a run
 * says so.
 */
async function reportCopies(
  supabase: AdminSupabaseClient,
  venue: Venue,
  copies: Record<string, number>,
): Promise<boolean> {
  printCounts('files copied into our storage', copies)
  const stillPending = await supabase
    .from('message_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venue.id)
    .eq('status', 'pending')
  const pendingRows = stillPending.error ? null : (stillPending.count ?? 0)
  console.log(
    pendingRows === 0
      ? '    attachment rows at this venue still waiting for their file: 0'
      : `    ✗ attachment rows at this venue still waiting for their file: ${pendingRows ?? 'could not be counted'}. No rerun of this command retries them; run \`npm run rehost-pending-attachments\` while Meta's links still work.`,
  )
  const copyFailures = Object.entries(copies)
    .filter(([key]) => key !== 'ready' && key !== 'skipped')
    .reduce((total, [, count]) => total + count, 0)
  return copyFailures === 0 && pendingRows === 0
}

/**
 * TAC-582: --attachments-only. Go back to Meta for the media on messages we
 * ALREADY hold, and write `message_attachments` rows for them.
 *
 * WHAT IT WRITES, and nothing else: `message_attachments` rows, through the
 * webhook's own writer (lib/messaging/attachments/store.ts), and the copies
 * of their files in the private bucket (rehost.ts). NEVER a guest, never a
 * message, and no column on `messages`: not `media_urls`, not
 * `unsupported_content`, and not the `updated_at` touch the webhook makes to
 * wake an open thread, because nobody is watching these rows load.
 *
 * LIST-DRIVEN, NOT ONE REQUEST A ROW. Meta gives details for a conversation's
 * 20 most recent messages and answers anything older as if it were deleted.
 * This Graph client drops Meta's error message, so asking by id could not
 * tell "too old" from "that field is not allowed", and a broken request would
 * print as every row being too old. Listing the conversations returns exactly
 * the set Meta will describe; a row of ours that is in no listing is counted
 * `too_old` and no request is made for it.
 *
 * A DRY RUN DOWNLOADS NOTHING and writes nothing. --confirm copies each file
 * straight after its row is written, in the same pass, because Meta's links
 * are signed and expire.
 *
 * EVERY FAILED COPY POSTS TO SLACK (captureGuestMediaDegraded). That is the
 * webhook's alert and it is not muted here; --limit is how a first run is
 * kept small.
 *
 * A RERUN FINISHES THE ROWS, NOT THE COPIES. A message that already has
 * attachment rows is skipped, so a run that died between writing a row and
 * copying its file leaves that row `pending` and no rerun of this mode picks
 * it up. --confirm ends by counting the venue's pending rows and naming the
 * command that does: `npm run rehost-pending-attachments`.
 *
 * WHAT IT PRINTS: counts, verdicts and the NAMES of the fields Meta returned.
 * Never a handle, a scoped id, a message id of Meta's, a link or any text.
 */
async function runAttachmentsOnly(
  supabase: AdminSupabaseClient,
  venue: Venue,
  args: BackfillArgs,
): Promise<void> {
  const mode = args.confirm ? 'CONFIRM' : 'DRY RUN'
  console.log(
    `Instagram attachments backfill | venue=${venue.slug} | ${mode}${args.limit !== undefined ? ` | limit=${args.limit}` : ''}`,
  )

  const { token, account } = await resolveVenueToken(supabase, venue)

  const ledger = await ledgerAvailable(supabase)
  if (!ledger.available)
    console.log(
      '\n· The import ledger is not readable, so every row is reported as live rather than imported.',
    )

  const rowsByMid = await loadStoredInstagramRows(
    supabase,
    venue,
    ledger.available,
  )
  // Counted by the database on its own, so the paged read above has something
  // that can disagree with it.
  const expected = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venue.id)
    .eq('channel', 'instagram')
    .not('provider_message_id', 'is', null)
  if (expected.error)
    die(`could not count the venue's messages: ${expected.error.message}`)

  console.log('\nReading conversations from Meta…')
  const planner = createAttachmentsPlanner(rowsByMid)
  const conversationSkips = emptyConversationSkips()
  let conversationsSeen = 0
  let conversationsRead = 0
  let messagesSeen = 0
  let unreadableMessages = 0
  let detailFetches = 0
  let truncatedConversations = 0
  for await (const page of conversationPages(token, true)) {
    conversationsSeen += page.rawCount
    conversationSkips.unreadable += page.rawCount - page.conversations.length
    for (const conversation of page.conversations) {
      if (conversation.unreadableParticipants > 0) {
        conversationSkips.unreadable += 1
        continue
      }
      const sides = resolveConversationSides(conversation, account)
      if (!sides.ok) {
        conversationSkips[sides.reason] += 1
        continue
      }
      conversationsRead += 1
      if (conversation.hasMoreMessages) truncatedConversations += 1
      messagesSeen +=
        conversation.messages.length + conversation.unreadableMessages
      unreadableMessages += conversation.unreadableMessages
      const messages = await withDetails(conversation, token, true, () => {
        detailFetches += 1
      })
      for (const message of messages)
        planner.add(message, messageDirection(message, sides))
    }
  }
  const plan = planner.finish()

  const origin = plan.rowsByOrigin
  console.log(
    `\nPlan (${graphCalls} Graph calls, ${rateLimitWaits} throttled):`,
  )
  console.log(
    `    conversations at Meta: ${conversationsSeen} (${conversationsRead} one-to-one and read)`,
  )
  printCounts('not read', conversationSkips, '      ')
  console.log(
    `      Meta says hold more messages than it listed: ${truncatedConversations}`,
  )
  console.log(
    `    messages checked (our rows with a Meta id): ${rowsByMid.size}`,
  )
  console.log(
    `      imported: ${origin.importedInbound} inbound, ${origin.importedOutbound} outbound`,
  )
  console.log(
    `      live (webhook): ${origin.liveInbound} inbound, ${origin.liveOutbound} outbound`,
  )
  printCounts('outcome', plan.rowOutcomes, '      ')
  console.log(
    `    attachments found on our rows: ${sum(plan.foundByKind)} on ${plan.toWrite.length} message(s)`,
  )
  printCounts('by kind', plan.foundByKind, '      ')
  printCounts(
    'by what --confirm would do',
    {
      'copy into our storage (pending)': plan.foundByStatus.pending,
      'keep the link, nothing to copy (link_only)':
        plan.foundByStatus.link_only,
      'serve the giphy link as it is (ready)': plan.foundByStatus.ready,
      'no link came back (failed, no_link)': plan.foundByStatus.failed,
    },
    '      ',
  )
  printCounts('messages by direction', plan.toWriteByDirection, '      ')
  console.log(
    `    our rows Meta flags is_unsupported (reported only): ${plan.unsupportedOnOurRows}`,
  )

  const metaOnly = plan.metaOnly
  console.log(
    `\nMedia at Meta with NO row of ours (the import skipped messages with no text):`,
  )
  console.log(
    `    messages: ${metaOnly.messagesWithMedia} (${metaOnly.bySender.inbound} from guests, ${metaOnly.bySender.outbound} from the venue, ${metaOnly.bySender.unknown} from neither)`,
  )
  console.log(
    `      with text as well: ${metaOnly.withText}; flagged is_unsupported and nothing else: ${metaOnly.unsupportedOnly}`,
  )
  printCounts('attachments by kind', metaOnly.attachmentsByKind, '      ')
  console.log(
    `    (text-only messages at Meta with no row of ours: ${metaOnly.messagesWithoutMedia}; not readable by id: ${metaOnly.detailUnavailable})`,
  )

  console.log(
    '\nWhere the links point, every attachment Meta listed (host names only):',
  )
  printCounts('kind and host', plan.linkHosts)
  console.log(
    `\nFields Meta returned under attachments / shares / story (names only): ${plan.keyPaths.length === 0 ? 'none' : ''}`,
  )
  for (const path of plan.keyPaths) console.log(`    ${path}`)

  // Totals counted separately have to agree: our rows against the database's
  // own count and against the outcomes, and Meta's messages against where
  // each one went.
  const rowsAccounted = sum(plan.rowOutcomes)
  const metaAccounted =
    plan.matched +
    plan.duplicateIds +
    metaOnly.messagesWithMedia +
    metaOnly.messagesWithoutMedia +
    metaOnly.detailUnavailable +
    unreadableMessages
  const reconciled =
    rowsByMid.size === (expected.count ?? -1) &&
    rowsAccounted === rowsByMid.size &&
    metaAccounted === messagesSeen
  // Only the first comparison is an independent check. The other two hold by
  // construction (each row and each listed message is given exactly one
  // outcome) and are here to catch a later edit that breaks that.
  console.log(
    reconciled
      ? `\n    ✓ the ${rowsByMid.size} rows read match the database's own count; each of them, and each of the ${messagesSeen} messages Meta listed, is in exactly one line above`
      : `\n    ✗ RECONCILIATION FAILED: rows read ${rowsByMid.size}, counted by the database ${expected.count ?? 'unknown'}, accounted ${rowsAccounted}; Meta messages accounted ${metaAccounted} of ${messagesSeen} listed`,
  )
  console.log(
    `    (messages fetched one at a time: ${detailFetches}; the same Meta id listed twice: ${plan.duplicateIds})`,
  )

  const control = controlCheck(plan.control)
  const mark =
    control.verdict === 'PASS' ? '✓' : control.verdict === 'FAIL' ? '✗' : '·'
  console.log(
    `\nControl (media the webhook already stored must come back):\n    ${mark} ${control.verdict} — ${control.detail}`,
  )

  const blockers: string[] = []
  if (!reconciled) blockers.push('the counts do not reconcile')
  if (control.verdict === 'FAIL') blockers.push('the control FAILED')

  const toWrite =
    args.limit !== undefined ? plan.toWrite.slice(0, args.limit) : plan.toWrite
  if (args.dryRun) {
    console.log(
      blockers.length > 0
        ? `\n✗ DRY RUN: --confirm would REFUSE (${blockers.join('; ')}).`
        : `\n${control.verdict === 'INCONCLUSIVE' ? '·' : '✓'} DRY RUN: nothing was written or downloaded. --confirm would write attachments for ${toWrite.length} of ${plan.toWrite.length} message(s)${control.verdict === 'INCONCLUSIVE' ? ', with the control INCONCLUSIVE' : ''}.`,
    )
    process.exit(blockers.length > 0 ? 1 : 0)
  }
  if (blockers.length > 0)
    die(`refusing to write: ${blockers.join('; ')}. Nothing was written.`)

  console.log(`\nWriting ${toWrite.length} of ${plan.toWrite.length}…`)
  const written = {
    messages: 0,
    attachmentRows: 0,
    alreadyHadRows: 0,
    guestErased: 0,
    insertFailed: 0,
  }
  const copies: Record<string, number> = {}
  for (const item of toWrite) {
    // Read again at the moment of the write: an earlier run, or the live
    // webhook, may have written this message's rows since the plan was read.
    const existing = await supabase
      .from('message_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('message_id', item.messageId)
    if (existing.error) {
      console.error(
        `✗ an attachment re-check failed: ${existing.error.message}`,
      )
      written.insertFailed += 1
      continue
    }
    if ((existing.count ?? 0) > 0) {
      written.alreadyHadRows += 1
      continue
    }
    // And the guest: a deletion request that landed since the plan was read
    // removed their attachment rows, so the check above reads as "none yet".
    const guest = await guestStillWritable(supabase, venue, item.guestId)
    if (guest === 'erased') written.guestErased += 1
    if (guest === 'unreadable') written.insertFailed += 1
    if (guest !== 'yes') continue
    const rows = await writeAttachmentsAndCopy(
      supabase,
      venue,
      item.messageId,
      item.guestId,
      item.attachments,
      copies,
    )
    if (rows === null) {
      written.insertFailed += 1
      continue
    }
    written.messages += 1
    written.attachmentRows += rows
  }

  console.log('\nWritten:')
  console.log(
    `    messages given attachment rows: ${written.messages} (planned ${toWrite.length})`,
  )
  console.log(`    attachment rows: ${written.attachmentRows}`)
  console.log(
    `    messages that had rows by the time of the write: ${written.alreadyHadRows}`,
  )
  console.log(
    `    messages whose guest was erased since the plan was read: ${written.guestErased}`,
  )
  console.log(`    messages failed: ${written.insertFailed}`)
  const copiesClean = await reportCopies(supabase, venue, copies)
  const clean =
    written.messages === toWrite.length &&
    written.insertFailed === 0 &&
    copiesClean
  const remaining = plan.toWrite.length - toWrite.length
  console.log(
    clean
      ? `\n✓ CONFIRM: written exactly as planned.${remaining > 0 ? ` ${remaining} message(s) left for the next run.` : ''}`
      : `\n· CONFIRM: written, but not exactly as planned (see above). A failed copy keeps its row and its link; a rerun skips messages that already have rows.`,
  )
  process.exit(clean ? 0 : 3)
}

/** Whether a guest row is still the person it was, read at the moment of a write. */
async function guestStillWritable(
  supabase: AdminSupabaseClient,
  venue: Venue,
  guestId: string,
): Promise<'yes' | 'erased' | 'unreadable'> {
  const guest = await supabase
    .from('guests')
    .select('instagram_scoped_id')
    .eq('venue_id', venue.id)
    .eq('id', guestId)
    .maybeSingle()
  if (guest.error) {
    console.error(`✗ a guest re-check failed: ${guest.error.message}`)
    return 'unreadable'
  }
  return guest.data === null ||
    (guest.data.instagram_scoped_id ?? '').startsWith('deleted:')
    ? 'erased'
    : 'yes'
}

type MediaGuestPlan = {
  guestId: string
  messages: PlannedMediaMessage[]
}

/**
 * TAC-582: --media-only. Import the photos, videos and reel shares the
 * history import skipped for having no text, as new message rows with
 * attachment rows. What is in scope, what is left out and why:
 * scripts/lib/backfill-instagram-media.ts.
 *
 * WHAT IT WRITES, and nothing else, for guests we ALREADY hold:
 *   ledger     one instagram_backfill_messages row per message, first.
 *   messages   the import's own shape (Meta's id, Meta's time as created_at,
 *              provider_sent_at NULL), with an empty body and the links in
 *              `media_urls`, which is what the webhook writes for a photo and
 *              what makes the row one a thread shows.
 *   message_attachments, and the copies in the private bucket, through the
 *              same writer and the same copy step --attachments-only uses.
 * NEVER A GUEST, and no existing guest or message is updated.
 *
 * NOTHING HERE CALLS THE AGENT, a dispatcher, a notifier or a scheduler, and
 * `messages` has no trigger but `updated_at`. What a row can still reach, and
 * what stops each one:
 *   the media hold and the agent's history   read media-only guest rows from
 *              the last 14 days; nothing that recent is imported.
 *   the reply window, the warm close, the inquiry follow-up   the import's own
 *              two rules (provider_sent_at NULL, nothing after a live message).
 *   the daily follow-up engine   its detectors read a guest's visits and
 *              their recognition STATE, never a message. An imported row
 *              reaches the state only through the response rate, so this run
 *              REFUSES TO WRITE while any affected guest's state could move
 *              (scoreBounds). Its recent-conversation gate reads derived last
 *              inbound, and can only ever suppress.
 *
 * ACCEPTED (ruled 2026-10-11): the guest's lifetime reply count rises by one
 * per imported guest message, so the reply-count gates on getting-to-know-you
 * questions open sooner on that guest's next real turn.
 *
 * WHAT IT PRINTS: counts and verdicts. The story-mention table is ranked
 * counts with no handle, id or position in Meta's list.
 */
async function runMediaOnly(
  supabase: AdminSupabaseClient,
  venue: Venue,
  args: BackfillArgs,
): Promise<void> {
  const mode = args.confirm ? 'CONFIRM' : 'DRY RUN'
  const runId = randomUUID()
  console.log(
    `Instagram media-only import | venue=${venue.slug} | ${mode}${args.limit !== undefined ? ` | limit=${args.limit}` : ''} | run=${runId}`,
  )

  const { token, account } = await resolveVenueToken(supabase, venue)

  const ledger = await ledgerAvailable(supabase)
  if (!ledger.available)
    die(
      `the import ledger is not readable (${ledger.error}). This mode tells an imported row from a live one by it, in both modes.`,
    )

  const rowsByMid = await loadStoredInstagramRows(supabase, venue, true)
  const guests = await loadAll(
    (from, to) =>
      supabase
        .from('guests')
        .select('id, instagram_scoped_id')
        .eq('venue_id', venue.id)
        .not('instagram_scoped_id', 'is', null)
        .not('instagram_scoped_id', 'like', 'deleted:%')
        .order('id')
        .range(from, to),
    "the venue's Instagram guests",
  )
  const guestIdByScopedId = new Map<string, string>()
  for (const guest of guests)
    if (guest.instagram_scoped_id !== null)
      guestIdByScopedId.set(guest.instagram_scoped_id, guest.id)

  console.log('\nReading conversations from Meta…')
  // Fed every message as well, for one thing only: its control, the check
  // that the media fields came back at all.
  const controlPlanner = createAttachmentsPlanner(rowsByMid)
  const now = new Date()
  const conversationSkips = emptyConversationSkips()
  const skips = emptyMediaSkips()
  const importByKind = emptyKindCounts()
  const heldBackByKind = emptyKindCounts()
  const importByDirection = { inbound: 0, outbound: 0 }
  const storyMentions = new Map<string, { count: number; hasGuest: boolean }>()
  const planned: MediaGuestPlan[] = []
  let conversationsSeen = 0
  let conversationsRead = 0
  let messagesSeen = 0
  let messagesDecided = 0
  let unreadableMessages = 0
  let groupThreadMessages = 0
  let toImport = 0

  for await (const page of conversationPages(token, true)) {
    conversationsSeen += page.rawCount
    conversationSkips.unreadable += page.rawCount - page.conversations.length
    for (const conversation of page.conversations) {
      if (conversation.unreadableParticipants > 0) {
        conversationSkips.unreadable += 1
        continue
      }
      const sides = resolveConversationSides(conversation, account)
      if (!sides.ok) {
        conversationSkips[sides.reason] += 1
        if (sides.reason === 'not_one_to_one')
          groupThreadMessages +=
            conversation.messages.length + conversation.unreadableMessages
        continue
      }
      conversationsRead += 1
      messagesSeen +=
        conversation.messages.length + conversation.unreadableMessages
      unreadableMessages += conversation.unreadableMessages
      const messages = await withDetails(conversation, token, true, () => {})

      const guestId = guestIdByScopedId.get(sides.guest.id) ?? null
      // Read only for a guest who has something this mode could import: it is
      // two queries a guest, and most conversations have nothing in scope.
      let liveFrom: Date | null | undefined
      const forGuest: PlannedMediaMessage[] = []
      for (const message of messages) {
        const direction = messageDirection(message, sides)
        controlPlanner.add(message, direction)
        const base = {
          message,
          direction,
          alreadyStored: rowsByMid.has(message.id),
          hasGuest: guestId !== null,
          now,
        }
        let decision = decideMediaMessage({
          ...base,
          oldestLiveMessageAt: null,
        })
        if (decision.import && guestId !== null) {
          if (liveFrom === undefined)
            liveFrom = await oldestLiveMessageAt(
              supabase,
              venue.id,
              guestId,
              await ledgerIdsForGuest(supabase, guestId),
            )
          decision = decideMediaMessage({
            ...base,
            oldestLiveMessageAt: liveFrom,
          })
        }
        messagesDecided += 1

        if (decision.import) {
          toImport += 1
          importByDirection[decision.message.direction] += 1
          for (const attachment of decision.message.attachments)
            importByKind[attachment.kind] += 1
          forGuest.push(decision.message)
          continue
        }
        skips[decision.reason] += 1
        if (decision.inScope)
          for (const attachment of decision.attachments)
            heldBackByKind[attachment.kind] += 1
        // Counted for the person who posted it, whoever they are to us.
        if (decision.reason === 'story_mention' && direction === 'inbound') {
          const entry = storyMentions.get(sides.guest.id) ?? {
            count: 0,
            hasGuest: guestId !== null,
          }
          entry.count += 1
          storyMentions.set(sides.guest.id, entry)
        }
      }
      if (guestId !== null && forGuest.length > 0) {
        forGuest.sort((a, b) => a.at.getTime() - b.at.getTime())
        planned.push({ guestId, messages: forGuest })
      }
    }
  }
  const control = controlCheck(controlPlanner.finish().control)

  console.log(
    `\nPlan (${graphCalls} Graph calls, ${rateLimitWaits} throttled):`,
  )
  console.log(
    `    conversations at Meta: ${conversationsSeen} (${conversationsRead} one-to-one and read)`,
  )
  printCounts('not read', conversationSkips, '      ')
  console.log(
    `      messages listed in the group threads (skipped with them): ${groupThreadMessages}`,
  )
  console.log(
    `    messages Meta listed in the conversations read: ${messagesSeen}`,
  )
  console.log(
    `      to import: ${toImport} (${importByDirection.inbound} from guests, ${importByDirection.outbound} from the venue), for ${planned.length} guest(s)`,
  )
  printCounts('attachments to import, by kind', importByKind, '      ')
  printCounts('not imported, by reason', skips, '      ')
  printCounts(
    'in scope but held back by a rule about the guest or the date, attachments by kind',
    heldBackByKind,
    '      ',
  )

  const mentionTotal = [...storyMentions.values()].reduce(
    (total, entry) => total + entry.count,
    0,
  )
  const mentionersWithGuest = [...storyMentions.values()].filter(
    (entry) => entry.hasGuest,
  )
  console.log(
    `\nStory mentions by the person who posted them (not imported; ${mentionTotal} from ${storyMentions.size} people; the other ${skips.story_mention - mentionTotal} of ${skips.story_mention} came from the venue's side of the conversation):`,
  )
  console.log(
    `    people who are guests of ours: ${mentionersWithGuest.length}, with ${mentionersWithGuest.reduce((total, entry) => total + entry.count, 0)} mention(s)`,
  )
  console.log(
    `    people with no guest row: ${storyMentions.size - mentionersWithGuest.length}, with ${mentionTotal - mentionersWithGuest.reduce((total, entry) => total + entry.count, 0)} mention(s)`,
  )
  console.log('    top 10, by count:')
  topCounts(storyMentions, 10).forEach((entry, index) => {
    console.log(
      `      Guest ${index + 1}: ${entry.count} (${entry.hasGuest ? 'a guest of ours' : 'no guest row'})`,
    )
  })

  // What the import would move, for the guests it touches.
  const activity = await supabase.rpc('venue_guest_activity', {
    p_venue_id: venue.id,
  })
  if (activity.error)
    die(`could not read derived guest activity: ${activity.error.message}`)
  const activityByGuest = new Map(
    (activity.data ?? []).map((row) => [row.guest_id, row]),
  )
  const thresholds = await loadThresholds(venue.id)
  if (!thresholds.ok)
    die(`could not read the venue's state thresholds: ${thresholds.error}`)

  const impact = {
    replyCountRises: 0,
    maxNewReplies: 0,
    lastInboundMoves: 0,
    lastInteractionMoves: 0,
    stateCouldMove: 0,
    stateUnreadable: 0,
  }
  const currentStates: Record<string, number> = {}
  for (const item of planned) {
    const inbound = item.messages.filter((m) => m.direction === 'inbound')
    if (inbound.length > 0) impact.replyCountRises += 1
    impact.maxNewReplies = Math.max(impact.maxNewReplies, inbound.length)
    const row = activityByGuest.get(item.guestId)
    const newestInbound = Math.max(-1, ...inbound.map((m) => m.at.getTime()))
    const newest = Math.max(...item.messages.map((m) => m.at.getTime()))
    const lastInbound = row?.last_inbound_at
      ? new Date(row.last_inbound_at).getTime()
      : -1
    const lastInteraction = row?.last_interaction_at
      ? new Date(row.last_interaction_at).getTime()
      : -1
    if (newestInbound > lastInbound) impact.lastInboundMoves += 1
    if (newest > lastInteraction) impact.lastInteractionMoves += 1

    // Read-only: computeRelationshipStrength reads and writes nothing, and
    // computeGuestState, which would record a transition, is not called.
    const strength = await computeRelationshipStrength({
      guestId: item.guestId,
      venueId: venue.id,
    })
    if (!strength.ok) {
      impact.stateUnreadable += 1
      continue
    }
    const { contributions, weights, score } = strength.data
    const sumWithoutResponseRate =
      Object.values(contributions).reduce((total, value) => total + value, 0) -
      contributions.responseRate
    const bounds = scoreBounds({
      sumWithoutResponseRate,
      responseRateWeight: weights.responseRate,
    })
    const state = evaluateState(score, thresholds.data)
    currentStates[state] = (currentStates[state] ?? 0) + 1
    if (
      stateCouldMove({
        state,
        atMin: evaluateState(bounds.scoreAtMin, thresholds.data),
        atMax: evaluateState(bounds.scoreAtMax, thresholds.data),
      })
    )
      impact.stateCouldMove += 1
  }

  console.log(
    `\nWhat the import would move, for the ${planned.length} guest(s) it touches:`,
  )
  console.log(
    `    lifetime reply count rises (accepted): ${impact.replyCountRises} guest(s), by at most ${impact.maxNewReplies}`,
  )
  console.log(
    `    derived last inbound moves later: ${impact.lastInboundMoves} guest(s); derived last interaction (the Command Center's ordering) moves later: ${impact.lastInteractionMoves} guest(s)`,
  )
  printCounts('recognition state now', currentStates)
  console.log(
    impact.stateCouldMove === 0 && impact.stateUnreadable === 0
      ? "    ✓ follow-up engine: no guest's recognition state can move, whatever the response rate becomes, so no detector can fire because of this import"
      : `    ✗ follow-up engine: ${impact.stateCouldMove} guest(s) whose recognition state COULD move with the response rate, and ${impact.stateUnreadable} whose score could not be read. A state change is what the perk-unlock and lapsed detectors read.`,
  )

  // Only the first comparison can disagree: Meta's count of what it listed
  // against the number of decisions made. The second holds by construction.
  const reconciled =
    messagesDecided + unreadableMessages === messagesSeen &&
    toImport + sum(skips) === messagesDecided
  console.log(
    reconciled
      ? `\n    ✓ each of the ${messagesSeen} messages Meta listed has exactly one outcome above`
      : `\n    ✗ RECONCILIATION FAILED: ${messagesDecided} decided + ${unreadableMessages} unreadable of ${messagesSeen} listed; ${toImport} to import + ${sum(skips)} skipped`,
  )
  const mark =
    control.verdict === 'PASS' ? '✓' : control.verdict === 'FAIL' ? '✗' : '·'
  console.log(
    `\nControl (media the webhook already stored must come back):\n    ${mark} ${control.verdict} — ${control.detail}`,
  )

  const blockers: string[] = []
  if (!reconciled) blockers.push('the counts do not reconcile')
  if (control.verdict === 'FAIL') blockers.push('the control FAILED')
  if (impact.stateCouldMove > 0 || impact.stateUnreadable > 0)
    blockers.push('a follow-up detector could fire')

  const flat = planned.flatMap((item) =>
    item.messages.map((message) => ({ guestId: item.guestId, message })),
  )
  const toWrite = args.limit !== undefined ? flat.slice(0, args.limit) : flat
  if (args.dryRun) {
    console.log(
      blockers.length > 0
        ? `\n✗ DRY RUN: --confirm would REFUSE (${blockers.join('; ')}).`
        : `\n✓ DRY RUN: nothing was written or downloaded. --confirm would import ${toWrite.length} of ${flat.length} message(s). Held back until they are ${MEDIA_ONLY_HOLD_BACK_DAYS} days old: ${skips.inside_14_days}.`,
    )
    process.exit(blockers.length > 0 ? 1 : 0)
  }
  if (blockers.length > 0)
    die(`refusing to write: ${blockers.join('; ')}. Nothing was written.`)

  console.log(`\nWriting ${toWrite.length} of ${flat.length}…`)
  const written = {
    messages: 0,
    attachmentRows: 0,
    alreadyStored: 0,
    guestErased: 0,
    failed: 0,
    attachmentsFailed: 0,
  }
  const copies: Record<string, number> = {}
  for (const item of toWrite) {
    const guest = await guestStillWritable(supabase, venue, item.guestId)
    if (guest === 'erased') written.guestErased += 1
    if (guest === 'unreadable') written.failed += 1
    if (guest !== 'yes') continue

    const inserted = await insertLedgeredMessage(
      supabase,
      venue,
      item.guestId,
      runId,
      item.message,
    )
    if (inserted.status === 'already_stored') written.alreadyStored += 1
    if (inserted.status === 'failed') written.failed += 1
    if (inserted.status !== 'inserted') continue
    written.messages += 1

    const rows = await writeAttachmentsAndCopy(
      supabase,
      venue,
      inserted.id,
      item.guestId,
      item.message.attachments,
      copies,
    )
    // The message is written and shows as media by its links; what is
    // missing is the row that says what kind. --attachments-only is the
    // mode that finds a message with no attachment rows and writes them.
    if (rows === null) written.attachmentsFailed += 1
    else written.attachmentRows += rows
  }

  console.log('\nWritten:')
  console.log(
    `    messages imported: ${written.messages} (planned ${toWrite.length})`,
  )
  console.log(`    attachment rows: ${written.attachmentRows}`)
  console.log(
    `    messages stored by something else first: ${written.alreadyStored}`,
  )
  console.log(
    `    messages whose guest was erased since the plan was read: ${written.guestErased}`,
  )
  console.log(`    messages failed: ${written.failed}`)
  console.log(
    `    messages written whose attachment rows failed: ${written.attachmentsFailed}${written.attachmentsFailed > 0 ? ' (run --attachments-only to write them)' : ''}`,
  )
  const copiesClean = await reportCopies(supabase, venue, copies)
  const clean =
    written.messages === toWrite.length &&
    written.failed === 0 &&
    written.attachmentsFailed === 0 &&
    copiesClean
  const remaining = flat.length - toWrite.length
  console.log(
    clean
      ? `\n✓ CONFIRM: written exactly as planned.${remaining > 0 ? ` ${remaining} message(s) left for the next run.` : ''} Run ${runId}.`
      : `\n· CONFIRM: written, but not exactly as planned (see above). Every message is keyed on Meta's id, so a rerun cannot double one. Run ${runId}.`,
  )
  process.exit(clean ? 0 : 3)
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2))
  const problem = backfillArgsError(args)
  if (problem !== null) {
    console.error(`✗ ${problem}\n  ${USAGE}`)
    process.exit(2)
  }

  const supabase = createAdminClient()
  const venue = await loadVenue(supabase, args.venue ?? '')
  if (args.rollback) await runRollback(supabase, venue, args)
  else if (args.attachmentsOnly) await runAttachmentsOnly(supabase, venue, args)
  else if (args.mediaOnly) await runMediaOnly(supabase, venue, args)
  else await runImport(supabase, venue, args)
}

main().catch((e: unknown) => {
  console.error(
    `✗ unexpected error: ${e instanceof Error ? e.message : String(e)}`,
  )
  process.exit(1)
})
