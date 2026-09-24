import { NextResponse } from 'next/server'
import { z } from 'zod'
import { handleFollowup } from '@/lib/agent'
import { resolveConversationChannel } from '@/lib/agent/conversation-channel'
import { loadLastInboundChannel } from '@/lib/agent/last-inbound-channel'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import { allowsVenue, type VenueScope } from '@/lib/auth/venue-scope'

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
//   2. Allowlist: venueId must be within the operator's venue scope.
//   3. Venue + messaging_phone_number: surface misconfiguration as a clean
//      400 here instead of letting the pipeline 502 from a deeper failure
//      when scheduleAndSend has nothing to dial. Checked only for a text
//      conversation (TAC-469): an Instagram guest is refused before it.
//   4. Opt-out: the agent pipeline doesn't pre-send-check
//      guests.opted_out_at — we add that here so the manual button can't
//      be the path that violates it. (THE-todo: hoist into the pipeline
//      itself once a regular sender has the same need.)
//
// Rate limiting: previously a 5-min cap on prior category='manual' outbounds
// per venue+guest. Removed — demo / dry-run flows need to fire the button
// repeatedly without waiting. In-flight disable on the client is the v1
// idempotency stance; revisit if abuse becomes a real concern.
//
// On approval, invokes handleFollowup synchronously with
// skipHumanFeelDelay=true so the operator gets a real result (sent /
// refused / failed) without the typing-indicator theatre. Returns 200 with
// the outbound message id on success.
//
// TAC-421 removed the pre-send sleeps, so this no longer saves the operator
// any wall-clock time; it suppresses the read receipt and typing beats,
// which is what a manual outbound wants regardless.

const MAX_HINT_LENGTH = 500

// TAC-394: what the operator sees when the pipeline refused to overwrite a card.
// Total over the drop reasons, so a new one fails tsc here until it has words.
const DROPPED_DETAIL: Record<
  Extract<Awaited<ReturnType<typeof handleFollowup>>, { status: 'dropped' }>['reason'],
  string
> = {
  slot_occupied:
    'A card for this guest is already waiting. Approve, edit or skip it, then send the follow-up.',
  obligation_slot_taken:
    'This guest already has a card waiting with a different offer. Decide that card first.',
  knowledge_gap_card_protected: "A pending question is holding this guest's review slot.",
}

