/**
 * What the owner segment of a ticket branch looks like: `<username>/<ticket>-...`.
 *
 * THIS USED TO BE THE LITERAL `jaipal`, which read like a username and was not
 * one. A branch under your own name matched nothing, so it registered as
 * nobody's claim and a build run would start a ticket a local session already
 * had. That is the 2026-09-17 incident (run 35299836324 resumed TAC-396 while a
 * local session was building it), where a human cancelling the run was the only
 * thing that stopped it.
 *
 * ONE SEGMENT. `team/alex/<ticket>-x` is not a ticket branch, and neither is a
 * bare `<ticket>-x` with no owner - the owner is what makes the branch
 * attributable to a session.
 *
 * A LEAF MODULE ON PURPOSE. This has no imports, and both readers import it
 * rather than restating it:
 *
 *   - scripts/lib/claims.mjs      isTicketBranch, which decides claims
 *   - scripts/lib/run-report.mjs  readGitState, the turn-limit report
 *
 * It is not in claims.mjs because build-ready.yml copies run-report.mjs AND ITS
 * TRANSITIVE IMPORTS to $RUNNER_TEMP before the session starts, and a test
 * asserts the copy list equals that closure. Importing claims.mjs for one
 * string would drag the whole claim-check module into the reporter's copy - the
 * wrong dependency direction, and a larger blast radius than the constant
 * deserves. A leaf adds exactly one file.
 *
 * Three copies of this pattern is how it went stale before: two regexes and a
 * glob in .claude/commands/work-ticket.md, and a note claiming five sites when
 * two of the five no longer existed. The glob is still a fourth copy, in prose
 * a session reads rather than code it runs; build-workflow.test.ts pins it.
 */
export const TICKET_BRANCH_OWNER = '[\\w.-]+'
