/**
 * TAC-526: coalesce a guest's burst of messages into one agent turn.
 *
 * THE DEFECT. Both webhooks call `waitUntil(runInboundAgent(id))` once per
 * inbound row, so two messages seconds apart start two independent runs in two
 * serverless invocations that share no memory. Observed live at Le Mil's on
 * 2026-09-23: 7 seconds between the guest's two messages, 5 seconds between
 * the two replies, and the guest was asked their name twice.
 *
 * THE CORRECTION THAT DECIDES THE DESIGN. The ticket said each run was
 * generated without knowledge of the other. That is half wrong. Both runs
 * could see the other's MESSAGE — `build-runtime-context.ts` excludes only
 * `currentMessage.id`, so the second run had the first message in
 * `## Recent conversation`, rendered `[just now]`. Neither could see the
 * other's REPLY, because it did not exist yet. So the fix is **only one run
 * may produce a reply**, not "let the reply see both messages" — which is why
 * this module is a claim and no prompt file is touched.
 *
 * THREE MECHANISMS, in the order a turn meets them:
 *
 *   1. SETTLE. Wait `COALESCE_SETTLE_MS` before claiming, so a fragment that
 *      is already on its way lands before a model call is spent. An
 *      optimisation, not a correctness requirement: every acceptance criterion
 *      is met with the settle at zero, because (2) and (3) catch whatever it
 *      misses.
 *
 *   2. CLAIM. Exactly one run per (venue, guest) proceeds. The loser records
 *      itself as folded into the winner's turn and exits. This is the
 *      correctness mechanism, and it is durable because an in-memory guard is
 *      not a guard across serverless invocations.
 *
 *   3. EXTENSION. The winner re-checks for a newer message immediately before
 *      it dispatches, and adopts it rather than sending a reply to a message
 *      the guest has already moved past. Bounded by `MAX_TURN_EXTENSIONS`.
 *
 * And one thing that is none of the three and is load-bearing anyway: the
 * POST-TURN HANDOFF in `handle-inbound.ts`. See `RELEASE_THEN_HANDOFF` below.
 *
 * EVERY FAILURE FAILS OPEN. A store that cannot be read or written returns
 * `unavailable`, and the caller proceeds exactly as it does today. This whole
 * module is an improvement on behaviour that already works; blocking a reply
 * because a claim table was unreachable would make a guest's silence a NEW
 * failure mode introduced by the fix for a duplicate reply. The flag is the
 * other half of that posture: `INBOUND_COALESCING_ENABLED` is one constant, so
 * a rollback is a one-line revert.
 *
 * Never throws. `RAGResult`-shaped per the repo convention, with an injected
 * `{ store, now, sleep }` so no test ever waits 8 real seconds — the
 * `dispatch-instagram-reply.ts` precedent.
 */

import { createAdminClient } from '@/lib/db/admin'

/**
 * The flag. TAC-469 PR C's shape: the flip is its own one-line commit, so a
 * rollback is a one-line revert and nothing else moves.
 *
 * Read by `handle-inbound.ts` through the `enabled` parameter on
 * `openCoalescedTurn`, which defaults to this constant — so tests can force
 * the gate BOTH ways and the shut-gate behaviour stays covered after the flip,
 * which is what a rollback restores.
 */
export const INBOUND_COALESCING_ENABLED = false

/**
 * How long a run waits after `loadInbound` before claiming, so a fragment
 * already in flight lands first.
 *
 * 8 SECONDS, AND THE TRADE IS WRITTEN DOWN BECAUSE IT IS A REAL COST. The
 * observed burst gap was 7s, so 8s catches that burst before a model call is
 * spent. But TAC-421 deleted a 6.5s pre-send sleep for being 27% of a 24.4s
 * first-bubble p50, and this adds 8s back. The difference is what the delay
 * buys: TAC-421's sleep bought nothing (its own invariant test was a
 * tautology), and this buys one reply instead of two.
 *
 * THE NO-SETTLE ALTERNATIVE WAS COSTED AND REJECTED, NOT OVERLOOKED. At
 * `COALESCE_SETTLE_MS = 0` every acceptance criterion still passes, because
 * the pre-dispatch extension check catches what the settle misses. Against the
 * ticket's measured 37/168 ~ 22% burst rate: no-settle is ~5s better in
 * expectation (21.3s vs 26s), ~7s worse per burst (~33s vs ~26s), and spends
 * one wasted generation set per burst (~0.22 per turn), since the run
 * generates, discovers a newer message, and generates again.
 *
 * So 8s trades expected latency for worst-case latency and model cost. If that
 * trade proves wrong the lever is this one constant, and
 * `scripts/measurement/coalesce-window.ts` is what supplies the evidence to
 * move it rather than the argument.
 *
 * ALSO ON THE LATENCY LEDGER: the read receipt fires inside `scheduleAndSend`,
 * so this delays it by the same 8s. Firing it before the settle would make the
 * wait feel better and costs a provider call per inbound message on a
 * hard-stop surface. Considered, out of scope, stated rather than discovered.
 */