const BodySchema = z.object({
  venueId: z.string().uuid(),
  guestId: z.string().uuid(),
  hint: z.string().max(MAX_HINT_LENGTH).nullable(),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  // ---- auth ----
  let venueScope: VenueScope
  try {
    const supabaseSession = await createServerClient()
    const {
      data: { session },
    } = await supabaseSession.auth.getSession()
    if (!session) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const op = await verifyAnalogAdminAccess(session.user.id)
    venueScope = op.venueScope
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
  // A fleet-wide scope means analog admin sees every venue. A granted list
  // means we must validate. Matches the page-level allowlist treatment.
  if (!allowsVenue(venueScope, body.venueId)) {
    return NextResponse.json({ error: 'venue not allowed' }, { status: 403 })
  }

  const supabase = createAdminClient()

  // ---- venue + messaging_phone_number ----
  // Surface a misconfigured venue (no Sendblue number assigned) as a clean
  // 400 here. Without this guard the pipeline still reaches scheduleAndSend
  // and fails deep in the send stage with a less actionable error.
  const { data: venueRow, error: venueErr } = await supabase
    .from('venues')
    .select('id, messaging_phone_number')
    .eq('id', body.venueId)
    .maybeSingle()
  if (venueErr) {
    return NextResponse.json(
      { error: 'venue lookup failed', detail: venueErr.message },
      { status: 500 },
    )
  }
  if (!venueRow) {
    return NextResponse.json({ error: 'venue not found' }, { status: 404 })
  }

  // ---- opt-out check ----
  // The agent pipeline doesn't currently pre-send-check opted_out_at; we
  // do it here so the manual button can't be the path that violates it.
  // Also doubles as a guest-existence + venue-mismatch check (returns
  // null if the guest isn't at this venue).
  const { data: guestRow, error: guestErr } = await supabase
    .from('guests')
    .select('id, opted_out_at, phone_number, instagram_scoped_id')
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
  // TAC-469 rule 2: a follow-up is never sent automatically on Instagram.
  // Decided by the conversation's channel, from the same resolver the agent
  // uses (a guest with both identifiers is on the channel they last wrote on),
  // so this button and handleFollowup can't disagree. handleFollowup refuses it
  // too; refusing here saves the generation and gives the operator a reason.
  const hasPhone = typeof guestRow.phone_number === 'string'
  const hasInstagramId = typeof guestRow.instagram_scoped_id === 'string'
  const { channel } = resolveConversationChannel({
    inboundChannel: undefined,
    hasPhone,
    hasInstagramId,
    lastInboundChannel:
      hasPhone && hasInstagramId ? await loadLastInboundChannel(body.venueId, body.guestId, supabase) : undefined,
  })
  if (channel !== 'text') {
    return NextResponse.json(
      {
        error: 'not a text conversation',
        detail:
          channel === 'instagram'
            ? "This guest is on Instagram. Follow-ups aren't sent there automatically: Instagram only allows a reply within 24 hours of the guest's last message."
            : "This guest's channel can't be determined, so nothing can be sent.",
      },
      { status: 400 },
    )
  }
  if (!venueRow.messaging_phone_number) {
    return NextResponse.json(
      {
        error: 'venue not configured',
        detail: 'venue has no messaging_phone_number; assign a Sendblue number before sending',
      },
      { status: 400 },
    )
  }

  // ---- invoke pipeline ----
  // skipHumanFeelDelay=true to suppress the typing-indicator theatre on an
  // outbound the operator explicitly asked for. Hint travels as
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
  // TAC-307: reachable as of this ticket. Manual followups used to bypass the
  // approval gate, so 'queued' could never come back here and the tail below
  // relabelled anything unrecognised as a duplicate. Now any approval trigger
  // — a fidelity band, a comp regex hit, an explicit venue policy hold — can
  // queue an operator-initiated followup, and that is a SUCCESS: the draft
  // exists and is waiting for review, it just hasn't been sent.
  if (result.status === 'queued') {
    return NextResponse.json({
      success: true,
      queued: true,
      messageId: result.outboundMessageId,
      primaryTrigger: result.primaryTrigger,
    })
  }
  if (result.status === 'failed') {
    return NextResponse.json(
      { error: 'pipeline failed', stage: result.stage, detail: result.error },
      { status: 502 },
    )
  }
  // TAC-308 widened AgentResult with 'dropped'. Reachable from here as of
  // TAC-307 (manual followups run the approval gate now). Named explicitly so
  // this tail can't silently relabel it, or any future member, as a duplicate.
  //
  // TAC-394: a manual followup never overwrites a pending card. When it would
  // queue into a slot a card already holds it is refused, and the operator who
  // clicked is told why in plain words rather than left to guess.
  if (result.status === 'dropped') {
    return NextResponse.json(
      {
        error: 'dropped',
        reason: result.reason,
        detail: DROPPED_DETAIL[result.reason],
      },
      { status: 409 },
    )
  }
  // TAC-397 widened AgentResult with 'silenced'. Named here for the reason the
  // branch above gives: this tail relabels anything unrecognised as a
  // duplicate, and a member added later would inherit that silently.
  //
  // Structurally unreachable on this path — a manual followup has no guest
  // message, so its disposition is null and it is never silenced — which is
  // exactly why it needs naming rather than testing: nothing would fail if it
  // became reachable and started reporting "duplicate".
  if (result.status === 'silenced') {
    return NextResponse.json(
      {
        error: 'silenced',
        detail: 'the pipeline decided this turn needed no reply; nothing was written',
      },
      { status: 409 },
    )
  }
  // TAC-529 widened AgentResult with 'venue_halted'. Named here for the reason
  // the two branches above give: this tail relabels anything unrecognised as a
  // duplicate, and a member added later would inherit that silently.
  //
  // Structurally unreachable on this path — only handleInbound produces it,
  // and this route calls handleFollowup — which is precisely why it is named
  // rather than tested. Note the BEHAVIOUR here is unchanged and deliberate:
  // this button is the one outbound path TAC-529 leaves ungated, so an
  // operator can still fire a manual follow-up at a paused venue. If that is
  // ever gated, the gate goes in handleFollowup and this branch becomes live.
  if (result.status === 'venue_halted') {
    return NextResponse.json(
      {
        error: 'venue_halted',
        detail: `the venue's status is "${result.venueStatus}", so the agent did not send`,
      },
      { status: 409 },
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
