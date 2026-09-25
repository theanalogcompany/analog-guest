// TAC-516: what Meta's data-deletion callback actually does.
//
// RULED 2026-09-23 (question 2): this DELETES. "We recorded your request" was
// the option that ruling rejected. Anonymising the guest is acceptable as
// long as nothing identifying survives — handle, scoped id, profile, name,
// phone, and message bodies that carry any of them.
//
// ============================================================================
// A CONSTRAINT THE PLAN MISSED, and the reason the scoped id is TOMBSTONED
// rather than nulled
// ============================================================================
//
// The approved redaction list nulled `instagram_scoped_id` AND `phone_number`
// on the same row. Migration 048 adds:
//
//     check (phone_number is not null or instagram_scoped_id is not null)
//
// so nulling both violates `guests_must_have_identity` and the UPDATE fails.
// Every deletion request would have errored, on the one callback Meta tests
// directly. Found at implementation time, not by a test, because no fixture
// enforces a CHECK.
//
// The fix keeps the ruling intact: the scoped id is REPLACED with an opaque
// random tombstone rather than removed. It satisfies the identity CHECK, the
// non-blank CHECK and the (venue_id, instagram_scoped_id) unique constraint,
// and it identifies nobody — it is a fresh random value with no relationship
// to the person, to their real scoped id, or to anything Meta could send. The
// real scoped id is gone, which is what the ruling asked for.
//
// ============================================================================
// WHAT IS REMOVED, AND WHAT IS KEPT
// ============================================================================
//
// Scope: every guest at the venue with a non-null `instagram_scoped_id` —
// every guest identified through this Instagram connection. Once a guest is
// in scope for erasure, their whole history at that venue is what the ruling
// means, regardless of which channel any individual message arrived on.
//
// REMOVED from `guests`:
//   instagram_scoped_id (tombstoned, see above), instagram_username,
//   instagram_name, instagram_profile_fetched_at,
//   instagram_profile_attempted_at, phone_number, email, first_name,
//   last_name, home_postal_code, distance_to_venue_miles, and `context`
//   reset to {}.
//
//   The last three go beyond the ruling's literal list and were approved
//   2026-09-24: postal code and distance are location-identifying, and
//   `context` is guest-authored free text that can carry a name, a workplace
//   or a life detail — exactly what "nothing identifying survives" is for.
//
// KEPT on `guests`, and why none of it resolves to a person:
//   id (a random uuid), venue_id, created_via, created_at/updated_at,
//   first_contacted_at, last_visit_at/last_visit_precision, the three dead
//   last_*_at columns, status, is_demo, is_test_synthetic — all operational
//   or timestamp data.
//
//   opted_out_at in particular MUST survive. Dropping it would silently
//   re-enable messaging to someone who asked us to stop, which is a worse
//   outcome than the one this function exists to produce.
//
// REMOVED from `messages`, for those guests at that venue:
//   body (replaced with a fixed marker), media_urls, response_review (it can
//   carry an operator's free text or an edited body), replaced_draft_body,
//   and provider_message_id.
//
//   provider_message_id was approved 2026-09-24 and is beyond the literal
//   list: Meta's `mid` encodes the account, the conversation and the message,
//   so it is a live handle on the conversation with that specific person.
//   NOTHING BREAKS BY NULLING IT, audited: every lookup BY that value
//   (the Sendblue webhook, handle-events, both echo reconcilers) keys on a
//   handle the provider just returned for an in-flight message, so a
//   historical row is unreachable; restoreCardAfterRefusedSend searches IS
//   NULL but is pinned by .eq('id') and review_state; three readers degrade
//   through `?? ''` or a nullable projection. The one reader that THROWS on a
//   null is loadInbound, and it is only reached when an inbound is handed to
//   the agent, which never happens for a redacted historical row — a
//   deliberate replay would throw rather than run, which is the right
//   direction anyway.
//
//   ungrounded_claims, pending_commitment and pending_cancellation were
//   ADDED in code review and are the reason to read this list rather than
//   assume it. `ungrounded_claims` holds the grounding verifier's VERBATIM
//   flagged claims — excerpts lifted out of the body — so nulling `body` and
//   leaving it would keep the exact sentences the redaction exists for, in a
//   sibling column on the same row. The two carriers hold model-written
//   prose whose `description` names what a comp or hold was for.
//
// KEPT on `messages`: the row itself and its timestamps, status,
//   review_state, category, channel, direction, ids, `review_triggers` (a
//   closed vocabulary of trigger codes) and `rendered_intentions` (intention
//   keys and timestamps), so count_outbound_responses and the recognition
//   signals that key on row existence keep working against an anonymised
//   shell.
//
// REMOVED OUTSIDE `messages`, because neither is free text and neither is
// covered by the residual below:
//   - `guest_card_fingerprints` rows are DELETED. A card fingerprint is a
//     stable identifier derived from the person's payment card and keyed on
//     guest_id, so it re-identifies the shell on their next tap.
//   - `inbound_turn_outcomes.detail` is reset to {}. TAC-523 put a phone's
//     last four digits there.
//   - `instagram_scan_arrivals` rows are DELETED (TAC-536). Enumerated from
//     the schema rather than waved through: venue_id, guest_id,
//     scan_message_id, scanned_at, had_prior_conversation, claimed_at,
//     venue_local_date, outcome, resolved_at, created_at. None of it is free
//     text and none of it identifies anybody, so redaction has nothing to
//     redact. They are deleted for a different reason, and it is BEHAVIOURAL:
//     an UNRESOLVED row is a pending greeting, and the every-minute cron would
//     claim it and generate an unprompted message for a guest who asked to be
//     erased. The send would fail at the tombstoned scoped id, but it would
//     spend a model call and could leave an operator card for a person who is
//     no longer there. Deleting is also what `on delete cascade` would have
//     done if this path deleted guests, which is the point of the next
//     paragraph.
//
// CASCADE NEVER FIRES ON THIS PATH, and that is why every guest-keyed table
// has to be named here by hand. The guest ROW survives, anonymised, so a
// foreign key with `on delete cascade` is never triggered. Any table added
// later with a guest_id needs a line in this function; the schema is the list
// to check, not this comment.
//
// NAMED RESIDUAL, not silently skipped: guest_commitments.description,
// transactions.raw_data, engagement_events.data and follow-up log rows can
// incidentally carry guest-volunteered free text, and `pos_tap_events`
// carries raw phone numbers but is VENUE-keyed rather than guest-keyed, so
// this function cannot scope it to the guests in question. A full sweep of
// every jsonb free-text field in the schema is out of scope for this pass.
// The ruling's enumerated list, message bodies, and the identifier carriers
// above are covered; the four named here are not, and that is a recorded
// decision rather than an oversight.
//
// IDEMPOTENT, and by a different mechanism than the obvious one: a tombstone
// is NON-NULL, so the `instagram_scoped_id is not null` scan below matches
// tombstoned rows and a second pass WOULD redact them again. What actually
// makes it idempotent is that the venue's `instagram_account_id` was cleared
// at the end of the first pass, so the second request matches no venue at
// all. Stated precisely because the wrong mechanism is what a future reader
// would reason from after the account has been reconnected.

import { randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

type AdminSupabaseClient = SupabaseClient<Database>

/** What a redacted message body is replaced with. Fixed, carries nothing. */
export const REDACTED_MESSAGE_BODY = '[removed at the account holder\'s request]'

/** Prefix for a tombstoned scoped id, so the column is readable in Studio. */
const TOMBSTONE_PREFIX = 'deleted:'

export type DeleteInstagramVenueDataResult =
  | { ok: true; venueId: string | null; guestsAffected: number; confirmationCode: string }
  | { ok: false; error: string; confirmationCode: string }

/** Opaque, unique, and related to nothing about the person. */
export function instagramScopedIdTombstone(): string {
  return `${TOMBSTONE_PREFIX}${randomUUID()}`
}

export async function deleteInstagramVenueData(
  supabase: AdminSupabaseClient,
  instagramAccountId: string,
): Promise<DeleteInstagramVenueDataResult> {
  const confirmationCode = randomUUID().replace(/-/g, '')

  const venue = await supabase
    .from('venues')
    .select('id')
    .eq('instagram_account_id', instagramAccountId)
    .maybeSingle()
  if (venue.error) return { ok: false, error: venue.error.message, confirmationCode }

  const venueId = venue.data?.id ?? null
  let guestsAffected = 0

  if (venueId !== null) {
    // Collected BEFORE anything is tombstoned, because the tombstone leaves
    // the column non-null and a re-read would match the same rows again.
    const guests = await supabase
      .from('guests')
      .select('id')
      .eq('venue_id', venueId)
      .not('instagram_scoped_id', 'is', null)
    if (guests.error) return { ok: false, error: guests.error.message, confirmationCode }

    const guestIds = (guests.data ?? []).map((row) => (row as { id: string }).id)
    guestsAffected = guestIds.length

    if (guestIds.length > 0) {
      // Messages first. If this failed after the guests were redacted, the
      // bodies would survive with no identity attached to find them by.
      const messages = await supabase
        .from('messages')
        .update({
          body: REDACTED_MESSAGE_BODY,
          media_urls: [],
          response_review: null,
          replaced_draft_body: null,
          provider_message_id: null,
          // Verbatim excerpts of the body, lifted out by the grounding
          // verifier. Nulling `body` and leaving these behind would keep the
          // exact sentences the redaction is for, in a sibling column on the
          // same row (found in code review).
          ungrounded_claims: null,
          // Model-written prose: `description` is what a comp or hold was
          // FOR, which routinely names the guest's order.
          pending_commitment: null,
          pending_cancellation: null,
        })
        .eq('venue_id', venueId)
        .in('guest_id', guestIds)
      if (messages.error) return { ok: false, error: messages.error.message, confirmationCode }

      // One UPDATE per guest, because each needs its OWN tombstone: a shared
      // value would violate (venue_id, instagram_scoped_id) on the second row.
      for (const guestId of guestIds) {
        const redacted = await supabase
          .from('guests')
          .update({
            instagram_scoped_id: instagramScopedIdTombstone(),
            instagram_username: null,
            instagram_name: null,
            instagram_profile_fetched_at: null,
            instagram_profile_attempted_at: null,
            phone_number: null,
            email: null,
            first_name: null,
            last_name: null,
            home_postal_code: null,
            distance_to_venue_miles: null,
            context: {},
          })
          .eq('id', guestId)
          .eq('venue_id', venueId)
        if (redacted.error) {
          return { ok: false, error: redacted.error.message, confirmationCode }
        }
      }

      // A card fingerprint is a STABLE IDENTIFIER derived from the person's
      // payment card, keyed on guest_id — it re-identifies the anonymised
      // shell the moment they tap again. Deleted outright rather than
      // redacted: the row's only purpose is to map a fingerprint to a guest,
      // so without the fingerprint there is nothing left to keep.
      const fingerprints = await supabase
        .from('guest_card_fingerprints')
        .delete()
        .eq('venue_id', venueId)
        .in('guest_id', guestIds)
      if (fingerprints.error) {
        return { ok: false, error: fingerprints.error.message, confirmationCode }
      }

      // TAC-536's pending scan greetings. Deleted rather than redacted: the
      // row carries no free text and identifies nobody, but an unresolved one
      // is a greeting the cron would still send. `on delete cascade` never
      // fires here, because the guest row survives anonymised rather than
      // being deleted.
      const scanArrivals = await supabase
        .from('instagram_scan_arrivals')
        .delete()
        .eq('venue_id', venueId)
        .in('guest_id', guestIds)
      if (scanArrivals.error) {
        return { ok: false, error: scanArrivals.error.message, confirmationCode }
      }

      // TAC-523's ledger. `detail` carries a phone's last four digits, which
      // is a partial identifier; the rest of the row is outcome vocabulary
      // and timestamps and is kept, so the ledger's counts stay honest.
      const ledger = await supabase
        .from('inbound_turn_outcomes')
        .update({ detail: {} })
        .eq('venue_id', venueId)
        .in('guest_id', guestIds)
      if (ledger.error) return { ok: false, error: ledger.error.message, confirmationCode }
    }

    // The credential is pure secret material with nothing worth keeping once
    // the account that granted it is gone: hard-deleted, not deactivated.
    const credential = await supabase.from('instagram_credentials').delete().eq('venue_id', venueId)
    if (credential.error) return { ok: false, error: credential.error.message, confirmationCode }

    const cleared = await supabase
      .from('venues')
      .update({ instagram_account_id: null })
      .eq('id', venueId)
    if (cleared.error) return { ok: false, error: cleared.error.message, confirmationCode }
  }

  return { ok: true, venueId, guestsAffected, confirmationCode }
}
