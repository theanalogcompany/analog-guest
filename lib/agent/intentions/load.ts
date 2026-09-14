import { createAdminClient } from '@/lib/db/admin'

// TAC-380: the two reads behind intention derivation. Split out of
// build-runtime-context.ts so the filters they depend on can be pinned by a
// test — that file has no test harness, and these filters are the easiest thing
// in the whole feature to break silently.
//
// Since migration 040, guest_intention_prompts holds two kinds of row:
//   - a PROMPTED row (prompted_at set): the intention was raised and is closed
//     for this guest for good.
//   - an ELIGIBILITY row (prompted_at null): the intention became askable at
//     eligible_at and hasn't been raised yet.
//
// TRAP 1, and why both filters are in SQL rather than JS. Before 040 every row
// was a prompted row, so "a row exists" meant "already asked". A reader still
// keying on row existence now reads every eligible intention as already asked:
// the feature renders nothing, records nothing, and every test that doesn't
// inspect the query stays green. Filtering in SQL is also what keeps the fail-
// closed contract meaning what it says — a null result means a read failed, and
// never "the rows came back and JS sorted them wrongly".

export interface PromptedIntentionRow {
  /** Raw key. May be a retired definition's; the derivation ignores those. */
  intentionKey: string
  promptedAt: Date
  /** Null on rows written before migration 040's backfill. */
  eligibleAt: Date | null
  /** 'classified' | 'pessimistic', or null on rows written before migration 040's backfill. */
  promptSource: string | null
  messageId: string | null
}

export interface EligibleIntentionRow {
  intentionKey: string
  eligibleAt: Date | null
}

export interface IntentionRows {
  prompted: PromptedIntentionRow[]
  eligible: EligibleIntentionRow[]
}

/**
 * Load one guest's intention rows at one venue.
 *
 * Returns null on ANY failure, and callers fail CLOSED on null: nothing renders
 * that turn. A missed nudge is cheap; re-asking a guest something they were
 * already asked is the failure intentions exist to prevent. Never throws.
 */
export async function loadIntentionRows(
  venueId: string,
  guestId: string,
): Promise<IntentionRows | null> {
  try {
    const supabase = createAdminClient()
    const [promptedResult, eligibleResult] = await Promise.all([
      supabase
        .from('guest_intention_prompts')
        .select('intention_key, prompted_at, eligible_at, prompt_source, message_id')
        .eq('venue_id', venueId)
        .eq('guest_id', guestId)
        .not('prompted_at', 'is', null),
      supabase
        .from('guest_intention_prompts')
        .select('intention_key, eligible_at')
        .eq('venue_id', venueId)
        .eq('guest_id', guestId)
        .is('prompted_at', null),
    ])

    if (promptedResult.error || eligibleResult.error) {
      console.warn(
        `[intentions] guest_intention_prompts load failed for guest ${guestId}: ${
          promptedResult.error?.message ?? eligibleResult.error?.message
        }. Failing closed (rendering no intentions this turn).`,
      )
      return null
    }

    const prompted: PromptedIntentionRow[] = []
    for (const row of promptedResult.data ?? []) {
      if (row.prompted_at === null) {
        // The SQL filter guarantees this can't happen. If it does, the filter is
        // gone and this row could be either kind — refuse to guess.
        console.warn(
          `[intentions] prompted-row query returned a null prompted_at for guest ${guestId}. The prompted_at filter is missing; failing closed.`,
        )
        return null
      }
      prompted.push({
        intentionKey: row.intention_key,
        promptedAt: new Date(row.prompted_at),
        eligibleAt: row.eligible_at === null ? null : new Date(row.eligible_at),
        promptSource: row.prompt_source,
        messageId: row.message_id,
      })
    }

    const eligible: EligibleIntentionRow[] = (eligibleResult.data ?? []).map((row) => ({
      intentionKey: row.intention_key,
      eligibleAt: row.eligible_at === null ? null : new Date(row.eligible_at),
    }))

    return { prompted, eligible }
  } catch (e) {
    console.warn(
      `[intentions] guest_intention_prompts load threw for guest ${guestId}: ${
        e instanceof Error ? e.message : String(e)
      }. Failing closed.`,
    )
    return null
  }
}
