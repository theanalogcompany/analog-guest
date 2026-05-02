import { NextResponse } from 'next/server'
import { z } from 'zod'
import { handleFollowup } from '@/lib/agent'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'

// POST /admin/conversations/api/follow-up — operator-initiated manual outbound
// from the Command Center conversations surface. Colocated under /admin/* so
// it passes the host-gating middleware on admin.theanalog.company (which 404s
// non-/admin paths on that host). Mirrors the trace fetch route's location.
//
// Activates the dormant handleFollowup scaffolding
// (FollowupTrigger.reason='manual'), with a small targeted set of guards that
// don't exist in the agent pipeline today:
//
//   1. Auth: cookie-session resolved to an analog admin operator.
//   2. Allowlist: venueId must be in the operator's allowedVenueIds.
//   3. Opt-out: the agent pipeline doesn't pre-send-check
//      guests.opted_out_at — we add that here so the manual button can't
//      be the path that violates it. (THE-todo: hoist into the pipeline
//      itself once a regular sender has the same need.)
//   4. Rate limit: at most one manual outbound per venue+guest per
//      RATE_LIMIT_WINDOW_MINUTES. Cheap, no Redis — looks at messages
//      table for a recent category='manual' outbound row.
//
// On approval, invokes handleFollowup synchronously with
// skipHumanFeelDelay=true so the operator gets a real result (sent /
// refused / failed) within ~5s instead of waiting through the typing-
// indicator theatre. Returns 200 with the outbound message id on success.

const RATE_LIMIT_WINDOW_MINUTES = 5
const MAX_HINT_LENGTH = 500

const BodySchema = z.object({
  venueId: z.string().uuid(),
  guestId: z.string().uuid(),
  hint: z.string().max(MAX_HINT_LENGTH).nullable(),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  // ---- auth ----
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
    allowedVenueIds = op.allowedVenueIds
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: 'auth check failed' }, { status: 500 })
  }

  // ---- body ----
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

  // ---- venue allowlist ----
  // Empty allowedVenueIds means analog admin sees every venue. Non-empty
  // means we must validate. Matches the page-level allowlist treatment.
  if (allowedVenueIds.length > 0 && !allowedVenueIds.includes(body.venueId)) {
    return NextResponse.json({ error: 'venue not allowed' }, { status: 403 })
  }

  const supabase = createAdminClient()

  // ---- opt-out check ----
  // The agent pipeline doesn't currently pre-send-check opted_out_at; we
  // do it here so the manual button can't be the path that violates it.
  // Also doubles as a guest-existence + venue-mismatch check (returns
  // null if the guest isn't at this venue).
  const { data: guestRow, error: guestErr } = await supabase
    .from('guests')
    .select('id, opted_out_at')
    .eq('id', body.guestId)
    .eq('venue_id', body.venueId)
    .maybeSingle()
  if (guestErr) {
    return NextResponse.json(
      { error: 'guest lookup failed', detail: guestErr.message },
      { status: 500 },
    )
  }
  if (!guestRow) {
    return NextResponse.json({ error: 'guest not found at venue' }, { status: 404 })
  }
  if (guestRow.opted_out_at !== null) {
    return NextResponse.json({ error: 'guest opted out' }, { status: 403 })
  }

  // ---- rate limit ----
  const cutoffIso = new Date(
    Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  ).toISOString()
  const { count: recentManualCount, error: rateErr } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', body.venueId)
    .eq('guest_id', body.guestId)
    .eq('direction', 'outbound')
    .eq('category', 'manual')
    .gte('created_at', cutoffIso)
  if (rateErr) {
    return NextResponse.json(
      { error: 'rate limit check failed', detail: rateErr.message },
      { status: 500 },
    )
  }
  if ((recentManualCount ?? 0) > 0) {
    return NextResponse.json(
      {
        error: 'rate limited',
        detail: `at most one manual follow-up per guest per ${RATE_LIMIT_WINDOW_MINUTES} minutes`,
      },
      { status: 429 },
    )
  }

  // ---- invoke pipeline ----
  // skipHumanFeelDelay=true so the operator gets a fast result instead of
  // waiting through the typing-indicator theatre. Hint travels as
  // FollowupTrigger.metadata; stages.ts buildAiRuntime renders it cleanly
  // for manual triggers.
  const result = await handleFollowup({
    venueId: body.venueId,
    guestId: body.guestId,
    trigger: {
      reason: 'manual',
      triggeredAt: new Date(),
      metadata: body.hint ? { hint: body.hint } : undefined,
    },
    skipHumanFeelDelay: true,
  })

  if (result.status === 'sent') {
    return NextResponse.json({ success: true, messageId: result.outboundMessageId })
  }
  if (result.status === 'refused') {
    return NextResponse.json(
      {
        error: 'refused',
        detail: 'voice fidelity below send floor; operator can retry',
        attemptScores: result.attemptScores,
      },
      { status: 422 },
    )
  }
  if (result.status === 'failed') {
    return NextResponse.json(
      { error: 'pipeline failed', stage: result.stage, detail: result.error },
      { status: 502 },
    )
  }
  // skipped_duplicate — handleFollowup doesn't currently produce this for the
  // manual path (the duplicate guard lives in handleInbound's idempotency
  // check), but AgentResult permits it. Treat as a benign no-op rather than
  // a 502 so the operator UI doesn't surface a false alarm.
  return NextResponse.json(
    { error: 'duplicate', detail: 'pipeline reported skipped_duplicate' },
    { status: 409 },
  )
}
