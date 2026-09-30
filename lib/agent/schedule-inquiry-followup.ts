// TAC-386: arm a follow-up when the guest asks something our answer helps them
// do.
//
// Called fire-and-forget from handle-inbound.ts's `waitUntil`, beside
// extractReportedOrder and recordIntentionEligibility, and takes their posture
// exactly: it never throws into the reply path, and it logs its own outcome. A
// failure here costs a missed follow-up, never a broken reply.
//
// WHAT IT DOES NOT STORE: our answer. At this point in the turn the reply is
// still being generated, and a card an operator later edits would leave a stored
// copy claiming we said something we did not. The processor reads what actually
// went out, at dispatch (lib/followups/inquiry-followup-store.ts).
//
// THE EXCLUDED CATEGORIES ARE CHECKED HERE AS WELL AS IN THE PROMPT, and that
// redundancy is the point. The classifier is told to set followUpWorthy false
// for a complaint, a business inquiry or a crisis message, and the prompt has a
// test pinning each of those lines. But a prompt instruction is not a gate: a
// model that ignored it once would put a cheerful "did that work out?" three
// hours behind a guest reporting a stale muffin, and that is the worst output
// this mechanism can produce. So the categories are refused structurally, and
// the model's own judgment only ever narrows the set further.
//
// THE PER-VENUE KILL SWITCH IS NOT CHECKED HERE, on purpose. It lives on
// `followup_rules`, which this path does not load, and checking it at DISPATCH
// instead is the better behaviour anyway: switching it off stops sends
// immediately, including for questions already armed, which is what an operator
// reaching for a kill switch means.

import { createAdminClient } from '@/lib/db/admin'
import { INSTAGRAM_WINDOW_MS } from '@/lib/messaging/instagram/window'
import {
  computeInquiryFollowupDueAt,
  INQUIRY_FOLLOWUP_DELAY_HOURS,
} from '@/lib/followups/inquiry-followup-timing'
import type { MessageCategory } from '@/lib/ai/types'
import type { VenueInfo } from '@/lib/schemas'
import type { RuntimeContext } from './types'

/**
 * Exactly what arming a follow-up reads off the turn.
 *
 * A narrow structural type rather than the whole `RuntimeContext`, following
 * `VenueOpenStateInput`'s precedent: a caller holding only these can pass them,
 * and a test fixture does not have to build a venue, a persona and a corpus it
 * never reads. `RuntimeContext` satisfies it structurally, so handle-inbound
 * passes `ctx` unchanged.
 */
export interface ScheduleInquiryInput {
  classification: Pick<
    NonNullable<RuntimeContext['classification']>,
    'category' | 'crisisSafety' | 'followUpWorthy'
  > | null
  currentMessage: Pick<
    NonNullable<RuntimeContext['currentMessage']>,
    'id' | 'body'
  > | null
  conversationChannel: RuntimeContext['conversationChannel']
  venue: {
    id: string
    timezone: string
    venueInfo: Pick<VenueInfo, 'hours'>
  }
  guest: { id: string }
}

/**
 * Categories an inquiry follow-up never arms behind, whatever the classifier
 * said about `followUpWorthy`.
 *
 * A DENY-LIST rather than an allow-list on the qualifying categories, and the
 * direction matters: `followUpWorthy` is the signal, and a new category added
 * later should inherit "the model decides" rather than be silently excluded by a
 * list nobody revisited. What belongs here is only what must NEVER be followed
 * up regardless.
 */
const NEVER_FOLLOW_UP: ReadonlySet<MessageCategory> = new Set<MessageCategory>([
  // A human's job (ruled 2026-09-30). A check-in behind an unresolved complaint
  // reads as though nobody read it.
  'comp_complaint',
  // Where business, press, wholesale and hiring inquiries land. Held for an
  // operator anyway, so there is no answer of ours to check on.
  'manual',
  // They asked us to stop.
  'opt_out',
  // A sign-off is not an inquiry.
  'acknowledgment',
])

export type ScheduleInquiryOutcome =
  | { kind: 'armed'; dueAt: Date }
  | { kind: 'not_worthy' }
  | { kind: 'excluded'; reason: string }
  | { kind: 'skipped'; reason: 'hours_unreadable' | 'past_window' }
  | { kind: 'already_pending' }
  | { kind: 'failed'; error: string }

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505'