export const COALESCE_SETTLE_MS = 8_000

/**
 * How long a claim is honoured before another run may take it over.
 *
 * A BACKSTOP, NOT THE MECHANISM. The normal path releases explicitly in a
 * `finally`; this covers only a function killed without running any code at
 * all (OOM, wall-clock kill). Comfortably above a worst-case turn — an ~18s
 * floor plus two extensions plus backstop retries — and short enough that a
 * dead run cannot mute a guest for long.
 */
export const CLAIM_LEASE_MS = 120_000

/**
 * How many times one turn may adopt a newer message before it sends what it
 * has. Bounded so a guest typing continuously cannot hold a turn open forever;
 * at the bound the run sends and the post-turn handoff covers the remainder.
 */
export const MAX_TURN_EXTENSIONS = 2

/** A row of `inbound_turn_claims` (migration 057). */
export interface TurnClaimRow {
  venueId: string
  guestId: string
  claimedMessageId: string
  agentRunId: string
  claimedAt: Date
  expiresAt: Date
}

export type InsertClaimResult =
  | { ok: true; conflict: boolean }
  | { ok: false; error: string }

export type ReadClaimResult =
  | { ok: true; claim: TurnClaimRow | null }
  | { ok: false; error: string }

export type TakeOverClaimResult =
  | { ok: true; tookOver: boolean }
  | { ok: false; error: string }

export type DeleteClaimResult =
  | { ok: true; deleted: boolean }
  | { ok: false; error: string }

/**
 * The store, narrow on purpose.
 *
 * `insertClaim` MUST be a plain INSERT with no ON CONFLICT clause: the primary
 * key is what makes exactly one run win, and an upsert that swallowed the
 * conflict would hand both runs a success. `claimFollowupLogRows`
 * (followups/log.ts) is the same idiom against the same class of race, and
 * carries the same warning.
 */
export interface TurnClaimStore {
  insertClaim(row: TurnClaimRow): Promise<InsertClaimResult>
  readClaim(venueId: string, guestId: string): Promise<ReadClaimResult>
  /** CAS: succeeds only while the stored `agent_run_id` is still the expected one. */
  takeOverClaim(input: {
    row: TurnClaimRow
    expectedAgentRunId: string
  }): Promise<TakeOverClaimResult>
  /** Scoped to the holder, so a run can never delete a claim it does not hold. */
  deleteClaim(input: {
    venueId: string
    guestId: string
    agentRunId: string
  }): Promise<DeleteClaimResult>
}

/** The newest inbound message for a guest, as the coalescer needs it. */
export interface NewerInbound {
  id: string
  createdAt: Date
}

export type FindNewerInboundResult =
  | { ok: true; newer: NewerInbound | null }
  | { ok: false; error: string }

export interface CoalesceDeps {
  store: TurnClaimStore
  /**
   * The newest inbound from this guest strictly after `(afterCreatedAt, afterId)`.
   *
   * ORDERED ON `(created_at desc, id desc)` AND COMPARED ON THE PAIR, because
   * one Instagram delivery can carry several guest messages inserted in the
   * same millisecond (`entry[] x messaging[]`), so `created_at` alone is not a
   * total order. Without the id tiebreak two runs can each believe they are
   * newest and neither adopts the other's message.
   */
  findNewerInbound(input: {
    venueId: string
    guestId: string
    afterCreatedAt: Date
    afterId: string
  }): Promise<FindNewerInboundResult>
  now(): Date
  sleep(ms: number): Promise<void>
}

/**
 * What came of trying to open a turn.
 *
 * `unavailable` is NOT a failure the caller acts on — it means the store could
 * not answer, so the caller proceeds as it does today. Kept distinct from
 * `won` so the difference is visible in a log line and in a test, rather than
 * being a silent equivalence nobody can see.
 */
export type ClaimOutcome =
  | { status: 'won' }
  | { status: 'lost'; heldByAgentRunId: string; heldForMessageId: string }
  | { status: 'unavailable'; error: string }

