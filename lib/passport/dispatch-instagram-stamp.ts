// TAC-586: send a stamp's two images to the guest on Instagram, and record
// them as outbound rows the operator thread shows.
//
// One of the modules allowed to import the Instagram send path (see
// lib/messaging/instagram/CLAUDE.md, "Outbound").
//
// IN ORDER, AND THE ORDER IS A RULE: the stamp, then the passport. If the
// stamp image does not go, the passport is not sent: a page with a new stamp
// on it and no stamp before it reads as a glitch.
//
// FOR EACH IMAGE:
//   1. The 24-hour window, re-derived from the guest's inbound rows right
//      before the send, exactly as every other Instagram send does. A scan's
//      own row opens it. Unreadable or closed: no send.
//   2. A signed link to the private bucket, one hour: Meta fetches it once
//      and keeps its own copy, so the link is never stored anywhere of ours.
//   3. The send. A failure Meta has told us it did NOT deliver, and that may
//      not happen again (a rate limit, a Graph 4xx), is retried up to 2 more
//      times with 2 s then 6 s between (ruled 2026-10-14; in the run only, no
//      cron). A failure that will fail the same way again is not retried: a
//      closed window, a rejected token, a guest who blocked the account, a
//      link Meta would refuse.
//   4. AN AMBIGUOUS FAILURE IS NEVER SENT AGAIN. A timeout, a network failure,
//      a 200 we could not read and a Meta 5xx are failures where Meta may
//      have delivered anyway. Resending one risks the guest seeing the same
//      image twice, and the first copy's echo would then match nothing of
//      ours and sit with no `generated_by`, read by every "has the venue
//      spoken" check as staff having replied - the thing system rows exist to
//      prevent. No other Instagram sender in this repo resends an unknown
//      outcome either. Instead it waits for Meta's echo (2 s, then 6 s more):
//      an outbound Instagram row for this guest, with no `generated_by`, with
//      media, written since the attempt began. Found, the image arrived and
//      that row is adopted. Not found, the stamp stops here as undelivered.
//      What the echo check cannot rule out: a photo staff send by hand to the
//      same guest in those same eight seconds would be adopted as ours.
//   5. The row, through the agent's own `insertOrReconcileEcho`, so an echo
//      that beat our insert is filled in rather than duplicated. It is marked
//      `generated_by = 'system'` (lib/messaging/system-rows.ts): a stamp
//      image is never read as the venue answering anything. Both images share
//      one `generation_id`, so a scan's images are one response, not two.
//   6. The attachment row, ONLY when our insert created the message row. An
//      echo that got there first wrote its own attachment row (and re-host is
//      copying it); a second would show the image twice in the thread.
//
// NOT `recordProactiveSend`, deliberately. The scan greeting stands down for
// 60 minutes after a proactive send, so recording one here would silence the
// greeting that is due twenty seconds after the scan.
//
// Never throws: the whole run is inside one try/catch, reported as `stage:
// 'unexpected'` with what had been delivered by then.

import { randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { insertOrReconcileEcho } from '@/lib/agent/dispatch-instagram-reply'
import { GUEST_MEDIA_BUCKET } from '@/lib/messaging/attachments/rehost'
import {
  sendInstagramImage,
  type InstagramImageSendFailureKind,
  type InstagramImageSendResult,
} from '@/lib/messaging/instagram/send'
import { loadInstagramSendTarget } from '@/lib/messaging/instagram/send-target'
import {
  instagramWindowState,
  loadLastGuestActionAt,
} from '@/lib/messaging/instagram/window'
import { SYSTEM_GENERATED_BY } from '@/lib/messaging/system-rows'

import type { PassportImage } from './paths'
import { sendWithRetry } from './send-retry'

type AdminSupabaseClient = SupabaseClient<Database>
type MessageInsert = Database['public']['Tables']['messages']['Insert']

/** Meta's fetch takes seconds; an hour is ample and soon dead if leaked. */
export const PASSPORT_SIGNED_URL_TTL_SECONDS = 3600
export type PassportDispatchStage =
  | 'target'
  | 'window'
  | 'sign'
  | 'send_stamp'
  | 'send_spread'
  | 'save'
  | 'unexpected'

export type PassportDispatchResult =
  | { ok: true; attempts: number }
  | {
      ok: false
      stage: PassportDispatchStage
      kind: InstagramImageSendFailureKind | null
      error: string | null
      attempts: number
      /** How many of the two images reached the guest before it stopped. */
      delivered: number
    }

export type PassportDispatchImage = {
  image: PassportImage
  path: string
  byteSize: number
}

export type PassportDispatchDeps = {
  sendImage: (input: {
    accountId: string
    recipientId: string
    imageUrl: string
    token: string
  }) => Promise<InstagramImageSendResult>
  now: () => Date
  sleep: (ms: number) => Promise<void>
}

const DEFAULT_DEPS: PassportDispatchDeps = {
  sendImage: (input) => sendInstagramImage({ ...input, fetchImpl: fetch }),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Meta's echo of an image we may have sent: the oldest outbound Instagram row
 * for this guest written since `since`, with no `generated_by` (an echo's
 * mark) and with media. Its mid is what lets `insertOrReconcileEcho` adopt it.
 */
async function findImageEchoSince(
  supabase: AdminSupabaseClient,
  scope: { venueId: string; guestId: string },
  since: Date,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('provider_message_id, media_urls')
      .eq('venue_id', scope.venueId)
      .eq('guest_id', scope.guestId)
      .eq('direction', 'outbound')
      .eq('channel', 'instagram')
      .is('generated_by', null)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true })
      .limit(5)
    if (error) return null
    // With media: a text staff typed in the same seconds is not our image.
    const echo = (data ?? []).find((row) => (row.media_urls ?? []).length > 0)
    return echo?.provider_message_id ?? null
  } catch {
    return null
  }
}

