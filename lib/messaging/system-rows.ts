// TAC-586: an outbound row the system sent on its own, which is never a reply.
//
// `messages.generated_by = 'system'` marks a message nobody wrote in answer
// to anything: today, the two passport images a bound scan sends
// (lib/passport/).
// The value was allowed by the column's check constraint and unused until
// then (0 rows on 2026-10-14), so it marks these rows and nothing older.
//
// WHY READERS SKIP THEM. Several readers treat "a delivered outbound row
// after X" as "the venue has spoken since X". A stamp image is not the venue
// speaking. Left visible it would (each measured against the code):
//   - drop the agent's reply to a guest who scanned AND typed, as already
//     answered (lib/messaging/instagram/reply-check.ts);
//   - release a held reply around an unanswered guest photo
//     (lib/agent/media-context.ts, lib/agent/inbound-media.ts);
//   - become "our last word" on a re-scan, starting a warm close or a visit
//     check-back nobody wrote (warm-close-store.ts, visit-checkin-store.ts);
//   - turn a guest's next scan greeting into a returning-conversation one
//     (lib/messaging/instagram/handle-events.ts hadPriorConversation).
// Skipping them leaves every one of those readers deciding exactly as it did
// before stamps existed.
//
// NULL IS NOT 'system'. Every echo row and every hand-typed reply has a NULL
// `generated_by`, and PostgREST's `neq` drops NULLs, so a bare
// `.neq('generated_by', 'system')` would hide all of them. Use the filter
// below, which keeps NULL explicitly, or `isSystemRow` in code.
//
// Recognition's `count_outbound_responses` is a SQL function, so it is
// corrected after the call instead: lib/recognition/load-signals.ts subtracts
// the system responses. NOT covered: the operator queue's three-message
// context (`list_operator_queue`, SQL), where a scan's images can take one
// slot. Cosmetic; recorded on TAC-586.

export const SYSTEM_GENERATED_BY = 'system'

/** A PostgREST `.or()` body: rows that are not system rows, NULL included. */
export const NOT_SYSTEM_ROW_FILTER = `generated_by.is.null,generated_by.neq.${SYSTEM_GENERATED_BY}`

export function isSystemRow(generatedBy: string | null | undefined): boolean {
  return generatedBy === SYSTEM_GENERATED_BY
}