/**
 * Take the turn for this (venue, guest), or discover who holds it.
 *
 * Two steps, both existing repo idioms, no RPC:
 *
 *   1. INSERT. Success means won. No ON CONFLICT, so a race surfaces as 23505.
 *   2. On conflict, read the holder. A live lease means lost. An EXPIRED lease
 *      is taken over with a CAS gated on the holder's `agent_run_id` still
 *      being the one just read — `refresh-profile.ts`'s `claimed_elsewhere`
 *      shape — so two runs finding the same expired claim cannot both take it.
 *
 * A conflict whose holder has vanished by the time we read (the holder
 * released in between) retries the INSERT once. Bounded at one retry: a third
 * party can always take it, and a caller that fails open loses nothing by
 * treating that as lost.
 */
export async function claimInboundTurn(
  input: {
    venueId: string
    guestId: string
    claimedMessageId: string
    agentRunId: string
  },
  deps: CoalesceDeps,
): Promise<ClaimOutcome> {
  const row = buildClaimRow(input, deps.now())

  const inserted = await deps.store.insertClaim(row)
  if (!inserted.ok) return { status: 'unavailable', error: inserted.error }
  if (!inserted.conflict) return { status: 'won' }

  const held = await deps.store.readClaim(input.venueId, input.guestId)
  if (!held.ok) return { status: 'unavailable', error: held.error }

  // The holder released between our INSERT and our read. One retry; anything
  // beyond that is a live conversation we are better off deferring to.
  if (held.claim === null) {
    const retried = await deps.store.insertClaim(buildClaimRow(input, deps.now()))
    if (!retried.ok) return { status: 'unavailable', error: retried.error }
    if (!retried.conflict) return { status: 'won' }
    return { status: 'lost', heldByAgentRunId: 'unknown', heldForMessageId: 'unknown' }
  }

  // A live lease. Someone is working this conversation right now.
  //
  // Live while `now < expires_at`, so the exact expiry instant counts as
  // EXPIRED. One millisecond either way is immaterial in production; the
  // boundary is written down because the first test written for it asserted
  // the opposite and neither reading had been decided.
  if (held.claim.expiresAt.getTime() > deps.now().getTime()) {
    return {
      status: 'lost',
      heldByAgentRunId: held.claim.agentRunId,
      heldForMessageId: held.claim.claimedMessageId,
    }
  }

  // Expired: the holder died without running its `finally`. CAS-gated so two
  // runs reading the same expired claim cannot both take it over.
  const tookOver = await deps.store.takeOverClaim({
    row: buildClaimRow(input, deps.now()),
    expectedAgentRunId: held.claim.agentRunId,
  })
  if (!tookOver.ok) return { status: 'unavailable', error: tookOver.error }
  if (tookOver.tookOver) return { status: 'won' }
  return {
    status: 'lost',
    heldByAgentRunId: held.claim.agentRunId,
    heldForMessageId: held.claim.claimedMessageId,
  }
}

function buildClaimRow(
  input: {
    venueId: string
    guestId: string
    claimedMessageId: string
    agentRunId: string
  },
  now: Date,
): TurnClaimRow {
  return {
    venueId: input.venueId,
    guestId: input.guestId,
    claimedMessageId: input.claimedMessageId,
    agentRunId: input.agentRunId,
    claimedAt: now,
    expiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
  }
}

/**
 * Give back the turn.
 *
 * Scoped to `agent_run_id`, so a run that has already lost its claim to a
 * lease takeover cannot delete the new holder's row on its way out. That is
 * not hypothetical: the run whose lease expired is by definition still
 * running, and its `finally` is exactly what eventually fires.
 *
 * Never throws. A release that fails leaves the lease to expire, which is the
 * state this function exists to shorten rather than to create.
 */
export async function releaseInboundTurn(
  input: { venueId: string; guestId: string; agentRunId: string },
  deps: Pick<CoalesceDeps, 'store'>,
): Promise<DeleteClaimResult> {
  return deps.store.deleteClaim(input)
}

/**
 * The Supabase-backed store. Built lazily so a test injecting a fake never
 * constructs a client, which reads env at call time.
 */
