// TAC-386: how far apart two proactive messages to one guest have to be.
//
// PURE, and deliberately its own module rather than a constant on the engine.
// Three mechanisms read this rule (TAC-536's scan greeting, TAC-560's warm
// close, TAC-386's inquiry follow-up), and the engine that owns the newest of
// them imports handleFollowup, which reaches the Voyage and Supabase clients at
// module load. Importing a constant from there pulls all of that into any test
// process that touches it, and `vi.mock` does not help (root CLAUDE.md, "Module
// split for testability"). That is not hypothetical: it is how this module came
// to exist, after `warm-close-timeout.test.ts` failed to load at all.
//
// THE PREDICATE LIVES HERE TOO, not just the number. An earlier draft exported
// the constant and left each caller to write `now - last < MINUTES * 60 * 1000`,
// which is the same comparison in two places with two chances to get the
// boundary or the unit wrong.

/**
 * Minutes that must separate two proactive messages to one guest.
 *
 * Ruled 2026-09-30, from "for example no proactive send within an hour of
 * another" — taken as the number rather than as an example, and confirmed on
 * approval.
 *
 * A JUDGMENT, not a measurement. What would show it wrong is a guest receiving
 * two proactive messages that read as crowding each other at 61 minutes apart,
 * or a follow-up going out so much later than its moment that it reads as
 * random.
 */
export const PROACTIVE_SPACING_MINUTES = 60

const MS_PER_MINUTE = 60 * 1000

/**
 * Has a proactive message reached this guest too recently for another?
 *
 * `lastProactiveSendAt` is `guests.last_proactive_send_at`, written by each
 * mechanism on a confirmed send. Null means none ever has, which is never too
 * soon.
 *
 * STRICTLY LESS THAN, so a send landing exactly on the boundary is allowed: the
 * spacing is a gap the guest has had, not a deadline to beat. Same direction
 * `isWarmCloseDue` and `isScanGreetingDue` take for their own floors.
 */
export function isTooSoonAfterProactive(
  lastProactiveSendAt: Date | null,
  now: Date,
): boolean {
  if (lastProactiveSendAt === null) return false
  return (
    now.getTime() - lastProactiveSendAt.getTime() <
    PROACTIVE_SPACING_MINUTES * MS_PER_MINUTE
  )
}
