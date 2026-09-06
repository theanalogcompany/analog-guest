import { classifyIntentionPrompts } from '@/lib/ai'
import { createAdminClient } from '@/lib/db/admin'
import { INTENTION_DEFINITIONS, type IntentionKey } from './definitions'
import type { OpenIntention } from './derive'

// TAC-324: after a message sends, determine which first-touch intentions it
// actually raised and write a row per raised key. Mirrors the post-generation,
// non-invasive posture of lib/agent/extract-reported-order.ts — generation
// itself stays untouched, this is a fire-and-forget side effect dispatched
// from handle-inbound.ts via waitUntil AFTER scheduleAndSend succeeds.
//
// Gate: only ever considers keys in `openIntentions` — the CALLER's
// already-suppressed, already-rendered set (see derive.ts's
// applyCurrentTurnSuppression) — never a fresh re-derivation. A key the model
// wasn't shown as open this turn can't have been "raised" by this turn's
// reply in the sense this table means.

export type RecordIntentionPromptsOutcome =
  | { kind: 'no_open_intentions' }
  | { kind: 'nothing_raised' }
  | { kind: 'recorded'; raisedKeys: IntentionKey[] }
  | { kind: 'failed'; error: string }

/**
 * Never throws. Every branch — including the classifier call and the DB
 * write — returns a typed outcome and is logged (console.warn/console.error),
 * matching extractReportedOrder's failure-handling posture: recording failure
 * must not affect message delivery, which has already happened by the time
 * this runs.
 */
export async function recordIntentionPrompts(input: {
  venueId: string
  guestId: string
  messageId: string
  sentBody: string
  openIntentions: readonly OpenIntention[]
}): Promise<RecordIntentionPromptsOutcome> {
  try {
    if (input.openIntentions.length === 0) {
      return { kind: 'no_open_intentions' }
    }

    const openKeys = input.openIntentions.map((o) => o.key)
    // classifierDescription lives on IntentionDefinition (definitions.ts),
    // not duplicated into a separate lib/ai-side lookup — a key with no
    // definition here (shouldn't happen; openIntentions is always derived
    // from INTENTION_DEFINITIONS) is dropped defensively rather than sent to
    // the classifier with a missing description.
    const openIntentionsWithDescriptions = openKeys
      .map((key) => {
        const definition = INTENTION_DEFINITIONS.find((d) => d.key === key)
        return definition ? { key, description: definition.classifierDescription } : null
      })
      .filter((o): o is { key: IntentionKey; description: string } => o !== null)

    const classification = await classifyIntentionPrompts({
      sentBody: input.sentBody,
      openIntentions: openIntentionsWithDescriptions,
    })
    if (!classification.ok) {
      return { kind: 'failed', error: classification.error }
    }

    const raisedKeys = classification.data.raisedKeys.filter((k): k is IntentionKey =>
      (openKeys as readonly string[]).includes(k),
    )
    if (raisedKeys.length === 0) {
      return { kind: 'nothing_raised' }
    }

    const supabase = createAdminClient()
    // Independent per-(guest_id, intention_key) upserts — unlike
    // claimFollowupLogRows's bare multi-row INSERT (which deliberately avoids
    // onConflict because it needs atomic all-or-nothing rollback across a
    // shared-mutex claim), these rows have no cross-row atomicity requirement.
    // ignoreDuplicates matches the ticket's literal "insert with on conflict
    // do nothing" instruction: a concurrent write racing to raise the same
    // intention silently no-ops on the second write rather than surfacing a
    // 23505 the caller has to branch on.
    const { error } = await supabase
      .from('guest_intention_prompts')
      .upsert(
        raisedKeys.map((intentionKey) => ({
          venue_id: input.venueId,
          guest_id: input.guestId,
          intention_key: intentionKey,
          message_id: input.messageId,
        })),
        { onConflict: 'guest_id,intention_key', ignoreDuplicates: true },
      )
    if (error) {
      return { kind: 'failed', error: error.message }
    }

    return { kind: 'recorded', raisedKeys }
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}
