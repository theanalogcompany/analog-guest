// TAC-515: import a venue's existing Instagram conversations, once, so the
// agent can tell someone who has been messaging the shop for months from
// someone new, and has their recent history. Run by hand, by a person who
// means it, with the venue owner's agreement to importing message content.
//
//   npm run backfill-instagram-contacts -- --venue <slug> --dry-run
//   npm run backfill-instagram-contacts -- --venue <slug> --confirm
//   npm run backfill-instagram-contacts -- --venue <slug> --rollback --dry-run
//   npm run backfill-instagram-contacts -- --venue <slug> --rollback --confirm
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
import { resolveInstagramAccessToken } from '@/lib/messaging/instagram/credentials-store'
import {
  fetchConversationPage,
  fetchMessageDetail,
  isGraphRateLimited,
  type ConversationMessage,
  type ConversationPage,
} from '@/lib/messaging/instagram/fetch-conversations'
import {
  isTokenRejected,
  type GraphFailure,
  type GraphResult,
} from '@/lib/messaging/instagram/graph'
import { fetchConnectedAccount } from '@/lib/messaging/instagram/oauth-exchange'
import { GUEST_STATES } from '@/lib/recognition/types'
import { parseFollowupRules } from '@/lib/schemas'
import {
  INSTAGRAM_BACKFILL_CREATED_VIA,
  backfillArgsError,
  emptyConversationSkips,
  emptyMessageSkips,
  identifierChecks,
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
  'usage: npm run backfill-instagram-contacts -- --venue <slug> (--dry-run | --confirm) [--rollback [--include-guests-with-live-messages]]'

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

  const cursorsSeen = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const after: string | null = cursor
    const page: GraphResult<ConversationPage> = await callGraph(() =>
      fetchConversationPage(token, fetch, after),
    )
    if (!page.ok)
      die(
        `could not list conversations: ${describeFailure(page.failure)}. Nothing was written by this pass; run it again.`,
      )

    // Meta's own count of what the page held, so a conversation the parser
    // could not read is a counted skip rather than one that was never seen.
    out.conversationsSeen += page.value.rawCount
    out.conversationSkips.unreadable +=
      page.value.rawCount - page.value.conversations.length

    for (const conversation of page.value.conversations) {
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

      const messages: ConversationMessage[] = []
      for (const message of conversation.messages) {
        if (!message.needsDetail) {
          messages.push(message)
          continue
        }
        out.detailFetches += 1
        const detail = await callGraph(() =>
          fetchMessageDetail(message.id, token, fetch),
        )
        if (detail.ok) {
          messages.push(detail.value)
          continue
        }
        // Only Meta refusing THIS message is a per-message outcome. A dead
        // socket, a throttle that outlasted the backoff or a rejected token
        // would land every remaining message in the same bucket and the run
        // would print a short import as a complete one.
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

    cursor = page.value.nextCursor
    if (cursor === null) break
    if (cursorsSeen.has(cursor))
      die(
        'Meta returned the same paging cursor twice. Stopping rather than loop; nothing was written by this pass.',
      )
    cursorsSeen.add(cursor)
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
    media_urls: [],
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
        written.messagesFailed += 1
        continue
      }

      const { error } = await supabase
        .from('messages')
        .insert(messageRow(id, venue.id, guestId, message))
      if (!error) {
        written.messagesInserted += 1
        continue
      }
      if (error.code === UNIQUE_VIOLATION) {
        // The live webhook, or another run, saved this id first. That is the
        // dedupe working, not a failure, and the ONLY error that proves our
        // row is not there, so it is the only one that takes the marker back.
        await supabase
          .from('instagram_backfill_messages')
          .delete()
          .eq('message_id', id)
        written.messagesAlreadyStored += 1
      } else {
        // The marker STAYS. An insert can commit and still report an error
        // (a dropped response, a late timeout), and removing the marker then
        // would leave an imported message nothing identifies. A marker with
        // no message is harmless; the reverse is not.
        console.error(
          `✗ a message insert failed: ${error.message} (${error.code})`,
        )
        written.messagesFailed += 1
      }
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
    account.value,
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
  for (const ids of chunk(messageIds, 100)) {
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
  console.log(`    guests: ${guestsDeleted} (planned ${guestsToDelete.length})`)
  if (guestsKeptForNewMessage > 0)
    console.log(
      `    guests kept because a message was still on them at delete time: ${guestsKeptForNewMessage}`,
    )
  if (failures > 0)
    die(`${failures} delete(s) failed. Run the rollback again.`, 3)
  console.log('\n✓ ROLLBACK: done.')
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
  else await runImport(supabase, venue, args)
}

main().catch((e: unknown) => {
  console.error(
    `✗ unexpected error: ${e instanceof Error ? e.message : String(e)}`,
  )
  process.exit(1)
})
