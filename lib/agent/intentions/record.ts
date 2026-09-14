import { classifyIntentionPrompts } from '@/lib/ai'
import { createAdminClient } from '@/lib/db/admin'
import { INTENTION_DEFINITION_BY_KEY, type IntentionKey, rearmsOnNewerEvent } from './definitions'
import type { NewlyEligibleIntention, OpenIntention } from './derive'

// TAC-324 / TAC-380: the two writes behind intentions. Both are fire-and-forget
// side effects dispatched from handle-inbound.ts via waitUntil, and neither can
// affect message delivery.
//
// Since migration 040 guest_intention_prompts holds STATE rows: prompted_at null
// means eligible-not-yet-raised, prompted_at set means raised and closed for good.
// Two traps follow from that, each pinned by record.test.ts:
//
//   TRAP 2. Recording used to be an upsert with ignoreDuplicates, i.e. ON
//   CONFLICT DO NOTHING. Against an eligibility row that already exists it
//   no-ops, prompted_at is never stamped, and the intention is re-asked every
//   turn. So the stamp is an UPDATE guarded on prompted_at IS NULL.
//
//   TRAP 3. prompted_at keeps its migration-035 DEFAULT now() through the
//   deploy window. An eligibility insert that merely omits prompted_at is born
//   already prompted. So every insert passes prompted_at: null explicitly.
//
//   RE-ARMING. An event-armed intention re-arms on a strictly newer event, and
//   an ignoreDuplicates upsert can never move an existing row, so a re-arm is an
//   UPDATE that moves eligible_at forward and nothing else. The row keeps its
//   last prompt, which the brake still counts; the intention reads as open again
//   because that prompt predates the new anchor. The stamp for those intentions
//   records which arming it closed; see closeIntentions for why the two writes
//   are safe in either order.

type Json = string | null

/**
 * One eligibility row. `prompted_at`, `prompt_source` and `message_id` are
 * written as explicit nulls — see trap 3 above. Exported so the test can pin the
 * exact shape with toStrictEqual, where a missing key and a null differ.
 */
export function buildEligibilityRow(input: {
  venueId: string
  guestId: string
  key: IntentionKey
  eligibleAt: Date
}): {
  venue_id: string
  guest_id: string
  intention_key: IntentionKey
  eligible_at: string
  prompted_at: Json
  prompt_source: Json
  message_id: Json
} {
  return {
    venue_id: input.venueId,
    guest_id: input.guestId,
    intention_key: input.key,
    eligible_at: input.eligibleAt.toISOString(),
    prompted_at: null,
    prompt_source: null,
    message_id: null,
  }
}

const ENSURE_OPTIONS = { onConflict: 'guest_id,intention_key', ignoreDuplicates: true } as const

export type RecordIntentionEligibilityOutcome =
  | { kind: 'nothing_to_record' }
  | { kind: 'recorded'; keys: IntentionKey[] }
  | { kind: 'failed'; error: string }

/**
 * Persist intentions seen eligible on this turn: insert the new ones, and move
 * re-armed ones to their newer anchor.
 *
 * ignoreDuplicates is RIGHT for the inserts, unlike on the stamp: a second
 * observation of the same intention must never move an existing eligible_at, or
 * a chatty guest would slide the expiry window later on every turn. The earliest
 * anchor wins.
 *
 * A re-arm is the one deliberate move, and only forward: it is guarded on the
 * stored eligible_at being strictly OLDER than the new anchor. Repeating it
 * matches nothing, and so does a row the prompt that asked about this arming has
 * already moved to it (see closeIntentions). It never touches the prompt: the
 * brake still counts it, and a prompt older than the new anchor reads as
 * belonging to an earlier arming.
 *
 * A failure is logged and otherwise harmless: the next turn re-derives the same
 * intention and tries again, with `now` a turn later for first-contact
 * intentions. Never throws.
 */
