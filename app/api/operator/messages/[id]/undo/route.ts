// POST /api/operator/messages/[id]/undo — reverses the most recent operator
// action within the 3-second server-side window (TAC-258).
//
// Two paths:
//   1. skip → pending: the only truly revertible case. We flip
//      review_state back to 'pending' and clear the undo bookkeeping
//      columns. PostHog fires with undoneAfterDispatch=false.
//   2. approve | edit → no state change: the message has already been
//      dispatched via Sendblue and we do NOT retract. PostHog fires with
//      undoneAfterDispatch=true so analytics can measure "fraction of
//      approves the operator regretted within 3s". The response includes
//      a human-readable note so the mobile client can render an honest
//      toast.
//
// Window: now() - last_operator_action_at < interval '3 seconds'. Outside
// the window → 409 Conflict with code='UNDO_WINDOW_EXPIRED'. 409 (per
// the plan flip) is more conventional than 410 Gone for action endpoints
// that conflict with current state.
//
// Operator-mismatch (different operator's action) → 403. Per the plan, this
// is genuinely an authorization issue, not a state conflict; 409 would be
// wrong here.

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { withOperatorAuth } from '@/lib/auth'
import { captureOperatorMessageActionUndone } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ParamsSchema = z.object({ id: z.string().regex(UUID_RE) })

const UNDO_WINDOW_MS = 3000

export const dynamic = 'force-dynamic'

export const POST = withOperatorAuth<{ id: string }>(
  async (_request, { operator, params }) => {
    const parsed = ParamsSchema.safeParse(params)
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid messageId' }, { status: 400 })
    }
    const messageId = parsed.data.id

    const supabase = createAdminClient()

    let readQuery = supabase
      .from('messages')
      .select(
        'id, venue_id, guest_id, review_state, previous_review_state, last_operator_action_at, last_operator_id, direction',
      )
      .eq('id', messageId)

    if (operator.allowedVenueIds.length > 0) {
      readQuery = readQuery.in('venue_id', operator.allowedVenueIds)
    }

    const { data: row, error: readErr } = await readQuery.maybeSingle()
    if (readErr) {
      return NextResponse.json(
        { error: 'internal error', detail: readErr.message },
        { status: 500 },
      )
    }
    if (!row || row.direction !== 'outbound') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }

    if (!row.last_operator_action_at) {
      return NextResponse.json(
        { error: 'undo_window_expired', code: 'UNDO_WINDOW_EXPIRED' },
        { status: 409 },
      )
    }

    const actionAt = new Date(row.last_operator_action_at).getTime()
    const elapsedMs = Date.now() - actionAt
    if (elapsedMs >= UNDO_WINDOW_MS || elapsedMs < 0) {
      return NextResponse.json(
        { error: 'undo_window_expired', code: 'UNDO_WINDOW_EXPIRED' },
        { status: 409 },
      )
    }

    if (row.last_operator_id !== operator.operatorId) {
      return NextResponse.json(
        { error: 'undo_operator_mismatch', code: 'UNDO_OPERATOR_MISMATCH' },
        { status: 403 },
      )
    }

    const currentState = row.review_state
    const previousState = row.previous_review_state

    if (currentState === 'skipped' && previousState === 'pending') {
      // The only revertible case in v1. Optimistic UPDATE with a
      // last_operator_action_at equality guard prevents a concurrent
      // reapprove from being overwritten.
      const { data: reverted, error: revertErr } = await supabase
        .from('messages')
        .update({
          review_state: 'pending',
          previous_review_state: null,
          last_operator_action_at: null,
          last_operator_id: null,
        })
        .eq('id', row.id)
        .eq('review_state', 'skipped')
        .eq('last_operator_action_at', row.last_operator_action_at)
        .select('id')

      if (revertErr) {
        return NextResponse.json(
          { error: 'internal error', detail: revertErr.message },
          { status: 500 },
        )
      }
      if (!reverted || reverted.length === 0) {
        // Someone else's write landed between our SELECT and our UPDATE.
        return NextResponse.json(
          { error: 'undo_window_expired', code: 'UNDO_WINDOW_EXPIRED' },
          { status: 409 },
        )
      }

      await captureOperatorMessageActionUndone({
        venueId: row.venue_id,
        guestId: row.guest_id,
        messageId: row.id,
        operatorId: operator.operatorId,
        undoneActionType: 'skipped',
        undoneAfterDispatch: false,
        timeSinceActionMs: elapsedMs,
      })

      return NextResponse.json({
        status: 'undone',
        messageId: row.id,
        reviewState: 'pending',
      })
    }

    if (currentState === 'approved' || currentState === 'edited') {
      // State stays — message was already dispatched. Fire analytics only.
      await captureOperatorMessageActionUndone({
        venueId: row.venue_id,
        guestId: row.guest_id,
        messageId: row.id,
        operatorId: operator.operatorId,
        undoneActionType: currentState,
        undoneAfterDispatch: true,
        timeSinceActionMs: elapsedMs,
      })

      return NextResponse.json({
        status: 'logged',
        messageId: row.id,
        reviewState: currentState,
        note: 'message was already dispatched; undo logged for analytics only',
      })
    }

    // pending / auto_sent / null — nothing to undo.
    return NextResponse.json(
      { error: 'nothing to undo', currentReviewState: currentState },
      { status: 409 },
    )
  },
)