function outboundRow(input: {
  venueId: string
  guestId: string
  mid: string
  path: string
  generationId: string
  sentAt: Date
}): MessageInsert {
  return {
    venue_id: input.venueId,
    guest_id: input.guestId,
    direction: 'outbound',
    // Migration 048 defaults the column to 'text'; every Instagram writer
    // names it (lib/messaging/instagram/CLAUDE.md).
    channel: 'instagram',
    status: 'sent',
    review_state: 'auto_sent',
    generated_by: SYSTEM_GENERATED_BY,
    // No words: the image is the message. `media_urls` holds where the image
    // lives in our bucket, which satisfies messages_has_content. NOT the
    // signed link that was sent: that is a credential for an hour and dead
    // after it. The operator thread reads the attachment row, not this.
    body: '',
    media_urls: [`${GUEST_MEDIA_BUCKET}/${input.path}`],
    provider_message_id: input.mid,
    generation_id: input.generationId,
    sent_at: input.sentAt.toISOString(),
  }
}

async function insertAttachmentRow(
  supabase: AdminSupabaseClient,
  input: {
    messageId: string
    venueId: string
    guestId: string
    path: string
    byteSize: number
  },
): Promise<string | null> {
  try {
    const { error } = await supabase.from('message_attachments').insert({
      message_id: input.messageId,
      venue_id: input.venueId,
      guest_id: input.guestId,
      position: 0,
      kind: 'image',
      status: 'ready',
      provider_type: 'image',
      storage_path: input.path,
      mime_type: 'image/png',
      byte_size: input.byteSize,
    })
    return error ? error.message : null
  } catch (e) {
    return message(e)
  }
}

export async function sendPassportImages(
  supabase: AdminSupabaseClient,
  input: {
    venueId: string
    guestId: string
    images: readonly [PassportDispatchImage, PassportDispatchImage]
  },
  deps: PassportDispatchDeps = DEFAULT_DEPS,
): Promise<PassportDispatchResult> {
  const scope = { venueId: input.venueId, guestId: input.guestId }
  let attempts = 0
  let delivered = 0
  const stopped = (
    stage: PassportDispatchStage,
    kind: InstagramImageSendFailureKind | null,
    error: string | null,
  ): PassportDispatchResult => ({
    ok: false,
    stage,
    kind,
    error,
    attempts,
    delivered,
  })

  try {
    const target = await loadInstagramSendTarget(supabase, scope)
    if (!target.ok) return stopped('target', null, target.problem)

    const generationId = randomUUID()

    for (const image of input.images) {
      const lastAction = await loadLastGuestActionAt(
        supabase,
        input.venueId,
        input.guestId,
      )
      if (!lastAction.ok) return stopped('window', null, lastAction.error)
      const window = instagramWindowState(lastAction.value, deps.now())
      if (!window.open) return stopped('window', 'window_closed', window.reason)

      const signed = await supabase.storage
        .from(GUEST_MEDIA_BUCKET)
        .createSignedUrl(image.path, PASSPORT_SIGNED_URL_TTL_SECONDS)
      if (signed.error || !signed.data)
        return stopped('sign', null, signed.error?.message ?? 'no signed url')
      const imageUrl = signed.data.signedUrl

      const sent = await sendWithRetry({
        send: () =>
          deps.sendImage({
            accountId: target.target.accountId,
            recipientId: target.target.recipientId,
            imageUrl,
            token: target.target.token,
          }),
        findEchoSince: (since) => findImageEchoSince(supabase, scope, since),
        sleep: deps.sleep,
        now: deps.now,
        onAttempt: () => {
          attempts += 1
        },
      })
      if (!sent.ok)
        return stopped(
          image.image === 'stamp' ? 'send_stamp' : 'send_spread',
          sent.kind,
          null,
        )
      delivered += 1

      const payload = outboundRow({
        ...scope,
        mid: sent.mid,
        path: image.path,
        generationId,
        sentAt: deps.now(),
      })
      // One retry: a row that never saves leaves Meta's echo as the only
      // record, with no `generated_by`, which reads as staff having replied.
      let saved = await insertOrReconcileEcho(supabase, payload)
      if (!saved.ok) saved = await insertOrReconcileEcho(supabase, payload)
      if (!saved.ok) return stopped('save', null, saved.error)

      if (!saved.reconciled) {
        const attachmentError = await insertAttachmentRow(supabase, {
          messageId: saved.id,
          ...scope,
          path: image.path,
          byteSize: image.byteSize,
        })
        if (attachmentError !== null) {
          // The guest has the image; only the operator thread is missing it.
          // Logged rather than stopping the passport image behind it.
          console.error('passport: attachment row not written', {
            event: 'passport_attachment_row_failed',
            venueId: input.venueId,
            guestId: input.guestId,
            messageId: saved.id,
            error: attachmentError,
          })
        }
      }
    }

    return { ok: true, attempts }
  } catch (e) {
    return stopped('unexpected', null, message(e))
  }
}