export async function recordIntentionEligibility(input: {
  venueId: string
  guestId: string
  entries: readonly NewlyEligibleIntention[]
}): Promise<RecordIntentionEligibilityOutcome> {
  if (input.entries.length === 0) return { kind: 'nothing_to_record' }
  const inserts = input.entries.filter((e) => !e.rearm)
  const rearms = input.entries.filter((e) => e.rearm)
  try {
    const supabase = createAdminClient()
    if (inserts.length > 0) {
      const { error } = await supabase.from('guest_intention_prompts').upsert(
        inserts.map((e) =>
          buildEligibilityRow({
            venueId: input.venueId,
            guestId: input.guestId,
            key: e.key,
            eligibleAt: e.eligibleAt,
          }),
        ),
        ENSURE_OPTIONS,
      )
      if (error) return { kind: 'failed', error: error.message }
    }
    for (const e of rearms) {
      const { error } = await supabase
        .from('guest_intention_prompts')
        .update({ eligible_at: e.eligibleAt.toISOString() })
        .eq('venue_id', input.venueId)
        .eq('guest_id', input.guestId)
        .eq('intention_key', e.key)
        .lt('eligible_at', e.eligibleAt.toISOString())
      if (error) return { kind: 'failed', error: error.message }
    }
    return { kind: 'recorded', keys: input.entries.map((e) => e.key) }
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * How many times the post-send classifier is called before closing
 * pessimistically: the first call plus ONE retry (TAC-380 ruling 4).
 */
export const CLASSIFIER_ATTEMPTS = 2

export type PromptSource = 'classified' | 'pessimistic'

export type RecordIntentionPromptsOutcome =
  | { kind: 'no_open_intentions' }
  | { kind: 'nothing_raised' }
  | { kind: 'recorded'; raisedKeys: IntentionKey[]; classifierAttempts: number }
  /**
   * The classifier failed on every attempt, so every RENDERED intention was
   * closed rather than risk asking it again. Not a real prompt — the brake
   * excludes these rows, and handle-inbound alerts on this outcome.
   */
  | { kind: 'closed_pessimistically'; closedKeys: IntentionKey[]; classifierError: string }
  /**
   * The write itself failed. The only path left to a genuine re-ask, so
   * handle-inbound alerts on it.
   */
  | { kind: 'write_failed'; keys: IntentionKey[]; source: PromptSource; error: string }

type ClassifierResult =
  | { ok: true; raisedKeys: string[]; attempts: number }
  | { ok: false; error: string }

async function classifyWithRetry(
  sentBody: string,
  openIntentions: { key: IntentionKey; description: string }[],
): Promise<ClassifierResult> {
  let lastError = 'classifier did not run'
  for (let attempt = 1; attempt <= CLASSIFIER_ATTEMPTS; attempt++) {
    try {
      const result = await classifyIntentionPrompts({ sentBody, openIntentions })
      if (result.ok) return { ok: true, raisedKeys: result.data.raisedKeys, attempts: attempt }
      lastError = result.error
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: false, error: lastError }
}

/**
 * Close these intentions for this guest: ensure a row exists for each, then
 * stamp prompted_at on the ones still unprompted.
 *
 * The ensure step exists because the eligibility write is fire-and-forget and
 * may not have landed yet. It carries each intention's own eligibleAt, so a row
 * created here is anchored correctly.
 *
 * First-contact intentions are stamped in one UPDATE guarded on prompted_at IS
 * NULL, so a concurrent close can't overwrite the first prompt's message_id.
 *
 * Event-armed intentions re-arm, so their stamp also records WHICH arming it
 * closed by setting eligible_at to the anchor that rendered. That is one UPDATE
 * per intention, since each has its own anchor, guarded so the re-arm write and
 * this stamp are safe in either order on the same turn:
 *   - never onto a row armed LATER than what rendered (eligible_at <= anchor),
 *     so a prompt from a superseded arming can't close the newer one;
 *   - onto a row with no prompt for this arming: unprompted, or prompted before
 *     this anchor (prompted_at < anchor), which can only be an earlier arming's
 *     prompt. That covers both the re-arm landing first and this stamp landing
 *     first, after which the re-arm matches nothing.
 * A prompt already recorded against this same arming still wins.
 */
async function closeIntentions(input: {
  venueId: string
  guestId: string
  messageId: string
  now: Date
  intentions: readonly OpenIntention[]
  source: PromptSource
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const stamp = {
    prompted_at: input.now.toISOString(),
    message_id: input.messageId,
    prompt_source: input.source,
  }
  const rearmable = input.intentions.filter((o) =>
    rearmsOnNewerEvent(INTENTION_DEFINITION_BY_KEY[o.key].armsOn),
  )
  const plain = input.intentions.filter(
    (o) => !rearmsOnNewerEvent(INTENTION_DEFINITION_BY_KEY[o.key].armsOn),
  )
  try {
    const supabase = createAdminClient()
    const { error: ensureError } = await supabase.from('guest_intention_prompts').upsert(
      input.intentions.map((o) =>
        buildEligibilityRow({
          venueId: input.venueId,
          guestId: input.guestId,
          key: o.key,
          eligibleAt: o.eligibleAt,
        }),
      ),
      ENSURE_OPTIONS,
    )
    if (ensureError) return { ok: false, error: ensureError.message }

    if (plain.length > 0) {
      const { error: stampError } = await supabase
        .from('guest_intention_prompts')
        .update(stamp)
        .eq('venue_id', input.venueId)
        .eq('guest_id', input.guestId)
        .in(
          'intention_key',
          plain.map((o) => o.key),
        )
        .is('prompted_at', null)
      if (stampError) return { ok: false, error: stampError.message }
    }

    for (const o of rearmable) {
      const anchor = o.eligibleAt.toISOString()
      const { error: stampError } = await supabase
        .from('guest_intention_prompts')
        .update({ ...stamp, eligible_at: anchor })
        .eq('venue_id', input.venueId)
        .eq('guest_id', input.guestId)
        .eq('intention_key', o.key)
        .lte('eligible_at', anchor)
        .or(`prompted_at.is.null,prompted_at.lt.${anchor}`)
      if (stampError) return { ok: false, error: stampError.message }
    }

    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * After a message sends, decide which rendered intentions it actually raised and
 * close them.
 *
 * `openIntentions` MUST be the set that was RENDERED this turn — the caller
 * passes renderableIntentions(...) — never a fresh derivation. A classifier
 * failure closes every intention in it, so passing anything wider would close
 * intentions the guest never saw (TAC-380 trap 4).
 *
 * Never throws: recording can't affect delivery, which already happened.
 */
export async function recordIntentionPrompts(input: {
  venueId: string
  guestId: string
  messageId: string
  sentBody: string
  openIntentions: readonly OpenIntention[]
  now: Date
}): Promise<RecordIntentionPromptsOutcome> {
  if (input.openIntentions.length === 0) return { kind: 'no_open_intentions' }

  const openKeys = input.openIntentions.map((o) => o.key)
  const classification = await classifyWithRetry(
    input.sentBody,
    input.openIntentions.map((o) => ({
      key: o.key,
      description: INTENTION_DEFINITION_BY_KEY[o.key].classifierDescription,
    })),
  )

  if (!classification.ok) {
    // Ruling 4. The read already fails closed; a write that failed open was the
    // asymmetry. A missed nudge is cheap and a re-ask is not, so close them all.
    const closed = await closeIntentions({
      venueId: input.venueId,
      guestId: input.guestId,
      messageId: input.messageId,
      now: input.now,
      intentions: input.openIntentions,
      source: 'pessimistic',
    })
    if (!closed.ok) {
      return { kind: 'write_failed', keys: openKeys, source: 'pessimistic', error: closed.error }
    }
    return { kind: 'closed_pessimistically', closedKeys: openKeys, classifierError: classification.error }
  }

  const raisedSet = new Set(classification.raisedKeys)
  const raised = input.openIntentions.filter((o) => raisedSet.has(o.key))
  if (raised.length === 0) return { kind: 'nothing_raised' }

  const raisedKeys = raised.map((o) => o.key)
  const closed = await closeIntentions({
    venueId: input.venueId,
    guestId: input.guestId,
    messageId: input.messageId,
    now: input.now,
    intentions: raised,
    source: 'classified',
  })
  if (!closed.ok) {
    return { kind: 'write_failed', keys: raisedKeys, source: 'classified', error: closed.error }
  }
  return { kind: 'recorded', raisedKeys, classifierAttempts: classification.attempts }
}
