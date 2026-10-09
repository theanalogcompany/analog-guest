import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/db/admin'
import { draftInboundReply, type TestDraft } from '@/lib/agent/handle-inbound'
import { draftFollowupReply } from '@/lib/agent/handle-followup'
import type { FollowupTrigger } from '@/lib/agent/types'
import type { HistoryTurn } from '@/lib/ai/v2/compose'
import type { MessageChannel } from '@/lib/schemas/message-channel'

// The playground's v1 arm: produce the reply v1 WOULD have sent for the same
// inbound v2 just answered, so the two sit side by side.
//
// SERVER-ONLY, and colocated with the route rather than in `lib/` on purpose:
// v1 is deleted in phase 6 (lib/relationship/CLAUDE.md), and when it goes this
// file goes with it. Nothing in `lib/` imports it, so the deletion is this
// file plus the arm's field on RunResponseBody plus one component - and
// `scripts/measurement/golden-set.ts`, the second importer, which runs the
// same arm over a whole question set. The harness imports it rather than
// reimplementing the materialization for the reason this file already gives
// below: a second copy of "how v1 gets an inbound row" would drift, and a
// comparison against a drifted copy proves nothing.
//
// Both modes end at the same call - `draftInboundReply`, which runs the real
// v1 pipeline and writes nothing. They differ only in how v1 gets an inbound
// row to be invoked on:
//
//   replay  - the row is real. The guest said this, production answered it,
//             and the row id is what the timeline already carries.
//   sandbox - there is no row, because a sandbox guest is not a guest. So the
//             conversation is MATERIALIZED against a per-venue synthetic
//             guest, the new inbound is appended, and v1 is invoked on it.
//
// WHY MATERIALIZE RATHER THAN SYNTHESIZE A CONTEXT: `buildRuntimeContext`
// reads history, visits, commitments and recognition out of the database. A
// hand-built RuntimeContext would be a second definition of every one of
// those, drifting from production silently - and "match v1 exactly" is the
// whole point of the arm. Writing the rows means v1's context is built by
// production's own code path from production's own queries.

/** Parallel sandbox guests per venue, one per concurrency slot. */
export const SANDBOX_SLOTS = 10

/**
 * The synthetic guest's phone number, per venue and per slot.
 *
 * Sits in the 555-01xx fictional range so it is obviously not a real number
 * and could never be dialled, and carries a per-venue suffix because venues
 * are isolated blocks - one shared sandbox guest would put one venue's test
 * conversation into another venue's history.
 *
 * THE SLOT DIGIT IS WHAT MAKES THE ARM CONCURRENCY-SAFE.
 * `materializeTranscript` below DELETES the guest's messages and rewrites
 * them on every call, so two arms sharing one guest would answer each other's
 * transcripts - or answer a row the other just deleted. Each slot gets its
 * own guest, and both the delete and the inserts are already scoped by
 * `guest_id`, so distinct slots cannot see each other's rows at all. The
 * playground passes no slot and the harness passes its worker index.
 *
 * SLOT 0 IS BYTE-IDENTICAL to the single number this function returned before
 * slots existed (`+1555010` + 8 digits), so the playground keeps using the
 * same guest row and the same history it always had. Verify that by reading
 * the concatenation rather than trusting this sentence: `+155501` + `0` is
 * `+1555010`.
 *
 * MUST SATISFY E.164, which is what `guests_phone_number_check` enforces
 * (`^\+[1-9]\d{1,14}$`, migration 001): a leading non-zero digit then up to 14
 * more, DIGITS ONLY. The first version of this derived the suffix with
 * `/[^0-9a-f]/gi`, which keeps the uuid's a-f hex letters, and every insert
 * was rejected by that constraint - caught by running a real turn, not by
 * tsc, lint or the build.
 *
 * 15 digits exactly - the E.164 ceiling - which is why the slot is one digit
 * taken out of the prefix rather than appended: `155501` + slot + 8.
 */
function sandboxPhoneNumber(venueId: string, slot: number): string {
  // DIGITS ONLY, and padded, so the result is always exactly 8 characters
  // whatever the uuid happens to contain. A collision between two venues on
  // their last 8 digits is harmless: the guest lookup is scoped by venue_id
  // and the table's uniqueness is UNIQUE (venue_id, phone_number).
  const suffix = venueId.replace(/\D/g, '').slice(-8).padStart(8, '0')
  return `+155501${slot}${suffix}`
}

/**
 * The sandbox transcript's channel. `text` rather than `instagram` because the
 * sandbox guest has a phone number and no IGSID, and `resolveConversationChannel`
 * reads the guest's identifiers - an `instagram` row on a guest with no scoped
 * id would make the channel unresolvable, and v1 refuses to generate when the
 * reply has nowhere to route.
 */
