// TAC-473: the operator gets one push when a held Instagram draft has an hour
// left in its reply window.
//
// WHY. An Instagram card can only be sent while Meta's 24-hour window is open.
// After that the only way to answer is to type it in the Instagram app by hand
// (TAC-486). A card sitting in the queue with 40 minutes left is the last
// moment a tap can still do the easy thing, and nothing else surfaces it: the
// card carries no timer of its own and the draft-flagged push already fired
// when it queued, hours earlier.
//
// Third push surface, after the draft-flagged one (TAC-207) and the
// commitment-arrival one (TAC-297). It uses ./recipients rather than a third
// copy of loadRecipients and the badge count — the extraction this ticket did
// first, for exactly this reason.
//
// Badge: countOperatorBadge, the drafts-plus-commitments count, not the
// drafts-only one send.ts uses. A badge that ignores commitments under-reports
// what is waiting. See the note in ./recipients about the two disagreeing.
//
// PRIVACY: the payload carries no message body and no guest handle. Title, a
// first name, the time left, and ids. Same invariant as the other two surfaces
// and asserted in the tests.

import { capturePushSent, capturePushTokenInvalid } from '@/lib/analytics/posthog'

import { sendApnsRequest } from './apns/client'
import { clearOperatorPushToken, countOperatorBadge, loadPushRecipients } from './recipients'

const APNS_TOKEN_INVALID_STATUS = 410
const APNS_BAD_DEVICE_TOKEN_STATUS = 400

/** Longest an APNs alert body should be before the notification centre elides it. */
const MAX_PUSH_BODY_CHARS = 110

export interface SendInstagramWindowWarningPushInput {
  draftId: string
  venueId: string
  guestId: string
  guestFirstName: string | null
  /** Milliseconds until Meta closes the window, at the moment of the claim. */
  remainingMs: number
}

/**
 * "Ana has 42m left to reply on Instagram" — who, and how long.
 *
 * Minutes rather than a clock time, because the operator is deciding whether to
 * act NOW, and a deadline in the venue's timezone is one more conversion to do
 * on a lock screen. Rounded DOWN, so the number never promises more time than
 * there is.
 *
 * No em dash: this is read fast on a phone mid-shift, the same rule
 * REVIEW_REASON_LABELS follows.
 */
export function buildInstagramWindowPushBody(
  guestFirstName: string | null,
  remainingMs: number,
): string {
  const minutes = Math.max(0, Math.floor(remainingMs / 60_000))
  const left = minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`
  const suffix = ` has ${left} left to reply on Instagram`
  const name = (guestFirstName ?? '').trim()
  if (name.length === 0) return `A guest${suffix}`
  const full = `${name}${suffix}`
  if (full.length <= MAX_PUSH_BODY_CHARS) return full
  const maxNameChars = Math.max(1, MAX_PUSH_BODY_CHARS - suffix.length)
  return `${name.slice(0, maxNameChars).trim()}${suffix}`
}

/**
 * Fan the warning out to every operator allowlisted for the venue. Never
 * throws: it runs inside a cron tick, and one push failure must not stop the
 * remaining cards being processed.
 *
 * The CALLER must already have won the CAS claim on
 * `messages.window_warning_pushed_at`. This does not re-check it, exactly as
 * sendCommitmentArrivalPush trusts transitionToPendingAck's rowcount. Calling
 * it without a claim means a duplicate push.
 */
export async function sendInstagramWindowWarningPush(
  input: SendInstagramWindowWarningPushInput,
): Promise<void> {
  const baseFields = {
    draftId: input.draftId,
    venueId: input.venueId,
    guestId: input.guestId,
  }
  try {
    const recipients = await loadPushRecipients(input.venueId, {
      logPrefix: '[apns] instagram window loadRecipients',
    })
    if (recipients.length === 0) return

    const body = buildInstagramWindowPushBody(input.guestFirstName, input.remainingMs)

    for (const recipient of recipients) {
      const badge = await countOperatorBadge(recipient.id)
      const result = await sendApnsRequest({
        deviceToken: recipient.apnsDeviceToken,
        body: {
          aps: {
            alert: { title: 'Instagram window closing', body },
            badge,
            sound: 'default',
          },
          draftId: input.draftId,
          guestId: input.guestId,
          operatorId: recipient.id,
        },
      })

      if (!result.ok) {
        console.error('[apns] instagram window send failed (transport)', {
          ...baseFields,
          operatorId: recipient.id,
          error: result.error,
          detail: result.detail,
        })
        await capturePushSent({
          agentRunId: null,
          venueId: input.venueId,
          guestId: input.guestId,
          operatorId: recipient.id,
          draftId: input.draftId,
          primaryTrigger: 'instagram_window_warning',
          ok: false,
          status: null,
          error: result.error,
          errorDetail: result.detail,
          badge,
          surface: 'instagram_window_warning',
        })
        continue
      }

      const { status, reason, apnsId } = result.response
      const tokenInvalid =
        status === APNS_TOKEN_INVALID_STATUS ||
        (status === APNS_BAD_DEVICE_TOKEN_STATUS && reason === 'BadDeviceToken')

      // ONE unconditional line per response, success included, symmetric with
      // the other two surfaces. Asymmetric logging across them makes a UAT run
      // ambiguous about which one actually fired.
      const responseFields = {
        ...baseFields,
        operatorId: recipient.id,
        badge,
        status,
        reason: reason ?? null,
        apnsId: apnsId ?? null,
        tokenInvalid,
      }
      if (status === 200) {
        console.log('[apns] instagram window apns response', responseFields)
      } else {
        console.warn('[apns] instagram window apns response', responseFields)
      }

      if (tokenInvalid) {
        await clearOperatorPushToken(recipient.id, {
          logPrefix: '[apns] instagram window nullOperatorToken failed',
        })
        await capturePushTokenInvalid({
          agentRunId: null,
          venueId: input.venueId,
          guestId: input.guestId,
          operatorId: recipient.id,
          draftId: input.draftId,
          primaryTrigger: 'instagram_window_warning',
          status,
          reason,
          surface: 'instagram_window_warning',
        })
      }

      await capturePushSent({
        agentRunId: null,
        venueId: input.venueId,
        guestId: input.guestId,
        operatorId: recipient.id,
        draftId: input.draftId,
        primaryTrigger: 'instagram_window_warning',
        ok: status === 200,
        status,
        error: status === 200 ? null : 'apns_status_non_200',
        errorDetail: reason ?? null,
        badge,
        surface: 'instagram_window_warning',
      })
    }
  } catch (err) {
    console.error('[apns] instagram window push failed', {
      ...baseFields,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
