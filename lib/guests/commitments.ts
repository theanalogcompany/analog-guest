import {
  captureCommitmentDedupCheckFailed,
  captureCommitmentDeduped,
} from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'
import {
  type ArrivalSignal,
  type CommitmentType,
  type GuestCommitmentRow,
  GuestCommitmentRowSchema,
  type PendingCommitment,
} from '@/lib/schemas/guest-commitment'

// TAC-297. Mirrors the shape of lib/guests/context.ts: RAGResult-typed, never
// throws, fail-CLOSED on DB errors, fail-OPEN on malformed payloads. All
// status transitions are CAS-gated (conditional UPDATE on the prior status)
// so concurrent callers can't double-process the same row — the rowcount
// gate is what anchors push idempotency (design call #4 in the TAC-297
// plan-review thread).

// ===== Create =====

// Postgres unique_violation. Surfaces as `error.code === '23505'` on the
// PostgREST error object. Mirrors lib/agent/schedule-and-send.ts's constant
// of the same name — deliberately restated rather than imported, so this DB
// layer doesn't take a dependency on the agent orchestrator.
const PG_UNIQUE_VIOLATION = '23505'

/**
 * TAC-318. The dedup key for an OPEN commitment, mirroring the SQL
 * expression in `guest_commitments_open_dedup` (migration 037):
 *
 *     lower(trim(both from description))
 *
 * This function is the PRIMARY enforcement — `createCommitmentFromPending`
 * decides here whether to insert, and the index is only the backstop. Keep
 * the two in step: a change to this expression needs the matching migration,
 * and vice versa.
 *
 * The two normalizations are not byte-identical and do not need to be.
 * Postgres `trim(both from x)` strips SPACES only; JS `.trim()` strips all
 * whitespace, so this side is strictly more aggressive and collapses a
 * superset. `lower()` and `.toLowerCase()` can also disagree on a handful of
 * Unicode cases, in either direction. Both divergences are safe because both
 * layers are present:
 *
 *   - this side matches, the index wouldn't → we dedup a pair the index
 *     would have allowed. No error, and the more product-correct outcome
 *     (a trailing newline is not a second promise).
 *   - the index matches, this side didn't → the INSERT takes a 23505 and the
 *     writer resolves it to the existing row.
 *
 * In practice only the first direction is reachable: PG `trim(both from)`
 * strips a strict SUBSET of what JS `.trim()` strips, and PG `lower()` is at
 * most equal to `.toLowerCase()` over the cases in play, so this side can
 * collapse a pair the index would not but not the reverse. Descriptions are
 * also already JS-trimmed before they reach the carrier
 * (`pendingFromEmission`), so on live data the two agree outright.
 */
export function commitmentDedupKey(description: string): string {
  return description.trim().toLowerCase()
}

/**
 * Read the OPEN commitments for one guest and return the first whose
 * description matches `key` under `commitmentDedupKey`.
 *
 * The description match runs in JS rather than SQL on purpose. Matching
 * `lower(trim(description))` through PostgREST would mean `ilike` with
 * pattern-escaping for `%` and `_` in free-form model prose, and it would put
 * the dedup decision somewhere a unit test can only observe through a mock's
 * opinion of a query string. Here the decision is literally
 * `commitmentDedupKey`, so a test can prove the app path made it.
 *
 * The extra rows this pulls are bounded and small: it is the same per-guest
 * open set `findActiveCommitmentsForGuest` already loads on every agent run,
 * and it is served by idx_guest_commitments_active_for_guest (migration 026).
 *
 * Returns `{ ok: false }` on a read failure so the caller can fail OPEN —
 * losing a real commitment because a SELECT hiccuped is far worse than
 * writing a duplicate the index will reject anyway.
 */
