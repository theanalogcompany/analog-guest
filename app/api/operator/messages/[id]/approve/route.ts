// POST /api/operator/messages/[id]/approve — operator approves the pending
// draft as-is and dispatches it via Sendblue (TAC-258).
//
// Idempotency: dispatchOperatorOutbound's optimistic UPDATE serializes
// concurrent callers. On rowcount=0 the helper returns outcome='already_acted'
// — we surface that as 200 with the current review_state so the mobile client
// can render "this is already done" without a separate retry code path.
//
// ACL: out-of-allowlist messages return 404 (not 403) per the ticket — don't
// leak existence. dispatchOperatorOutbound enforces venue scoping internally.

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { withOperatorAuth } from '@/lib/auth'
import { captureOperatorMessageApproved } from '@/lib/analytics/posthog'
import { dispatchOperatorOutbound } from '@/lib/operator'

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

    const result = await dispatchOperatorOutbound({
      messageId,
      operatorId: operator.operatorId,
      allowedVenueIds: operator.allowedVenueIds,
      action: 'approve',
    })

    if (!result.ok) {
      switch (result.errorCode) {
        case 'message_not_found':
          return NextResponse.json({ error: 'not found' }, { status: 404 })
        case 'opted_out':
          return NextResponse.json({ error: 'guest opted out' }, { status: 422 })
        case 'venue_misconfigured':
          return NextResponse.json(
            { error: 'venue misconfigured', detail: result.error },
            { status: 400 },
          )
        case 'sendblue_failed':
          return NextResponse.json(
            { error: 'dispatch failed', detail: result.error },
            { status: 502 },
          )
        case 'invalid_input':
          return NextResponse.json({ error: result.error }, { status: 400 })
        case 'db_error':
        default:
          return NextResponse.json(
            { error: 'internal error', detail: result.error },
            { status: 500 },
          )
      }
    }

    if (result.outcome === 'already_acted') {
      return NextResponse.json({
        status: 'already_acted',
        messageId: result.messageId,
        reviewState: result.currentReviewState,
      })
    }

    await captureOperatorMessageApproved({
      venueId: result.venueId,
      guestId: result.guestId,
      messageId: result.messageId,
      operatorId: operator.operatorId,
      timeToActionMs: Math.max(0, Date.now() - new Date(result.createdAt).getTime()),
      voiceFidelity: result.voiceFidelity,
      category: result.category,
      recognitionState: null,
    })

    return NextResponse.json({
      status: 'sent',
      messageId: result.messageId,
      providerMessageId: result.providerMessageId,
      reviewState: 'approved',
    })
  },
)
