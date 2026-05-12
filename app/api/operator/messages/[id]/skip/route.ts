// POST /api/operator/messages/[id]/skip — operator chose not to send anything
// for this draft (TAC-258). State-only; no Sendblue dispatch, no corpus
// write, no response_review stamp (skip isn't an edit/approval — there's no
// operator-final text to ingest).
//
// Optimistic UPDATE: SET review_state='skipped', previous_review_state='pending',
// last_operator_action_at=now, last_operator_id=$op WHERE id=$id AND
// review_state='pending' AND venue_id = ANY($allowed). Rowcount=0 means
// either the message doesn't exist / isn't in our allowlist (404) or
// someone else already acted (200 with already_acted + current state).
//
// Doesn't go through dispatchOperatorOutbound because skip has its own
// shape (no Sendblue, no body change, no opt-out check — we're not sending
// anything). Direct UPDATE keeps the round-trip count minimal.

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { withOperatorAuth } from '@/lib/auth'
import { captureOperatorMessageSkipped } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ParamsSchema = z.object({ id: z.string().regex(UUID_RE) })

export const dynamic = 'force-dynamic'

export const POST = withOperatorAuth<{ id: string }>(
  async (_request, { operator, params }) => {
    const parsed = ParamsSchema.safeParse(params)
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid messageId' }, { status: 400 })
    }
    const messageId = parsed.data.id

    const supabase = createAdminClient()
    const now = new Date().toISOString()

    let claimQuery = supabase
      .from('messages')
      .update({
        review_state: 'skipped',
        previous_review_state: 'pending',
        last_operator_action_at: now,
        last_operator_id: operator.operatorId,
      })
      .eq('id', messageId)
      .eq('review_state', 'pending')
      .eq('direction', 'outbound')

    if (operator.allowedVenueIds.length > 0) {
      claimQuery = claimQuery.in('venue_id', operator.allowedVenueIds)
    }

    const { data: claimed, error: claimErr } = await claimQuery.select(
      'id, venue_id, guest_id, category, voice_fidelity, created_at',
    )

    if (claimErr) {
      return NextResponse.json(
        { error: 'internal error', detail: claimErr.message },
        { status: 500 },
      )
    }

    if (!claimed || claimed.length === 0) {
      // Rowcount=0 — either not found / not allowed, or already acted. Look
      // up the current state to distinguish.
      let lookupQuery = supabase
        .from('messages')
        .select('id, venue_id, review_state, direction')
        .eq('id', messageId)

      if (operator.allowedVenueIds.length > 0) {
        lookupQuery = lookupQuery.in('venue_id', operator.allowedVenueIds)
      }

      const { data: current } = await lookupQuery.maybeSingle()

      if (!current || current.direction !== 'outbound') {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
      return NextResponse.json({
        status: 'already_acted',
        messageId: current.id,
        reviewState: current.review_state,
      })
    }

    const row = claimed[0]!

    await captureOperatorMessageSkipped({
      venueId: row.venue_id,
      guestId: row.guest_id,
      messageId: row.id,
      operatorId: operator.operatorId,
      timeToActionMs: Math.max(0, Date.now() - new Date(row.created_at).getTime()),
      voiceFidelity: row.voice_fidelity,
      category: row.category,
      recognitionState: null,
    })

    return NextResponse.json({
      status: 'skipped',
      messageId: row.id,
      reviewState: 'skipped',
    })
  },
)