async function findOpenCommitmentByDedupKey(
  supabase: ReturnType<typeof createAdminClient>,
  venueId: string,
  guestId: string,
  key: string,
): Promise<RAGResult<GuestCommitmentRow | null>> {
  const { data, error } = await supabase
    .from('guest_commitments')
    .select('*')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('status', 'open')
    .order('created_at', { ascending: true })
  if (error) {
    return { ok: false, error: error.message, errorCode: 'db_read_failed' }
  }
  for (const row of data ?? []) {
    const parsed = GuestCommitmentRowSchema.safeParse(row)
    if (!parsed.success) {
      // Fail-OPEN on a malformed row, matching findActiveCommitmentsForGuest:
      // skip it rather than failing the whole write. LOUD rather than silent,
      // unlike that sibling: there, an unparseable row costs one omitted
      // prompt line; here it makes the ledger's primary guard stop matching.
      // GuestCommitmentRowSchema closes enums on type/status/arrival_signal/
      // created_by, so a migration widening any of them without updating the
      // schema would silently switch dedup off across the fleet.
      console.warn(
        `[commitments] dedup read skipped an unparseable open row for venue=${venueId} guest=${guestId}: ${parsed.error.message}`,
      )
      continue
    }
    // Belt-and-braces against the server-side filter above. The status check
    // is duplicated here on purpose: this function's docstring invites reuse
    // of findActiveCommitmentsForGuest, which selects open + pending_ack, and
    // that refactor would otherwise start deduping against mid-flight rows
    // with nothing failing.
    if (parsed.data.status !== 'open') continue
    if (commitmentDedupKey(parsed.data.description) === key) {
      return { ok: true, data: parsed.data }
    }
  }
  return { ok: true, data: null }
}

/**
 * Types that route through operator review and carry a verification code.
 * `recommendation` is the only ungated type, which is what makes the upgrade
 * below one-directional.
 */
const GATED_TYPES: ReadonlySet<CommitmentType> = new Set(['comp', 'hold', 'discount'])

/**
 * TAC-318 code review. The dedup key deliberately excludes `type`, which
 * creates one path where deduping would LOSE a real promise: an open
 * `recommendation: "croissant"` absorbing a later `comp: "croissant"`.
 *
 * That sequence is realistic, not theoretical — recommend the croissant, guest
 * says it was stale, operator approves a comp on a croissant. Before this
 * function, the comp dispatched, resolved to the recommendation row, and
 * returned ok: the guest got no verification code, the arrival push announced
 * "recommendation" with no code, and the operator's authorisation left no
 * trace in the ledger.
 *
 * Narrowing the app check to same-type does NOT fix it: the index excludes
 * type too, so the insert would take a 23505 and land in the same place. The
 * fix has to be here.
 *
 * One-directional, and the direction is the whole point:
 *   recommendation → comp/hold/discount   UPGRADE the row in place.
 *   anything → recommendation             KEEP what's there. Downgrading a
 *                                         comp would destroy a code the guest
 *                                         has already been texted.
 *   gated → a different gated type        KEEP. Both carry codes; picking a
 *                                         winner is a product call nobody has
 *                                         made, and the event fires so it is
 *                                         visible if it ever happens.
 *
 * `source_message_id` moves to the upgrading message: it is the message that
 * made the promise the row now represents. `created_at` does not move — see
 * touchOpenCommitment.
 */
function shouldUpgrade(existing: CommitmentType, incoming: CommitmentType): boolean {
  return existing === 'recommendation' && GATED_TYPES.has(incoming)
}

/**
 * Record that an already-open commitment was promised again: bump
 * updated_at, leave created_at alone.
 *
 * created_at is NOT touched, and that is a decision rather than an omission.
 * It renders to the model as "promised 3 days ago" in ## Active commitments,
 * and TAC-341 will hang the recommendation horizon off it — bumping it on
 * every repeat mention would misreport the promise's age and make a stale
 * commitment immortal.
 *
 * Never fails the caller. The dedup decision has already been made and is
 * correct; the timestamp is an audit nicety. A CAS miss here (the row left
 * 'open' between the read and this write) or a DB error both fall back to
 * the row we already read.
 */
async function touchOpenCommitment(
  supabase: ReturnType<typeof createAdminClient>,
  existing: GuestCommitmentRow,
  now: Date,
  upgrade: { pending: PendingCommitment; sourceMessageId: string } | null = null,
): Promise<GuestCommitmentRow> {
  const { data, error } = await supabase
    .from('guest_commitments')
    .update({
      updated_at: now.toISOString(),
      ...(upgrade
        ? {
            type: upgrade.pending.type,
            code: upgrade.pending.code,
            expires_at: upgrade.pending.expiresAt,
            source_message_id: upgrade.sourceMessageId,
          }
        : {}),
    })
    .eq('id', existing.id)
    .eq('status', 'open')
    .select()
  if (error || !data || data.length === 0) return existing
  const parsed = GuestCommitmentRowSchema.safeParse(data[0])
  return parsed.success ? parsed.data : existing
}

