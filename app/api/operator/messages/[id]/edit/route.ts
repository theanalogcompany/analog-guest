// POST /api/operator/messages/[id]/edit — operator edits the pending draft
// body and dispatches the edited version via Sendblue (TAC-258).
//
// Per-row state after success:
//   messages.body                       = operator's edited text (canonical sent text)
//   messages.review_state               = 'edited'
//   response_review.editedMessage       = operator's edited text (operator-action signal)
//   response_review.originalAiBody      = AI draft captured pre-UPDATE
//   response_review.reviewedVia         = 'mobile_operator'
//   response_review.reviewedBy          = operator UUID
//   response_review.reviewedAt          = now
//
// Serial chain after dispatch (mirrors cc-review's circuit-breaker pattern):
//   1. upsertCorpusEdit (replace mode, source_ref='operator-approve:{id}')
//      — embeds operator-final text only; anti-corpus-poisoning rule.
//      Failure: 502 without stamping response_review (so a retry can detect
//      the missing stamp). Idempotent on retry via the (venue_id, source_ref)
//      partial unique index from migration 008.
//   2. response_review jsonb stamp. Failure: 500 with detail; the corpus row
//      stays (idempotent under replace mode).
//
// Already-acted (rowcount=0 on the optimistic UPDATE): return 200 with
// 'already_acted' + current reviewState. Do NOT re-stamp response_review —
// the first operator's edit already wrote it (with their originalAiBody).
// Per Jaipal's build note.

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { withOperatorAuth } from '@/lib/auth'
import { captureOperatorMessageEdited } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { dispatchOperatorOutbound } from '@/lib/operator'
import {
  MESSAGE_REVIEW_SCHEMA_VERSION,
  type MessageReview,
} from '@/lib/schemas'
import { SOURCE_REF_PREFIXES } from '@/lib/voice-training/channels'
import { upsertCorpusEdit } from '@/lib/voice-training'
import type { Json } from '@/db/types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ParamsSchema = z.object({ id: z.string().regex(UUID_RE) })
const BodySchema = z.object({
  editedBody: z.string().min(1).max(4000),
})

export const dynamic = 'force-dynamic'

export const POST = withOperatorAuth<{ id: string }>(
  async (request, { operator, params }) => {
    const paramsParsed = ParamsSchema.safeParse(params)
    if (!paramsParsed.success) {
      return NextResponse.json({ error: 'invalid messageId' }, { status: 400 })
    }
    const messageId = paramsParsed.data.id

    let body: z.infer<typeof BodySchema>
    try {
      const raw = await request.json()
      const parsed = BodySchema.safeParse(raw)
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'invalid body', detail: parsed.error.message },
          { status: 400 },
        )
      }
      body = parsed.data
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 })
    }

    const editedBody = body.editedBody.trim()

    const result = await dispatchOperatorOutbound({
      messageId,
      operatorId: operator.operatorId,
      allowedVenueIds: operator.allowedVenueIds,
      action: 'edit',
      editedBody,
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
      // Do NOT re-stamp response_review — first operator already wrote it.
      return NextResponse.json({
        status: 'already_acted',
        messageId: result.messageId,
        reviewState: result.currentReviewState,
      })
    }

    const sourceRef = `${SOURCE_REF_PREFIXES.operatorApprove}${result.messageId}`

    const corpusResult = await upsertCorpusEdit(
      {
        venueId: result.venueId,
        sourceRef,
        editedMessage: editedBody,
        tags: ['operator_approve', ...(result.category ? [result.category] : [])],
      },
      'replace',
    )
    if (!corpusResult.ok) {
      const status = corpusResult.errorCode === 'embed_failed' ? 502 : 500
      return NextResponse.json(
        {
          error: 'voice corpus write failed',
          detail: corpusResult.error,
          errorCode: corpusResult.errorCode,
        },
        { status },
      )
    }

    // Stamp response_review jsonb. Corpus row already landed; if this fails
    // the corpus row stays (idempotent under replace mode on retry).
    const nowIso = new Date().toISOString()
    const review: MessageReview = {
      schemaVersion: MESSAGE_REVIEW_SCHEMA_VERSION,
      reviewedBy: operator.operatorId,
      reviewedVia: 'mobile_operator',
      reviewedAt: nowIso,
      ...(result.category ? { category: result.category } : {}),
      editedMessage: editedBody,
      originalAiBody: result.originalBody,
    }
    const reviewJson = JSON.parse(JSON.stringify(review)) as Json

    const supabase = createAdminClient()
    const { error: stampErr } = await supabase
      .from('messages')
      .update({ response_review: reviewJson })
      .eq('id', result.messageId)
    if (stampErr) {
      return NextResponse.json(
        { error: 'review stamp failed', detail: stampErr.message },
        { status: 500 },
      )
    }

    const before = result.originalBody.length
    const after = editedBody.length
    const deltaPct = before === 0 ? 0 : Math.round(((after - before) / before) * 100)

    await captureOperatorMessageEdited({
      venueId: result.venueId,
      guestId: result.guestId,
      messageId: result.messageId,
      operatorId: operator.operatorId,
      timeToActionMs: Math.max(0, Date.now() - new Date(result.createdAt).getTime()),
      voiceFidelity: result.voiceFidelity,
      category: result.category,
      recognitionState: null,
      corpusSourceRef: sourceRef,
      bodyLengthBefore: before,
      bodyLengthAfter: after,
      bodyLengthDeltaPct: deltaPct,
    })

    return NextResponse.json({
      status: 'sent',
      messageId: result.messageId,
      providerMessageId: result.providerMessageId,
      reviewState: 'edited',
      corpusSourceRef: sourceRef,
    })
  },
)
