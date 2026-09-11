import { findPendingDraft } from '@/lib/agent/stages'
import { createAdminClient } from '@/lib/db/admin'
import { findActiveCommitmentsForGuest } from '@/lib/guests/commitments'
import { diffGuardrailState, type GuardrailCounts } from './preflight-pure'

/**
 * TAC-347 Stage 2. Runtime guardrails per the human-authorized plan:
 *
 *   "At harness start, clear Sendblue and push credentials from the process
 *   environment, so any accidental send or push throws instead of
 *   delivering. Before and after the run, count messages rows,
 *   guest_commitments rows and any notification records for the venue. If
 *   any count changed, fail the run loudly."
 *
 * Expanded per the build-review round to also snapshot guest_states and
 * engagement_events — buildRuntimeContext calls computeGuestState inline,
 * which writes on a state TRANSITION. Those two tables legitimately write
 * once, sequentially, during seedSyntheticGuests (before the guardrail
 * snapshot is taken) — the harness expects zero delta across the grading
 * run itself, not zero writes ever. A delta there during grading is a real
 * bug (a synthetic guest's signals drifting mid-run), not a false alarm.
 *
 * "Any notification records": there's no dedicated notifications table in
 * this schema (APNs tokens live on operators, push delivery is logged to
 * PostHog only) — resolves to "N/A, no table to count," backed instead by
 * the import-boundary test (evaluate-approval-decision.test.ts) plus
 * credential-clearing below.
 */

export { diffGuardrailState, type GuardrailCounts }

const CREDENTIAL_ENV_VARS = [
  'SENDBLUE_API_KEY_ID',
  'SENDBLUE_API_SECRET_KEY',
  'SENDBLUE_SIGNING_SECRET',
  'APNS_AUTH_KEY',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'APNS_ENV',
] as const

/**
 * Deletes messaging/push credentials from process.env. Every consumer reads
 * lazily inside functions (lib/messaging/sendblue-client.ts,
 * lib/messaging/verify-webhook.ts, lib/notifications/apns/{jwt,client}.ts —
 * confirmed by reading each), so clearing at harness start reliably starves
 * any accidental call regardless of import order.
 *
 * Nuance (documented per the audit): per CLAUDE.md, internal functions treat
 * errors as values, so a credential-starved sendMessage/sendApnsRequest call
 * does NOT throw — it fails soft ({ok:false}, logged, swallowed), matching
 * production's fire-and-forget posture. This function's real guarantee is
 * "nothing is actually delivered," not "the harness crashes loudly." The
 * loud-failure signal for an accidental call comes from the import-boundary
 * test (evaluate-approval-decision.test.ts), which prevents the call from
 * existing at all — this is defense-in-depth on top of that, not a
 * standalone detector.
 */
export function clearMessagingCredentials(): void {
  for (const key of CREDENTIAL_ENV_VARS) {
    delete process.env[key]
  }
}

/** Row counts for the four tables any accidental write could touch, scoped to one venue. */
export async function countGuardrailState(venueId: string): Promise<GuardrailCounts> {
  const supabase = createAdminClient()
  const [messages, guestCommitments, guestStates, engagementEvents] = await Promise.all([
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('venue_id', venueId),
    supabase.from('guest_commitments').select('id', { count: 'exact', head: true }).eq('venue_id', venueId),
    supabase.from('guest_states').select('id', { count: 'exact', head: true }).eq('venue_id', venueId),
    supabase.from('engagement_events').select('id', { count: 'exact', head: true }).eq('venue_id', venueId),
  ])
  const labeled = [
    ['messages', messages],
    ['guest_commitments', guestCommitments],
    ['guest_states', guestStates],
    ['engagement_events', engagementEvents],
  ] as const
  for (const [label, res] of labeled) {
    if (res.error) throw new Error(`countGuardrailState: ${label} count failed: ${res.error.message}`)
  }
  return {
    messages: messages.count ?? 0,
    guestCommitments: guestCommitments.count ?? 0,
    guestStates: guestStates.count ?? 0,
    engagementEvents: engagementEvents.count ?? 0,
  }
}

export interface CleanStateHit {
  state: string
  phone: string
  guestId: string
  kind: 'pending_draft' | 'active_commitment'
  detail: string
}

/**
 * Clean-state preflight (owner constraint 3): "Before running, check the
 * venue's synthetic guests for pending drafts or open commitments. If any
 * exist, abort with a message listing them; never auto-delete."
 *
 * Runs once per venue-run, before any scenario executes — decision-only
 * invocation never persists, so nothing the harness itself does during
 * grading can create a new pending draft or commitment mid-run.
 */
export async function checkCleanState(
  venueId: string,
  guestIdsByState: Record<string, string>,
  phonesByState: Record<string, string>,
): Promise<CleanStateHit[]> {
  const hits: CleanStateHit[] = []
  for (const [state, guestId] of Object.entries(guestIdsByState)) {
    const pending = await findPendingDraft(venueId, guestId)
    if (pending) {
      hits.push({
        state,
        phone: phonesByState[state] ?? 'unknown',
        guestId,
        kind: 'pending_draft',
        detail: `message id=${pending.id}, review_reason=${pending.review_reason ?? 'null'}`,
      })
    }
    const commitments = await findActiveCommitmentsForGuest({ venueId, guestId })
    if (commitments.ok && commitments.data.length > 0) {
      hits.push({
        state,
        phone: phonesByState[state] ?? 'unknown',
        guestId,
        kind: 'active_commitment',
        detail: `${commitments.data.length} active commitment(s): ${commitments.data
          .map((c) => `${c.id} (${c.status})`)
          .join(', ')}`,
      })
    }
  }
  return hits
}