/**
 * Shared tail for both dedup paths (the app-level check and the 23505
 * backstop): decide whether the repeat promise upgrades the row, apply it,
 * emit, and hand back the row the caller should treat as the commitment.
 *
 * Both paths go through here so they cannot drift — the 23505 branch is
 * reached precisely when the app check missed, and it would be the worse of
 * the two places to forget the upgrade.
 */
async function resolveToExisting(
  supabase: ReturnType<typeof createAdminClient>,
  existing: GuestCommitmentRow,
  pending: PendingCommitment,
  ctx: {
    venueId: string
    guestId: string
    sourceMessageId: string
    now: Date
    via: 'app_check' | '23505'
  },
): Promise<GuestCommitmentRow> {
  const upgrade = shouldUpgrade(existing.type, pending.type)
  const row = await touchOpenCommitment(
    supabase,
    existing,
    ctx.now,
    upgrade ? { pending, sourceMessageId: ctx.sourceMessageId } : null,
  )
  console.warn(
    upgrade
      ? `[commitments] dedup: upgraded open commitment=${existing.id} from ${existing.type} to ${pending.type} for venue=${ctx.venueId} guest=${ctx.guestId} (via=${ctx.via}, source=${ctx.sourceMessageId})`
      : `[commitments] dedup: reusing open ${existing.type} commitment=${existing.id} for venue=${ctx.venueId} guest=${ctx.guestId} rather than minting a duplicate (incoming=${pending.type}, via=${ctx.via}, source=${ctx.sourceMessageId})`,
  )
  void captureCommitmentDeduped({
    venueId: ctx.venueId,
    guestId: ctx.guestId,
    existingCommitmentId: existing.id,
    existingType: existing.type,
    incomingType: pending.type,
    sourceMessageId: ctx.sourceMessageId,
    via: ctx.via,
    upgraded: upgrade,
  })
  return row
}

/**
 * Materialize a guest_commitments row from a draft's pending_commitment jsonb
 * carrier. Called from two sites:
 *   - lib/operator/dispatch-operator-outbound.ts after the operator's
 *     approve/edit dispatch succeeds on a gated draft (comp/hold/discount).
 *   - lib/agent/schedule-and-send.ts inline after the rec's auto-send
 *     dispatch succeeds (ungated path — no queue gap to bridge).
 *
 * Both call sites await this synchronously so the materialization happens
 * before the route returns to the operator (or before the agent run completes
 * for the rec path). On failure we log + return error without rolling back
 * the already-sent message — the dispatch is canonical, the row write is
 * recovery-secondary (reconciliation via a follow-up ticket if pilot data
 * shows the failure mode).
 *
 * TAC-318 — DEDUP. At most one OPEN commitment per
 * (venue_id, guest_id, lower(trim(description))). A repeat promise resolves
 * to the existing row instead of minting a second one; callers see `ok: true`
 * with that row and cannot tell the difference, which is correct — the
 * commitment exists either way.
 *
 * Why it is needed here rather than upstream: this is the ONLY INSERT into
 * guest_commitments in the repo, and the duplication is not a double-invoke.
 * The mint fires once per DISPATCHED response, and production's duplicate
 * pairs had two distinct source messages (one `auto_sent`, one `approved` —
 * two different call sites), so they are two separate agent runs each
 * emitting `commitment` afresh. The agent re-emits because `# Commitments`
 * triggers per turn on "what your reply is promising" and nothing tells it an
 * open row already exists. The prompt half of that is a separate change; this
 * layer makes the ledger correct regardless of how often the agent re-emits.
 *
 * Scope note: dedup covers EVERY type, not just recommendation, because the
 * index does — an app check narrower than its own index would silently stop
 * running for the types it excluded, and only the 23505 path would catch
 * them. Because the key excludes `type`, the cross-type case needs a decision
 * rather than a blanket "reuse whatever is there": see shouldUpgrade, which
 * exists because a plain reuse LOSES an operator-approved comp that lands on
 * top of an open recommendation for the same item. Comp lifecycle is
 * untouched in the sense that matters: codes, pending_ack and the approval
 * gate are unchanged, a comp is never downgraded to a recommendation, and a
 * repeat of the SAME comp keeps the guest on the one code already texted.
 *
 * Two layers, deliberately:
 *   1. the check below — primary, and the reason the ledger is right.
 *   2. the 23505 branch — backstop, overwhelmingly for the check-then-insert
 *      TOCTOU window. It also covers Postgres/JS normalization divergence,
 *      but that direction is close to unreachable in practice (see
 *      commitmentDedupKey: this side collapses a strict superset), so do not
 *      read the normalization case as the reason this branch earns its
 *      keep — the race is.
 * Fail-OPEN on a dedup READ failure: proceed to insert. A hiccuped SELECT
 * must never cost a real commitment, and layer 2 still catches a true
 * duplicate.
 */