const SANDBOX_CHANNEL: MessageChannel = 'text'

export type V1ArmOutcome =
  { ok: true; data: TestDraft } | { ok: false; error: string; stage: string }

/**
 * Replay: v1 answers the real inbound row the operator clicked.
 *
 * Nothing is written. The row already exists and is not touched - the test run
 * reads it, builds context with history pinned by the orchestrator's own
 * queries, generates, and returns.
 */
export async function draftV1ForReplay(
  inboundMessageId: string,
): Promise<V1ArmOutcome> {
  return draftInboundReply(inboundMessageId)
}

/**
 * Sandbox: materialize the chat as rows against the venue's synthetic guest,
 * then have v1 answer the newest one.
 *
 * The transcript is REPLACED, not appended to, on every run. The client's
 * `sessionHistory` is the source of truth for what the operator can see, and
 * replacing is what keeps the rows equal to it - an append-only scheme would
 * accumulate a second copy of the conversation on every send, and v1 would
 * answer a guest who appeared to have said everything twice.
 *
 * Fails as a value. A failure here means the v1 column is empty with a reason,
 * never that the v2 run is lost: the route runs the two arms independently.
 */
export async function draftV1ForSandbox(input: {
  venueId: string
  /** The chat before this turn, oldest first, as the client renders it. */
  sessionHistory: readonly HistoryTurn[]
  /** The guest's message(s) this turn. */
  inbound: readonly string[]
  /**
   * Concurrency slot, 0 to SANDBOX_SLOTS - 1. Omit for the playground's
   * single-turn use; a batch caller passes its worker index so two arms in
   * flight never share a transcript. See sandboxPhoneNumber.
   */
  slot?: number
  /**
   * Attachment links on this turn's last message. Omit for text only.
   * Written as their own bodyless row - see `materializeTranscript`.
   */
  mediaUrls?: readonly string[]
  /** The channel the transcript is written on. Defaults to text. */
  channel?: MessageChannel
  /**
   * Run the turn as if it were this instant. Omit for the real clock.
   *
   * BOTH CLOCKS MOVE TOGETHER HERE, which is the whole reason this lives on
   * the arm rather than on `draftInboundReply` alone: the transcript below is
   * stamped relative to this instant AND the prompt is told it. Passing it to
   * one and not the other would have the model reading a message from twelve
   * hours in the future.
   *
   * The golden set uses it so a run taken after close can still ask the
   * questions a guest asks mid-service.
   */
  now?: Date
}): Promise<V1ArmOutcome> {
  const slot = input.slot ?? 0
  if (!Number.isInteger(slot) || slot < 0 || slot >= SANDBOX_SLOTS)
    return {
      ok: false,
      error: `slot must be an integer in 0..${SANDBOX_SLOTS - 1}, got ${String(input.slot)}`,
      stage: 'sandbox_guest',
    }

  const guest = await ensureSandboxGuest(input.venueId, slot)
  if (!guest.ok)
    return { ok: false, error: guest.error, stage: 'sandbox_guest' }

  const materialized = await materializeTranscript({
    venueId: input.venueId,
    guestId: guest.guestId,
    sessionHistory: input.sessionHistory,
    inbound: input.inbound,
    mediaUrls: input.mediaUrls,
    channel: input.channel,
    now: input.now,
  })
  if (!materialized.ok)
    return { ok: false, error: materialized.error, stage: 'sandbox_transcript' }

  // The SAME instant to both halves. See the `now` field above.
  return draftInboundReply(materialized.inboundMessageId, input.now)
}

/**
 * What v1 would SAY UNPROMPTED - a follow-up, drafted against a sandbox
 * transcript, sent nowhere.
 *
 * The proactive sibling of `draftV1ForSandbox`, and it exists because a
 * follow-up answers a relationship rather than a message: there is no inbound
 * to materialize from, so the transcript IS the input and the trigger says
 * what the venue is reaching out about.
 *
 * The transcript's CHANNEL is load-bearing here in a way it never is on the
 * inbound arm. `resolveConversationChannel` takes the last inbound row's own
 * channel when there is no current message, and four of the twelve triggers
 * are refused by name on a text conversation - so a scenario riding one of
 * those must be written as Instagram or it never reaches generation.
 */