export function defaultCoalesceDeps(): CoalesceDeps {
  let cached: ReturnType<typeof createAdminClient> | null = null
  const supabase = () => (cached ??= createAdminClient())
  return {
    store: {
      async insertClaim(row) {
        // PLAIN INSERT, NO ON CONFLICT. See TurnClaimStore's docstring: the
        // primary key is the mechanism, and an upsert would hand both runs a
        // success. `claimFollowupLogRows` carries the same warning.
        const { error } = await supabase().from('inbound_turn_claims').insert({
          venue_id: row.venueId,
          guest_id: row.guestId,
          claimed_message_id: row.claimedMessageId,
          agent_run_id: row.agentRunId,
          claimed_at: row.claimedAt.toISOString(),
          expires_at: row.expiresAt.toISOString(),
        })
        if (error) {
          if (error.code === '23505') return { ok: true, conflict: true }
          return { ok: false, error: `insertClaim: ${error.message}` }
        }
        return { ok: true, conflict: false }
      },
      async readClaim(venueId, guestId) {
        const { data, error } = await supabase()
          .from('inbound_turn_claims')
          .select('venue_id, guest_id, claimed_message_id, agent_run_id, claimed_at, expires_at')
          .eq('venue_id', venueId)
          .eq('guest_id', guestId)
          .maybeSingle()
        if (error) return { ok: false, error: `readClaim: ${error.message}` }
        if (!data) return { ok: true, claim: null }
        return {
          ok: true,
          claim: {
            venueId: data.venue_id,
            guestId: data.guest_id,
            claimedMessageId: data.claimed_message_id,
            agentRunId: data.agent_run_id,
            claimedAt: new Date(data.claimed_at),
            expiresAt: new Date(data.expires_at),
          },
        }
      },
      async takeOverClaim({ row, expectedAgentRunId }) {
        const { data, error } = await supabase()
          .from('inbound_turn_claims')
          .update({
            claimed_message_id: row.claimedMessageId,
            agent_run_id: row.agentRunId,
            claimed_at: row.claimedAt.toISOString(),
            expires_at: row.expiresAt.toISOString(),
          })
          .eq('venue_id', row.venueId)
          .eq('guest_id', row.guestId)
          // The CAS. Without it two runs reading one expired claim both "win".
          .eq('agent_run_id', expectedAgentRunId)
          .select('venue_id')
        if (error) return { ok: false, error: `takeOverClaim: ${error.message}` }
        return { ok: true, tookOver: (data?.length ?? 0) > 0 }
      },
      async deleteClaim({ venueId, guestId, agentRunId }) {
        const { data, error } = await supabase()
          .from('inbound_turn_claims')
          .delete()
          .eq('venue_id', venueId)
          .eq('guest_id', guestId)
          // Scoped to the holder: never delete someone else's claim.
          .eq('agent_run_id', agentRunId)
          .select('venue_id')
        if (error) return { ok: false, error: `deleteClaim: ${error.message}` }
        return { ok: true, deleted: (data?.length ?? 0) > 0 }
      },
    },
    async findNewerInbound({ venueId, guestId, afterCreatedAt, afterId }) {
      const { data, error } = await supabase()
        .from('messages')
        .select('id, created_at')
        .eq('venue_id', venueId)
        .eq('guest_id', guestId)
        .eq('direction', 'inbound')
        // `gte`, not `gt`: two messages from one Instagram delivery can share a
        // millisecond, so a strict `gt` on the timestamp alone would drop the
        // sibling this exists to find. The id tiebreak below is what excludes
        // the row itself.
        .gte('created_at', afterCreatedAt.toISOString())
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(2)
      if (error) return { ok: false, error: `findNewerInbound: ${error.message}` }
      const newer = pickNewer(data ?? [], afterCreatedAt, afterId)
      return { ok: true, newer }
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/**
 * Pure: pick the newest row strictly after `(afterCreatedAt, afterId)` on the
 * PAIR, so a same-millisecond sibling is ordered rather than dropped.
 *
 * Exported for tests. The comparison is the part worth asserting directly:
 * the one Instagram shape that breaks a timestamp-only ordering is two
 * messages of one delivery, and no fixture makes that visible by accident.
 */
export function pickNewer(
  rows: readonly { id: string; created_at: string }[],
  afterCreatedAt: Date,
  afterId: string,
): NewerInbound | null {
  const afterMs = afterCreatedAt.getTime()
  for (const row of rows) {
    const ms = new Date(row.created_at).getTime()
    if (Number.isNaN(ms)) continue
    if (ms > afterMs) return { id: row.id, createdAt: new Date(ms) }
    if (ms === afterMs && row.id > afterId) return { id: row.id, createdAt: new Date(ms) }
  }
  return null
}

/**
 * What one run carries across its own extensions, and what `handleInbound`'s
 * `finally` needs in order to release and hand off.
 *
 * Mutable and threaded rather than returned, because an extension RE-ENTERS
 * `runInboundTurn` and the claim, the extension budget and the answered
 * message all have to outlive that call.
 */
export interface InboundTurnState {
  /** Set once this run holds the claim. Null means there is nothing to release. */
  claim: { venueId: string; guestId: string } | null
  /** How many times this turn has already adopted a newer message. */
  extensionsUsed: number
  /** The newest message this turn actually covered. The handoff compares against it. */
  answered: { id: string; createdAt: Date } | null
  /** Whether coalescing ran for this turn. The handoff is part of the feature. */
  enabled: boolean
}

export function newInboundTurnState(enabled: boolean): InboundTurnState {
  return { claim: null, extensionsUsed: 0, answered: null, enabled }
}

/**
 * What came of opening a turn.
 *
 * `proceed` carries the message the run should actually answer, which is the
 * newest one it can see — not necessarily the one the webhook invoked it for.
 */
export type OpenTurnOutcome =
  | {
      status: 'proceed'
      answerMessageId: string
      /** False when the store could not answer: nothing to release later. */
      claimed: boolean
      /** Set when the store failed, so the caller can log why it proceeded unclaimed. */
      degraded: string | null
    }
  | { status: 'stand_down'; intoAgentRunId: string; intoMessageId: string }

/**
 * Settle, claim, and adopt the newest message of the burst.
 *
 * THE RUN THAT WAKES FIRST CLAIMS, AND ANSWERS THE NEWEST MESSAGE. The
 * alternative — the earlier run standing down so the later one replies — is
 * strictly worse: the earlier run has already served its settle, so deferring
 * makes the guest wait the later run's settle too, and it leaves a window
 * where nobody holds the turn.
 *
 * `enabled` is a parameter rather than a read of the constant so tests can
 * force the gate BOTH ways. That matters after the flip as much as before it:
 * a rollback restores the shut path, so the shut path must stay covered.
 */
export async function openCoalescedTurn(
  input: {
    venueId: string
    guestId: string
    messageId: string
    messageCreatedAt: Date
    agentRunId: string
  },
  deps: CoalesceDeps,
  enabled: boolean = INBOUND_COALESCING_ENABLED,
): Promise<OpenTurnOutcome> {
  // The shut path is today's behaviour exactly: no wait, no claim, no adopt.
  if (!enabled) {
    return { status: 'proceed', answerMessageId: input.messageId, claimed: false, degraded: null }
  }

  if (COALESCE_SETTLE_MS > 0) await deps.sleep(COALESCE_SETTLE_MS)

  const claimed = await claimInboundTurn(
    {
      venueId: input.venueId,
      guestId: input.guestId,
      claimedMessageId: input.messageId,
      agentRunId: input.agentRunId,
    },
    deps,
  )

  if (claimed.status === 'lost') {
    return {
      status: 'stand_down',
      intoAgentRunId: claimed.heldByAgentRunId,
      intoMessageId: claimed.heldForMessageId,
    }
  }

  // FAIL OPEN. The store could not answer, so behave as today: reply, and do
  // not pretend to hold a claim we would then try to release.
  if (claimed.status === 'unavailable') {
    return {
      status: 'proceed',
      answerMessageId: input.messageId,
      claimed: false,
      degraded: claimed.error,
    }
  }

  // Won. Adopt the newest message of the burst, which is what the settle was
  // for. A read failure here costs the adoption, never the reply.
  const newer = await deps.findNewerInbound({
    venueId: input.venueId,
    guestId: input.guestId,
    afterCreatedAt: input.messageCreatedAt,
    afterId: input.messageId,
  })
  const answerMessageId = newer.ok && newer.newer ? newer.newer.id : input.messageId
  return {
    status: 'proceed',
    answerMessageId,
    claimed: true,
    degraded: newer.ok ? null : newer.error,
  }
}

/**
 * Is there a message this turn has not covered, arrived while it worked?
 *
 * Called immediately before dispatch (the extension) and again after release
 * (the handoff). Returns null when there is nothing newer, when the budget is
 * spent, when coalescing is off, or when the read failed — every one of which
 * means "carry on", because none of them is a reason to withhold a reply.
 */
export async function findUncoveredInbound(
  input: { venueId: string; guestId: string },
  turn: InboundTurnState,
  deps: Pick<CoalesceDeps, 'findNewerInbound'>,
): Promise<NewerInbound | null> {
  if (!turn.enabled || turn.answered === null) return null
  const newer = await deps.findNewerInbound({
    venueId: input.venueId,
    guestId: input.guestId,
    afterCreatedAt: turn.answered.createdAt,
    afterId: turn.answered.id,
  })
  return newer.ok ? newer.newer : null
}

/** Whether this turn may adopt another message rather than send what it has. */
export function mayExtend(turn: InboundTurnState): boolean {
  return turn.enabled && turn.extensionsUsed < MAX_TURN_EXTENSIONS
}