export async function createCommitmentFromPending(opts: {
  guestId: string
  venueId: string
  pendingCommitment: PendingCommitment
  sourceMessageId: string
  now: Date
}): Promise<RAGResult<GuestCommitmentRow>> {
  const { guestId, venueId, pendingCommitment, sourceMessageId, now } = opts
  try {
    const supabase = createAdminClient()
    const dedupKey = commitmentDedupKey(pendingCommitment.description)

    const existing = await findOpenCommitmentByDedupKey(
      supabase,
      venueId,
      guestId,
      dedupKey,
    )
    if (existing.ok && existing.data !== null) {
      return {
        ok: true,
        data: await resolveToExisting(
          supabase,
          existing.data,
          pendingCommitment,
          { venueId, guestId, sourceMessageId, now, via: 'app_check' },
        ),
      }
    }
    if (!existing.ok) {
      console.warn(
        `[commitments] dedup check failed for venue=${venueId} guest=${guestId}: ${existing.error}. Proceeding to insert; the unique index is the backstop.`,
      )
      void captureCommitmentDedupCheckFailed({
        venueId,
        guestId,
        sourceMessageId,
        error: existing.error,
      })
    }

    const { data, error } = await supabase
      .from('guest_commitments')
      .insert({
        guest_id: guestId,
        venue_id: venueId,
        type: pendingCommitment.type,
        description: pendingCommitment.description,
        code: pendingCommitment.code,
        status: 'open',
        created_by: 'agent',
        expires_at: pendingCommitment.expiresAt,
        source_message_id: sourceMessageId,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .select()
      .single()
    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) {
        const recovered = await findOpenCommitmentByDedupKey(
          supabase,
          venueId,
          guestId,
          dedupKey,
        )
        if (recovered.ok && recovered.data !== null) {
          return {
            ok: true,
            data: await resolveToExisting(
              supabase,
              recovered.data,
              pendingCommitment,
              { venueId, guestId, sourceMessageId, now, via: '23505' },
            ),
          }
        }
        // The conflicting row left 'open' between the violation and this
        // read. Rare enough to report rather than retry — the message is
        // already sent, and a retry loop here would be a second race.
        return {
          ok: false,
          error: recovered.ok
            ? `unique violation on guest_commitments_open_dedup but no open row found to resolve to: ${error.message}`
            : `unique violation on guest_commitments_open_dedup and the recovery read also failed (${recovered.error}): ${error.message}`,
          errorCode: 'db_write_failed',
        }
      }
      return { ok: false, error: error.message, errorCode: 'db_write_failed' }
    }
    const parsed = GuestCommitmentRowSchema.safeParse(data)
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid commitment row shape: ${parsed.error.message}`,
        errorCode: 'db_write_invalid_shape',
      }
    }
    return { ok: true, data: parsed.data }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_write_threw' }
  }
}

// ===== Transitions (CAS-gated) =====

export type TransitionResult = {
  transitioned: boolean
  row: GuestCommitmentRow | null
}

/**
 * Move a commitment from 'open' to 'pending_ack'. CAS-gated on status='open'
 * so concurrent callers (imminent inbound + cron firing on the same row)
 * produce exactly one transition.
 *
 * Returns `{ transitioned: true, row }` only when this caller actually
 * flipped the row. Caller MUST gate push-fire on this flag — firing on
 * transitioned=false would double-push when the loser CAS returns first.
 * Anchors design call #4 in the TAC-297 plan-review.
 *
 * Why we also write expectedArrival + arrivalSignal here: the imminent path
 * captures both at transition time (signal is 'imminent', expectedArrival is
 * now). The scheduled path uses scheduleArrival earlier to set them, then
 * the cron picks up the row and calls this with the prior values.
 */
export async function transitionToPendingAck(opts: {
  commitmentId: string
  expectedArrival: Date
  arrivalSignal: ArrivalSignal
  now: Date
}): Promise<RAGResult<TransitionResult>> {
  const { commitmentId, expectedArrival, arrivalSignal, now } = opts
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .update({
        status: 'pending_ack',
        expected_arrival: expectedArrival.toISOString(),
        arrival_signal: arrivalSignal,
        updated_at: now.toISOString(),
      })
      .eq('id', commitmentId)
      .eq('status', 'open')
      .select()
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_write_failed' }
    }
    if (!data || data.length === 0) {
      return { ok: true, data: { transitioned: false, row: null } }
    }
    const parsed = GuestCommitmentRowSchema.safeParse(data[0])
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid commitment row shape: ${parsed.error.message}`,
        errorCode: 'db_write_invalid_shape',
      }
    }
    return { ok: true, data: { transitioned: true, row: parsed.data } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_write_threw' }
  }
}

