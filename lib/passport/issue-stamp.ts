// TAC-586: a bound scan gets a passport stamp. This is the whole run, from
// the bind to `sent_at`.
//
// CALLED FROM ONE PLACE: the Instagram webhook, on a `'bound'` result from
// reconcileScanCodeFromReferral, inside that bind's own `waitUntil`. Nothing
// else issues stamps (ruled 2026-10-14): a visit matched by card with no scan
// gets none, and a scan that arrives before Square has recorded the payment
// (`payment_not_ingested`) never reaches here.
//
// THE ORDER, and why each step sits where it does:
//   1. Load the venue, guest, purchase and prior stamps.
//   2. Gates, before anything is written: a paused venue, a venue with no
//      passport settings (fails CLOSED: no stamp beats one with the wrong
//      name), a guest who opted out (ruled: nothing sent, no stamp).
//   3. Decide the kind, place it, and INSERT. The insert is the claim
//      (migration 085): a second runner for the same purchase stops here as
//      `already_stamped`. A `conflict` (another purchase by the same guest
//      took this seq or slot first) re-reads and places again, three times.
//   4. Render both images, upload them, record their paths.
//   5. Send both (dispatch-instagram-stamp.ts), then set `sent_at`.
// A failure at 4 or 5 leaves the row with `sent_at` NULL and says where in one
// `event:` log line and one PostHog capture. Nothing retries it later.
//
// IT NEVER TOUCHES THE SCAN GREETING. The greeting is scheduled in its own
// `waitUntil` and reads none of what this writes: no scan-arrival row, no
// inbound row, no `last_proactive_send_at`, and the image rows are
// `generated_by = 'system'`, which every "has the venue spoken" reader skips
// (lib/messaging/system-rows.ts).
//
// Never throws: everything past the gates is inside one try/catch, so an
// escape becomes `stage: 'unexpected'` rather than an unhandled rejection in
// the webhook's background work.

import { randomInt } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import {
  capturePassportStampFailed,
  capturePassportStampIssued,
  capturePassportStampSkipped,
  type PassportStampSkipReason,
} from '@/lib/analytics/posthog'
import { GUEST_MEDIA_BUCKET } from '@/lib/messaging/attachments/rehost'
import { venueLocalDate } from '@/lib/schemas'
import { isVenueProcessingHalted } from '@/lib/venues/status'

import { decideStamp } from './decide'
import { sendPassportImages } from './dispatch-instagram-stamp'
import { stampFace } from './face'
import { pageForSeq, placeStamp, spreadForPage } from './layout'
import { passportImagePath } from './paths'
import { renderStamp } from './render/stamp'
import { renderSpread, type PlacedStamp } from './render/spread'
import {
  insertStamp,
  loadStampContext,
  markStampSent,
  recordImagePaths,
  type StampContext,
  type StoredStamp,
} from './store'

type AdminSupabaseClient = SupabaseClient<Database>

const MAX_PLACEMENT_ATTEMPTS = 3

export type IssueStampInput = {
  venueId: string
  guestId: string
  transactionId: string
  /** INVITED, when a perk unlocks on this visit. Nothing passes it yet. */
  perkUnlocked?: { perk: string }
}

export type IssueStampOutcome =
  | { status: 'issued'; stampId: string }
  | { status: 'skipped'; reason: PassportStampSkipReason }
  | { status: 'failed'; stage: string; stampId: string | null }

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function skip(
  input: IssueStampInput,
  reason: PassportStampSkipReason,
): Promise<IssueStampOutcome> {
  console.log('passport: no stamp', {
    event: 'passport_stamp_skipped',
    reason,
    venueId: input.venueId,
    guestId: input.guestId,
    transactionId: input.transactionId,
  })
  await capturePassportStampSkipped({ ...input, reason })
  return { status: 'skipped', reason }
}

async function fail(
  input: IssueStampInput,
  detail: {
    stage: string
    stampId: string | null
    kind?: string | null
    error: string | null
  },
): Promise<IssueStampOutcome> {
  console.error('passport: stamp not delivered', {
    event: 'passport_stamp_failed',
    stage: detail.stage,
    kind: detail.kind ?? null,
    venueId: input.venueId,
    guestId: input.guestId,
    transactionId: input.transactionId,
    stampId: detail.stampId,
    error: detail.error,
  })
  await capturePassportStampFailed({
    venueId: input.venueId,
    guestId: input.guestId,
    transactionId: input.transactionId,
    stampId: detail.stampId,
    stage: detail.stage,
    kind: detail.kind ?? null,
    error: detail.error,
  })
  return { status: 'failed', stage: detail.stage, stampId: detail.stampId }
}

