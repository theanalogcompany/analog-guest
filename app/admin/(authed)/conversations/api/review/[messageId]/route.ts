import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { Json } from '@/db/types'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import {
  MESSAGE_REVIEW_SCHEMA_VERSION,
  type MessageReview,
} from '@/lib/schemas'
import { dedupeAndAppendAntiPatterns, upsertCorpusEdit } from '@/lib/voice-training'

// PUT /admin/conversations/api/review/[messageId] — capture a per-message
// response review from the Command Center conversation viewer (THE-235).
// Mirrors the 08-flow's onboarding ingestion contract on a live message.
//
// Channel: cc-review:{message_id}. Persists three artifacts in serial,
// JSONB stamp last:
//   1. voice_corpus row when editedMessage is present (replace mode — re-
//      edit overrides the prior save). Only `editedMessage` content is
//      embedded — anti-corpus-poisoning rule.
//   2. brand_persona.voiceAntiPatterns dedupe-append when rule is present.
//   3. messages.response_review JSONB stamp.
//
// No verdict field. Presence/absence of editedMessage IS the edit signal;
// presence/absence of rule IS the rule signal. expectedFailure=true short-
// circuits ingestion (skip corpus + antipattern) and just stamps the JSONB.
//
// Atomicity: serial chain, no stored procedure (supabase-js doesn't expose
// BEGIN/COMMIT cleanly). Operator sees error toast on partial failure;
// retry is end-state-idempotent — corpus is replace-in-place via the
// (venue_id, source_ref) partial unique index from migration 008,
// antipattern dedupe filters duplicates, JSONB stamp is the last write.
//
// Voyage on save: fail the save and roll back the corpus row (handled
// inside upsertCorpusEdit). Don't persist un-embedded.
//
// Direction guard: API rejects inbound (400). Trace-less outbound is
// accepted — the form renders for any outbound regardless of trace presence.

const PutBodySchema = z.object({
  category: z.string().optional(),
  editedMessage: z.string().optional(),
  comment: z.string().optional(),
  rule: z.string().optional(),
  expectedFailure: z.string().optional(),
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const dynamic = 'force-dynamic'

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
): Promise<NextResponse> {
  // ---- auth ----
  let operatorId: string
  let allowedVenueIds: string[]
  try {
    const supabaseSession = await createServerClient()
    const {
      data: { session },
    } = await supabaseSession.auth.getSession()
    if (!session) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const op = await verifyAnalogAdminAccess(session.user.id)
    operatorId = op.operatorId
    allowedVenueIds = op.allowedVenueIds
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: 'auth check failed' }, { status: 500 })
  }

  // ---- params + body ----
  const { messageId } = await params
  if (!UUID_RE.test(messageId)) {
    return NextResponse.json({ error: 'invalid messageId' }, { status: 400 })
  }

  let body: z.infer<typeof PutBodySchema>
  try {
    const raw = await request.json()
    const parsed = PutBodySchema.safeParse(raw)
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

  // ---- message lookup + direction + venue allowlist ----
  const supabase = createAdminClient()
  const { data: message, error: msgErr } = await supabase
    .from('messages')
    .select('id, venue_id, direction')
    .eq('id', messageId)
    .maybeSingle()
  if (msgErr) {
    return NextResponse.json(
      { error: 'message lookup failed', detail: msgErr.message },
      { status: 500 },
    )
  }
  if (!message) {
    return NextResponse.json({ error: 'message not found' }, { status: 404 })
  }
  if (message.direction !== 'outbound') {
    return NextResponse.json(
      { error: 'reviews are only valid on outbound messages' },
      { status: 400 },
    )
  }
  // Empty allowedVenueIds means analog admin sees every venue (matches the
  // page-level allowlist treatment in conversations/page.tsx).
  if (allowedVenueIds.length > 0 && !allowedVenueIds.includes(message.venue_id)) {
    return NextResponse.json({ error: 'venue not allowed' }, { status: 403 })
  }

  // expectedFailure short-circuits ingestion. Mirrors the 08-flow's
  // expected_failure: REASON comment encoding — JSONB still stamped (we
  // looked at this, here's why it's an acceptable failure) but
  // corpus/antipattern aren't touched. Truthy check covers both undefined
  // and empty-string cases — empty string is treated as "not flagged."
  const ingestSuppressed = !!body.expectedFailure?.trim()

  // ---- 1. corpus replace (when editedMessage present) ----
  const editedMessage = body.editedMessage?.trim()
  if (!ingestSuppressed && editedMessage !== undefined && editedMessage.length > 0) {
    const sourceRef = `cc-review:${messageId}`
    const result = await upsertCorpusEdit(
      {
        venueId: message.venue_id,
        sourceRef,
        editedMessage,
        // Tags: ['cc_review', category?]. category is optional now —
        // when missing, corpus row carries channel marker only.
        tags: ['cc_review', ...(body.category ? [body.category] : [])],
      },
      'replace',
    )
    if (!result.ok) {
      const status = result.errorCode === 'embed_failed' ? 502 : 500
      return NextResponse.json(
        {
          error: 'voice corpus write failed',
          detail: result.error,
          errorCode: result.errorCode,
        },
        { status },
      )
    }
  }

  // ---- 2. anti-pattern dedupe-append (when rule present) ----
  const rule = body.rule?.trim()
  if (!ingestSuppressed && rule !== undefined && rule.length > 0) {
    try {
      await dedupeAndAppendAntiPatterns(message.venue_id, [rule], {
        source: 'manual',
        authorOperatorId: operatorId,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return NextResponse.json(
        { error: 'anti-pattern append failed', detail: errMsg },
        { status: 500 },
      )
    }
  }

  // ---- 3. stamp messages.response_review JSONB (LAST) ----
  // corpusSourceRef is NOT stored — derivable from messageId when
  // editedMessage is present (cc-review:{messageId}).
  const review: MessageReview = {
    schemaVersion: MESSAGE_REVIEW_SCHEMA_VERSION,
    reviewedBy: operatorId,
    // TAC-258: stamp the channel explicitly so the mobile-operator path
    // (reviewedVia='mobile_operator') and cc-review path are distinguishable
    // at read time. Legacy rows without this field default to 'cc_review'
    // via getReviewedVia(); going forward we write it.
    reviewedVia: 'cc_review',
    reviewedAt: new Date().toISOString(),
    ...(body.category !== undefined ? { category: body.category } : {}),
    ...(body.editedMessage !== undefined ? { editedMessage: body.editedMessage } : {}),
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
    ...(body.rule !== undefined ? { rule: body.rule } : {}),
    ...(body.expectedFailure !== undefined ? { expectedFailure: body.expectedFailure } : {}),
  }
  const reviewJson = JSON.parse(JSON.stringify(review)) as Json
  const { error: stampErr } = await supabase
    .from('messages')
    .update({ response_review: reviewJson })
    .eq('id', messageId)
  if (stampErr) {
    return NextResponse.json(
      { error: 'review stamp failed', detail: stampErr.message },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, review })
}