/**
 * Record a scheduled arrival on an 'open' commitment. Status stays 'open';
 * the hourly cron (/api/cron/commitments-due) picks up the row when
 * expected_arrival is due and calls transitionToPendingAck.
 *
 * CAS-gated on status='open' so we don't accidentally overwrite arrival
 * info on an already-acknowledged or cancelled row.
 */
export async function scheduleArrival(opts: {
  commitmentId: string
  expectedArrival: Date
  arrivalSignal: ArrivalSignal
  now: Date
}): Promise<RAGResult<TransitionResult>> {
  const { commitmentId, expectedArrival, arrivalSignal, now } = opts
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .update({
        expected_arrival: expectedArrival.toISOString(),
        arrival_signal: arrivalSignal,
        updated_at: now.toISOString(),
      })
      .eq('id', commitmentId)
      .eq('status', 'open')
      .select()
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_write_failed' }
    }
    if (!data || data.length === 0) {
      return { ok: true, data: { transitioned: false, row: null } }
    }
    const parsed = GuestCommitmentRowSchema.safeParse(data[0])
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid commitment row shape: ${parsed.error.message}`,
        errorCode: 'db_write_invalid_shape',
      }
    }
    return { ok: true, data: { transitioned: true, row: parsed.data } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_write_threw' }
  }
}

/**
 * Acknowledge a pending_ack commitment. CAS-gated on status='pending_ack'
 * AND venue_id IN allowedVenueIds — combines the state-machine gate with
 * the per-operator allowlist enforcement in a single conditional UPDATE
 * (one round trip, no read-then-write race).
 *
 * transitioned=false here means one of:
 *   - the row is already acknowledged / cancelled / never-pending,
 *   - or the commitment exists but is in a venue outside the operator's
 *     allowlist (handled the same as not-found, per the existence-leak
 *     prevention rule in CLAUDE.md).
 * The route handler maps this to 404 or 409 — the caller can't disambiguate
 * those at the DB layer without leaking existence, which is intentional.
 */
export async function markAcknowledged(opts: {
  commitmentId: string
  operatorId: string
  allowedVenueIds: string[]
  now: Date
}): Promise<RAGResult<TransitionResult>> {
  const { commitmentId, operatorId, allowedVenueIds, now } = opts
  if (allowedVenueIds.length === 0) {
    // Empty allowlist → no row matches by definition. Skip the round trip.
    return { ok: true, data: { transitioned: false, row: null } }
  }
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .update({
        status: 'acknowledged',
        acknowledged_at: now.toISOString(),
        acknowledged_by: operatorId,
        updated_at: now.toISOString(),
      })
      .eq('id', commitmentId)
      .eq('status', 'pending_ack')
      .in('venue_id', allowedVenueIds)
      .select()
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_write_failed' }
    }
    if (!data || data.length === 0) {
      return { ok: true, data: { transitioned: false, row: null } }
    }
    const parsed = GuestCommitmentRowSchema.safeParse(data[0])
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid commitment row shape: ${parsed.error.message}`,
        errorCode: 'db_write_invalid_shape',
      }
    }
    return { ok: true, data: { transitioned: true, row: parsed.data } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_write_threw' }
  }
}

/**
 * Cancel a pending_ack commitment. CAS-gated on status='pending_ack' AND
 * venue_id IN allowedVenueIds — same single-conditional-UPDATE shape as
 * markAcknowledged so the auth-allowlist enforcement and the state-machine
 * gate land in one round trip.
 *
 * Sets status='cancelled'. No cancelled_at / cancelled_by columns — the
 * TAC-299 ticket explicitly bounds the change to "no migration" and the
 * operator audit trail lives on the PostHog event
 * (operator_draft_decline_initiated carries operatorId + commitmentId).
 *
 * transitioned=false here means one of:
 *   - row doesn't exist,
 *   - row is in a venue outside the operator's allowlist,
 *   - row has moved to a non-pending_ack state (acknowledged, already
 *     cancelled, expired, redeemed).
 * The TAC-299 route handler logs but does NOT 500 on transitioned=false —
 * the decline draft is already persisted at that point, and the operator
 * can still decide whether to send it. We don't disambiguate because doing
 * so would require a second SELECT and the route is fire-and-forget on the
 * commitment-side effect after the persist succeeds.
 *
 * Race-safe against a concurrent markAcknowledged on the same row: the two
 * CAS gates compete, the loser gets transitioned=false. Decline-loser: log
 * + 200 (draft still persisted). Ack-loser: 409 per /acknowledge route.
 */