export async function draftV1FollowupForSandbox(input: {
  venueId: string
  sessionHistory: readonly HistoryTurn[]
  trigger: FollowupTrigger
  channel?: MessageChannel
  slot?: number
  now?: Date
}): Promise<V1ArmOutcome> {
  const slot = input.slot ?? 0
  if (!Number.isInteger(slot) || slot < 0 || slot >= SANDBOX_SLOTS)
    return {
      ok: false,
      error: `slot must be an integer in 0..${SANDBOX_SLOTS - 1}, got ${String(input.slot)}`,
      stage: 'sandbox_guest',
    }
  // A follow-up with no transcript is a follow-up to nothing: the trigger
  // says "check back on what happened", and with an empty thread there is no
  // what. Refused here rather than generating something hollow.
  if (input.sessionHistory.length === 0)
    return {
      ok: false,
      error:
        'a proactive scenario needs history - a follow-up answers a relationship, and there is nothing to follow up on',
      stage: 'sandbox_transcript',
    }

  const guest = await ensureSandboxGuest(input.venueId, slot)
  if (!guest.ok)
    return { ok: false, error: guest.error, stage: 'sandbox_guest' }

  const materialized = await materializeTranscript({
    venueId: input.venueId,
    guestId: guest.guestId,
    sessionHistory: input.sessionHistory,
    // No inbound: that is what makes this the outbound flow. handleFollowup
    // asserts `currentMessage === null`, so passing one would trip its own
    // inbound-XOR-outbound invariant.
    inbound: [],
    channel: input.channel,
    now: input.now,
  })
  if (!materialized.ok)
    return { ok: false, error: materialized.error, stage: 'sandbox_transcript' }

  return draftFollowupReply({
    venueId: input.venueId,
    guestId: guest.guestId,
    trigger: input.trigger,
    now: input.now,
  })
}

/**
 * The venue's sandbox guest, created once and reused.
 *
 * `is_test_synthetic`, NEVER `is_demo`. That distinction is load-bearing:
 * `is_demo` makes the pipeline skip all four post-generation verifiers and
 * bypass the approval gate entirely (lib/agent/CLAUDE.md, "Demo guest
 * bypass"), so a demo-flagged arm would be comparing v2 against a v1 that
 * skips checks production runs. `is_test_synthetic` has no behavioural reader
 * anywhere in `lib/` - it is a label, which is what is wanted.
 *
 * Refuses outright if the number belongs to a real guest, mirroring
 * `ensureSyntheticGuest` in scripts/onboarding/run-test-scenarios.ts: a
 * collision means this function is about to write a test transcript into a
 * real person's history, and the transcript writer below would then DELETE
 * their messages. THAT GUARD IS WHAT MAKES TEN SLOTS AS SAFE AS ONE - it runs
 * per slot, so nine new numbers get the same refusal the first one always had.
 *
 * `first_name` is identical for every slot on purpose. Nothing on the inbound
 * reply path reads `guests.first_name` today (the prompt's guest block comes
 * from `guests.context`), but if something ever does, every slot must render
 * the same - a per-slot label would quietly make the slots non-interchangeable
 * and a batch comparison would be measuring the label.
 */
async function ensureSandboxGuest(
  venueId: string,
  slot: number,
): Promise<{ ok: true; guestId: string } | { ok: false; error: string }> {
  const supabase = createAdminClient()
  const phone = sandboxPhoneNumber(venueId, slot)

  const existing = await supabase
    .from('guests')
    .select('id, is_test_synthetic')
    .eq('venue_id', venueId)
    .eq('phone_number', phone)
    .maybeSingle()
  if (existing.error)
    return {
      ok: false,
      error: `sandbox guest lookup: ${existing.error.message}`,
    }
  if (existing.data) {
    if (existing.data.is_test_synthetic !== true)
      return {
        ok: false,
        error: `phone ${phone} at this venue is a REAL guest, not synthetic. Refusing to use it as the sandbox guest.`,
      }
    return { ok: true, guestId: existing.data.id }
  }

  const inserted = await supabase
    .from('guests')
    .insert({
      venue_id: venueId,
      phone_number: phone,
      first_name: 'Playground sandbox',
      created_via: 'manual',
      is_test_synthetic: true,
    })
    .select('id')
    .single()
  if (inserted.error || !inserted.data)
    return {
      ok: false,
      error: `sandbox guest insert: ${inserted.error?.message ?? 'no row returned'}`,
    }
  return { ok: true, guestId: inserted.data.id }
}

/**
 * Replace the synthetic guest's messages with this chat, newest row being the
 * inbound v1 should answer. Returns that row's id.
 *
 * Timestamps are spaced a minute apart ending at `now`, so history ordering
 * and the conversation-window predicates (`conversationWindowMs`, which
 * decides whether this is still one conversation) read it as a live exchange
 * rather than as rows that all arrived in the same millisecond.
 */
