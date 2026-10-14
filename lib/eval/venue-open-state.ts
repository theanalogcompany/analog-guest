// "Was the venue open when this run was taken?" - read from the venue's own
// stored hours.
//
// WHY A RUN RECORDS THIS AT ALL. The prompt carries an open/closed line, so a
// run taken after close hedges its way through every scenario in it, and two
// runs in different states are not comparable with each other. Both the golden
// harness and the blind human evaluation store the state they ran in so a
// stale file cannot be misread later.
//
// EXTRACTED BECAUSE THE READ HAS A TRAP IN IT. The hours SUB-OBJECT is parsed,
// never the whole `VenueInfoSchema`: that schema requires `address`, so a
// venue missing an unrelated field would have its open state read as `unknown`
// for a reason that has nothing to do with hours. `loadVenueClock` in
// lib/agent/instagram-scan-greeting.ts documents the same trap, and a second
// hand-rolled copy of this read is how a surface quietly starts recording
// `unknown` for every venue.
//
// `lib/agent/venue-open-state.ts` is the RUNTIME sibling and is not this: it
// resolves the state off an already-loaded `RuntimeContext`. This one takes a
// venue id and does the read, which is what an offline run has.
//
// Fails to `unknown`, loudly in the return value and never as `closed`. A
// three-state answer is the honest one (.claude/rules/errors-as-values.md):
// "the hours were unreadable" must stay distinguishable from "the venue was
// closed", or a failed read is recorded as a stated closure.

import { createAdminClient } from '@/lib/db/admin'
import { resolveOpenState } from '@/lib/schemas/venue-hours'
import { VenueHoursSchema } from '@/lib/schemas/venue-info'

export type VenueOpenState = 'open' | 'closed' | 'unknown'

/**
 * The venue's open state at `at`, off `venue_configs.venue_info.hours`.
 *
 * `at` is the run's own clock - the real instant, or an injected one - so an
 * injected `--at=10:30` resolves the state the prompt will actually carry
 * rather than the one outside the window.
 */
export async function loadVenueOpenState(input: {
  venueId: string
  timezone: string
  at: Date
}): Promise<VenueOpenState> {
  const supabase = createAdminClient()
  const row = await supabase
    .from('venue_configs')
    .select('venue_info')
    .eq('venue_id', input.venueId)
    .maybeSingle()

  const rawInfo = row.data?.venue_info
  const parsed =
    rawInfo != null && typeof rawInfo === 'object' && !Array.isArray(rawInfo)
      ? VenueHoursSchema.safeParse(
          (rawInfo as Record<string, unknown>).hours ?? {},
        )
      : null
  if (parsed?.success !== true) return 'unknown'
  return resolveOpenState(parsed.data, input.timezone, input.at).state
}