function placed(
  guestId: string,
  stamp: StoredStamp,
  context: StampContext,
): PlacedStamp | null {
  const settings = context.venue.passport
  if (settings === null) return null
  const face = stampFace(stamp, settings)
  if (face === null) return null
  return {
    seq: stamp.seq,
    guestId,
    page: stamp.page,
    slot: stamp.slot,
    dx: stamp.dx,
    dy: stamp.dy,
    rotation: stamp.rotation,
    textureSeed: stamp.textureSeed,
    face,
  }
}

async function upload(
  supabase: AdminSupabaseClient,
  path: string,
  png: Buffer,
): Promise<string | null> {
  try {
    const { error } = await supabase.storage
      .from(GUEST_MEDIA_BUCKET)
      .upload(path, png, { contentType: 'image/png', upsert: false })
    return error ? error.message : null
  } catch (e) {
    return message(e)
  }
}

export async function issuePassportStamp(
  supabase: AdminSupabaseClient,
  input: IssueStampInput,
): Promise<IssueStampOutcome> {
  const startedMs = Date.now()
  let stampId: string | null = null
  try {
    // 1-3: load, gate, decide, place, claim.
    let context: StampContext | null = null
    let stamp: StoredStamp | null = null
    for (
      let attempt = 0;
      attempt < MAX_PLACEMENT_ATTEMPTS && stamp === null;
      attempt++
    ) {
      const loaded = await loadStampContext(supabase, input)
      if (!loaded.ok)
        return fail(input, { stage: 'load', stampId, error: loaded.error })
      context = loaded.data

      if (isVenueProcessingHalted(context.venue.status))
        return skip(input, 'venue_paused')
      // A venue holding every outbound for review gets no images sent without
      // one (decided at build time, flagged on TAC-586 for a ruling): the
      // holding message is suppressed under the same flag
      // (lib/agent/handle-holding-message.ts), and no stamp is the side to
      // err on. No venue has the flag set today.
      if (context.venue.holdAllOutbound)
        return skip(input, 'venue_holding_outbound')
      if (context.venue.passport === null)
        return skip(input, 'passport_not_configured')
      if (context.guest.optedOut) return skip(input, 'opted_out')

      const stampedOn = venueLocalDate(
        context.transaction.occurredAt,
        context.venue.timezone,
      )
      if (stampedOn === null)
        return fail(input, {
          stage: 'load',
          stampId,
          error: 'venue timezone unusable',
        })

      const decision = decideStamp({
        prior: context.prior.map((prior) => ({
          kind: prior.kind,
          label: prior.label,
          lineItemNames:
            prior.kind === 'arrived' ? context!.arrivedLineItemNames : [],
        })),
        lineItemNames: context.transaction.lineItemNames,
        ...(input.perkUnlocked !== undefined
          ? { perkUnlocked: input.perkUnlocked }
          : {}),
      })
      const seq = (context.prior.at(-1)?.seq ?? 0) + 1
      const textureSeed = randomInt(0, 2 ** 31 - 1)
      const page = pageForSeq(seq)
      const placement = placeStamp({
        guestId: input.guestId,
        seq,
        usedSlots: context.prior
          .filter((p) => p.page === page)
          .map((p) => p.slot),
        textureSeed,
      })
      if (placement === null)
        return fail(input, {
          stage: 'claim',
          stampId,
          error: `page ${page} has no free slot`,
        })

      const inserted = await insertStamp(supabase, {
        venue_id: input.venueId,
        guest_id: input.guestId,
        transaction_id: input.transactionId,
        seq,
        kind: decision.kind,
        label: decision.label,
        stamped_on: stampedOn,
        page: placement.page,
        slot: placement.slot,
        dx: placement.dx,
        dy: placement.dy,
        rotation: placement.rotation,
        texture_seed: textureSeed,
      })
      if (!inserted.ok)
        return fail(input, { stage: 'claim', stampId, error: inserted.error })
      if (inserted.data.status === 'already_stamped')
        return skip(input, 'already_stamped')
      if (inserted.data.status === 'conflict') continue
      stampId = inserted.data.id
      stamp = {
        id: inserted.data.id,
        seq,
        kind: decision.kind,
        label: decision.label,
        stampedOn,
        page: placement.page,
        slot: placement.slot,
        dx: placement.dx,
        dy: placement.dy,
        rotation: placement.rotation,
        textureSeed,
        transactionId: input.transactionId,
      }
    }
    if (stamp === null || context === null)
      return fail(input, {
        stage: 'claim',
        stampId,
        error: 'seq kept colliding',
      })

    // 4: render and upload.
    const settings = context.venue.passport
    const newest = placed(input.guestId, stamp, context)
    if (settings === null || newest === null)
      return fail(input, {
        stage: 'render',
        stampId,
        error: 'stamp face unbuildable',
      })
    const pages = spreadForPage(stamp.page)
    const onSpread: PlacedStamp[] = [newest]
    for (const prior of context.prior) {
      if (!pages.includes(prior.page)) continue
      const p = placed(input.guestId, prior, context)
      if (p === null)
        return fail(input, {
          stage: 'render',
          stampId,
          error: `prior stamp ${prior.id} unbuildable`,
        })
      onSpread.push(p)
    }
    const stampImage = await renderStamp(newest.face, {
      textureSeed: stamp.textureSeed,
      rotation: stamp.rotation,
    })
    if (!stampImage.ok)
      return fail(input, {
        stage: 'render',
        stampId,
        error: `${stampImage.stage}: ${stampImage.error}`,
      })
    const spreadImage = await renderSpread({
      pages,
      venueName: settings.venueName,
      background: settings.background,
      stamps: onSpread,
    })
    if (!spreadImage.ok)
      return fail(input, {
        stage: 'render',
        stampId,
        error: `${spreadImage.stage}: ${spreadImage.error}`,
      })

    const scope = {
      venueId: input.venueId,
      guestId: input.guestId,
      stampId: stamp.id,
    }
    const paths = {
      stamp: passportImagePath(scope, 'stamp'),
      spread: passportImagePath(scope, 'spread'),
    }
    for (const [path, png] of [
      [paths.stamp, stampImage.data.png],
      [paths.spread, spreadImage.data.png],
    ] as const) {
      const uploadError = await upload(supabase, path, png)
      if (uploadError !== null)
        return fail(input, { stage: 'upload', stampId, error: uploadError })
    }
    const rowScope = {
      id: stamp.id,
      venueId: input.venueId,
      guestId: input.guestId,
    }
    const recorded = await recordImagePaths(supabase, rowScope, paths)
    if (!recorded.ok)
      return fail(input, { stage: 'upload', stampId, error: recorded.error })

    // 5: send, then mark.
    const sent = await sendPassportImages(supabase, {
      venueId: input.venueId,
      guestId: input.guestId,
      images: [
        {
          image: 'stamp',
          path: paths.stamp,
          byteSize: stampImage.data.png.length,
        },
        {
          image: 'spread',
          path: paths.spread,
          byteSize: spreadImage.data.png.length,
        },
      ],
    })
    if (!sent.ok)
      return fail(input, {
        stage: sent.stage,
        stampId,
        kind: sent.kind,
        error:
          `${sent.error ?? ''} (attempts ${sent.attempts}, delivered ${sent.delivered})`.trim(),
      })

    const marked = await markStampSent(supabase, rowScope, new Date())
    if (!marked.ok)
      // Both images reached the guest; only the marker failed. Reported, so
      // the null `sent_at` is not read as an undelivered stamp.
      return fail(input, { stage: 'mark_sent', stampId, error: marked.error })

    console.log('passport: stamp delivered', {
      event: 'passport_stamp_issued',
      venueId: input.venueId,
      guestId: input.guestId,
      stampId: stamp.id,
      kind: stamp.kind,
      seq: stamp.seq,
      page: stamp.page,
      attempts: sent.attempts,
    })
    await capturePassportStampIssued({
      venueId: input.venueId,
      guestId: input.guestId,
      transactionId: input.transactionId,
      stampId: stamp.id,
      kind: stamp.kind,
      seq: stamp.seq,
      page: stamp.page,
      attempts: sent.attempts,
      durationMs: Date.now() - startedMs,
    })
    return { status: 'issued', stampId: stamp.id }
  } catch (e) {
    return fail(input, { stage: 'unexpected', stampId, error: message(e) })
  }
}