/**
 * Decide whether this inbound turn arms a follow-up, and write the row if so.
 *
 * Pure decisions first, then one insert. Never throws.
 */
export async function scheduleInquiryFollowup(
  ctx: ScheduleInquiryInput,
  supabase = createAdminClient(),
): Promise<ScheduleInquiryOutcome> {
  try {
    const classification = ctx.classification
    const message = ctx.currentMessage
    if (!classification || !message) {
      return { kind: 'excluded', reason: 'no_classified_inbound' }
    }

    if (!classification.followUpWorthy) return { kind: 'not_worthy' }

    // Structural, not advisory. See the module header.
    if (classification.crisisSafety) {
      return { kind: 'excluded', reason: 'crisis_safety' }
    }
    if (NEVER_FOLLOW_UP.has(classification.category)) {
      return { kind: 'excluded', reason: `category_${classification.category}` }
    }

    // Instagram only, ruled 2026-09-30. Arming a row for a text conversation
    // would build a queue of work handleFollowup refuses at dispatch.
    if (ctx.conversationChannel !== 'instagram') {
      return { kind: 'excluded', reason: 'not_instagram' }
    }

    const question = message.body.trim()
    if (question.length === 0) {
      // A photo with no text. classifyMessage refuses an empty body, so this
      // should be unreachable; it is checked because a row with an empty
      // `question` would render an empty quoted string into the prompt.
      return { kind: 'excluded', reason: 'empty_question' }
    }

    // META'S CLOCK, read from the row rather than taken off the context.
    // `InboundMessage` carries only `receivedAt`, which is when OUR webhook got
    // the event, and that is LATER than Meta's own timestamp: the two were 1.8s
    // and 2.3s apart in production and a redelivery can land far later
    // (TAC-479). Deriving the window close from the later of the two would put
    // it PAST the true close, which is the one direction that matters here, so
    // this reads `provider_sent_at` instead of inferring it.
    const askedAt = await loadMetaSentAt(supabase, message.id)
    if (askedAt === null) {
      // No Meta time on the row means every row before migration 049, or a
      // channel that has none. The window cannot be derived, so nothing is
      // armed. Same direction as unreadable hours.
      return { kind: 'excluded', reason: 'no_provider_sent_at' }
    }
    const windowClosesAt = new Date(askedAt.getTime() + INSTAGRAM_WINDOW_MS)

    const timing = computeInquiryFollowupDueAt({
      askedAt,
      timezone: ctx.venue.timezone,
      hours: ctx.venue.venueInfo.hours,
      delayHours: INQUIRY_FOLLOWUP_DELAY_HOURS,
      windowClosesAt,
    })
    if (timing.kind === 'skip') {
      // Ruling 4, extended to "never arm": no row is written, so there is
      // nothing that could later be found stale, and nothing holding the
      // guest's one pending slot.
      return { kind: 'skipped', reason: timing.reason }
    }

    const { error } = await supabase.from('inquiry_followups').insert({
      venue_id: ctx.venue.id,
      guest_id: ctx.guest.id,
      source_message_id: message.id,
      question,
      asked_at: askedAt.toISOString(),
      window_closes_at: windowClosesAt.toISOString(),
      due_at: timing.dueAt.toISOString(),
    })

    if (error) {
      // Either of migration 066's two unique indexes. Both are expected states
      // rather than faults: the per-message one means this turn has already been
      // armed (a retried webhook), and the per-guest-pending one means the guest
      // already has a question waiting, which is the one-at-a-time rule doing
      // its job. Ruled 2026-09-30: be selective, as a real host is.
      if (error.code === UNIQUE_VIOLATION) return { kind: 'already_pending' }
      return { kind: 'failed', error: error.message }
    }

    return { kind: 'armed', dueAt: timing.dueAt }
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * `messages.provider_sent_at` for one row, as a Date, or null.
 *
 * Null when the column is null (every row before migration 049) or unparseable.
 * The caller arms nothing in that case: a window it cannot derive is one it
 * cannot promise to stay inside.
 */
async function loadMetaSentAt(
  supabase: ReturnType<typeof createAdminClient>,
  messageId: string,
): Promise<Date | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('provider_sent_at')
    .eq('id', messageId)
    .maybeSingle()
  if (error || !data?.provider_sent_at) return null
  const at = new Date(data.provider_sent_at)
  return Number.isNaN(at.getTime()) ? null : at
}