async function materializeTranscript(input: {
  venueId: string
  guestId: string
  sessionHistory: readonly HistoryTurn[]
  inbound: readonly string[]
  /**
   * Attachment links for this turn, written as their own bodyless inbound
   * row. Omit for a text-only turn.
   */
  mediaUrls?: readonly string[]
  /**
   * The instant the newest row lands on. Omit for the real clock.
   *
   * These rows then claim an arrival time they did not have, which is only
   * acceptable because of what they are: synthetic rows on an
   * `is_test_synthetic` guest, deleted by the next call to this function.
   * The alternative - real timestamps under an injected prompt clock - puts
   * two clocks in one turn and is the thing this parameter exists to avoid.
   */
  now?: Date
  /**
   * What channel these rows were exchanged on. Defaults to text.
   *
   * On a turn with no inbound it decides `ctx.conversationChannel`, which is
   * what four of the twelve follow-up triggers are gated on - so for the
   * proactive arm this is not cosmetic.
   */
  channel?: MessageChannel
}): Promise<
  { ok: true; inboundMessageId: string } | { ok: false; error: string }
> {
  const supabase = createAdminClient()
  const channel = input.channel ?? SANDBOX_CHANNEL

  // GUARDED DELETE. Scoped to venue AND guest, and the guest was just
  // confirmed `is_test_synthetic` by the only caller. The second predicate is
  // the one that matters: a venue-only scope here would wipe a venue's
  // messages table.
  const cleared = await supabase
    .from('messages')
    .delete()
    .eq('venue_id', input.venueId)
    .eq('guest_id', input.guestId)
  if (cleared.error)
    return {
      ok: false,
      error: `clearing sandbox history: ${cleared.error.message}`,
    }

  const MINUTE_MS = 60_000
  const rows = [
    ...input.sessionHistory.map((t) => ({
      direction:
        t.role === 'user' ? ('inbound' as const) : ('outbound' as const),
      // 'received'/'sent' are what the history query and groupIntoResponses
      // read as delivered; a held draft would be marked differently and this
      // transcript is one the operator has already seen go out.
      status: t.role === 'user' ? ('received' as const) : ('sent' as const),
      body: t.text,
      mediaUrls: [] as readonly string[],
    })),
    ...input.inbound.map((body) => ({
      direction: 'inbound' as const,
      status: 'received' as const,
      body,
      mediaUrls: [] as readonly string[],
    })),
    // ITS OWN ROW, with an empty body, because that is what both webhooks
    // store for an attachment: `body = ''` plus the links. Folding the links
    // onto the last text row instead would produce a message shape production
    // never writes, and `inbound-media.ts` branches on exactly this
    // distinction - a turn WITH text is answered and gets no card, a turn
    // with none raises one.
    ...(input.mediaUrls === undefined
      ? []
      : [
          {
            direction: 'inbound' as const,
            status: 'received' as const,
            body: '',
            mediaUrls: input.mediaUrls,
          },
        ]),
  ]
  // The newest row lands one MINUTE_MS short of `now`, so the turn's anchor
  // and the prompt's clock are the same instant to within a minute whether or
  // not a clock was injected. The anchor is this row's `created_at`:
  // handle-inbound's loader reads `receivedAt: new Date(data.created_at)`,
  // and `messages` has no `received_at` column (that one is on
  // `pos_tap_events`), so this single value moves both.
  const base = (input.now?.getTime() ?? Date.now()) - rows.length * MINUTE_MS
  const inserted = await supabase
    .from('messages')
    .insert(
      rows.map((r, i) => ({
        venue_id: input.venueId,
        guest_id: input.guestId,
        direction: r.direction,
        status: r.status,
        body: r.body,
        media_urls: [...r.mediaUrls],
        // REQUIRED by loadInbound, which throws on a row without one
        // ("message <id> has no provider_message_id"). Nullable in the schema,
        // so only running a real turn surfaces it. Prefixed and uuid-suffixed
        // so it can never be mistaken for a Sendblue or Meta id.
        provider_message_id: `playground-sandbox-${randomUUID()}`,
        // TYPED, not a bare literal: `messages_channel_check` (migration 048)
        // allows only 'text' and 'instagram', and the first version of this
        // wrote 'sms' - rejected by the database at runtime, invisible to
        // tsc. Annotating against MessageChannel moves that class of mistake
        // to compile time.
        channel,
        created_at: new Date(base + i * MINUTE_MS).toISOString(),
      })),
    )
    .select('id, direction, created_at')
  if (inserted.error || !inserted.data)
    return {
      ok: false,
      error: `writing sandbox history: ${inserted.error?.message ?? 'no rows returned'}`,
    }

  // The row v1 answers: the newest inbound. Read back from what was actually
  // inserted rather than assumed from array order - `insert().select()` does
  // not promise to echo input order, and answering the wrong row would make
  // v1 reply to an earlier message while looking perfectly healthy.
  const newestInbound = inserted.data
    .filter((r) => r.direction === 'inbound')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
  if (!newestInbound)
    return { ok: false, error: 'sandbox transcript wrote no inbound row' }
  return { ok: true, inboundMessageId: newestInbound.id }
}