export async function markCancelled(opts: {
  commitmentId: string
  /**
   * Intentionally unused inside this helper — kept on the signature for
   * parity with markAcknowledged (so route handlers passing the same
   * opts shape don't have to special-case decline). The audit trail
   * lives on the captureOperatorDraftDeclineInitiated PostHog event,
   * which carries operatorId + commitmentId. No cancelled_by column
   * exists by design (TAC-299: no migration).
   */
  operatorId: string
  allowedVenueIds: string[]
  now: Date
}): Promise<RAGResult<TransitionResult>> {
  const { commitmentId, allowedVenueIds, now } = opts
  if (allowedVenueIds.length === 0) {
    return { ok: true, data: { transitioned: false, row: null } }
  }
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .update({
        status: 'cancelled',
        updated_at: now.toISOString(),
      })
      .eq('id', commitmentId)
      .eq('status', 'pending_ack')
      .in('venue_id', allowedVenueIds)
      .select()
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_write_failed' }
    }
    if (!data || data.length === 0) {
      return { ok: true, data: { transitioned: false, row: null } }
    }
    const parsed = GuestCommitmentRowSchema.safeParse(data[0])
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid commitment row shape: ${parsed.error.message}`,
        errorCode: 'db_write_invalid_shape',
      }
    }
    return { ok: true, data: { transitioned: true, row: parsed.data } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_write_threw' }
  }
}

// ===== Reads =====

/**
 * Load active commitments (open + pending_ack) for a single guest at a
 * single venue. Used by lib/agent/build-runtime-context.ts to populate the
 * ## Active commitments user-prompt block.
 *
 * Indexed by idx_guest_commitments_active_for_guest (migration 026).
 */
export async function findActiveCommitmentsForGuest(opts: {
  venueId: string
  guestId: string
}): Promise<RAGResult<GuestCommitmentRow[]>> {
  const { venueId, guestId } = opts
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .select('*')
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .in('status', ['open', 'pending_ack'])
      .order('created_at', { ascending: true })
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_read_failed' }
    }
    const rows: GuestCommitmentRow[] = []
    for (const row of data ?? []) {
      const parsed = GuestCommitmentRowSchema.safeParse(row)
      if (parsed.success) rows.push(parsed.data)
      // Fail-OPEN on a single malformed row — drop it, keep the rest. The
      // agent path treats absence as empty (block omitted), so a malformed
      // row degrades gracefully rather than killing the agent run.
    }
    return { ok: true, data: rows }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_read_threw' }
  }
}

/**
 * Find open commitments with arrival_signal='scheduled' and expected_arrival
 * populated. The morning-of model (TAC-297 follow-up): time-of-day filtering
 * lives in the processor, not the query — the processor knows each venue's
 * timezone and can decide per-row whether "now" falls in that venue's morning
 * hour. The SQL just provides the candidate set.
 *
 * imminent-signal rows are deliberately excluded — they fire off the inbound
 * (handle-inbound.ts), never from the cron. Including them here would let a
 * pathological cron tick (one that races a pending dispatchArrivalCapture
 * before its CAS lands) potentially transition the row.
 *
 * Indexed by idx_guest_commitments_due (migration 026) for the
 * `status='open' AND expected_arrival IS NOT NULL` half of the filter.
 */
export async function findScheduledOpenCommitments(): Promise<
  RAGResult<GuestCommitmentRow[]>
> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .select('*')
      .eq('status', 'open')
      .eq('arrival_signal', 'scheduled')
      .not('expected_arrival', 'is', null)
      .order('expected_arrival', { ascending: true })
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_read_failed' }
    }
    const rows: GuestCommitmentRow[] = []
    for (const row of data ?? []) {
      const parsed = GuestCommitmentRowSchema.safeParse(row)
      if (parsed.success) rows.push(parsed.data)
    }
    return { ok: true, data: rows }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_read_threw' }
  }
}
