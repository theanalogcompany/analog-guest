// TAC-584: describe what a guest sent, once, and keep the sentence.
//
// For each photo, video, GIF or story mention on the messages a turn is
// answering: get the bytes, turn them into images a model can be shown
// (frames.ts), make one vision call (lib/ai/describe-attachment.ts), and
// write `description`, `description_meta` and `described_at` on the row
// (migration 081).
//
// THE AGENT'S TURN OWNS THIS, AND WAITS FOR IT. Not the re-host step, which
// is where the ticket first put it. Both webhooks hand re-host and the agent
// turn to waitUntil as two separate tasks with nothing ordering them, and a
// story never enters re-host at all. A draft written from a description needs
// the description to exist, so the turn that is about to draft calls this and
// awaits it. That also means nothing is described for a message the agent
// never runs on (staff's own photos, a shut gate, a paused venue), which is
// the ticket's scope.
//
// WHERE THE BYTES COME FROM.
//   photo, video, GIF   our own bucket, once re-host has made the row
//                       `ready`. This waits for that, up to
//                       DESCRIBE_SETTLE_MS.
//   story mention       Meta's link, fetched once through the same host
//                       allowlist, redirect check and size cap re-host uses
//                       (downloadTargetFor, downloadAttachment). THE BYTES ARE
//                       NEVER UPLOADED: Meta forbids keeping a story (owner
//                       ruling 2026-10-11). They live in this function's
//                       memory, and for a story video in one temp file for
//                       the length of the ffmpeg call. The row keeps
//                       `status = 'link_only'` and no `storage_path`.
//   a Giphy GIF/sticker never described (the ticket). Its row is `ready` with
//                       no file of ours, which is how it is recognised.
//   anything else       never: a voice note, a file, a shared reel or post,
//                       and the venue's own story a guest replied to.
//
// EACH ROW IS SETTLED ONCE. `described_at` is written with the description,
// or with a skip reason when the attachment can NEVER be described (a type
// nothing can read, a story link that is already dead). A failure that might
// not repeat (the model call, a missing ffmpeg, a re-host still running) is
// reported and writes nothing, so the row is not marked as tried.
//
// THE FRAMES ARE RETURNED, AND ONLY FROM THIS CALL. The turn that answers the
// message shows the model the picture itself as well as the sentence, so the
// images this run made are handed back in memory. An attachment described by
// an earlier run comes back with its sentence and no frames: the bytes are not
// fetched a second time to rebuild them.
//
// FAILS SOFT, TO TODAY. Anything that goes wrong leaves the attachment
// undescribed, and an undescribed attachment is what every turn had before
// this file: the agent is told a photo arrived and that it cannot see it, and
// a message with no text becomes the blank card. Every such path reports
// through captureGuestMediaDegraded (stage `describe`) so it can be counted.
//
// NEVER THROWS. It is awaited inside an agent turn.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database, Json } from '@/db/types'
import {
  type DescribeAttachmentInput,
  type DescribeAttachmentResult,
  type DescribedMediaKind,
  describeAttachment,
} from '@/lib/ai/describe-attachment'
import type { AIResult } from '@/lib/ai/types'
import {
  type GuestMediaDegradedProps,
  captureGuestMediaDegraded,
} from '@/lib/analytics/posthog'
import { type AgentTrace, toAgentUsage } from '@/lib/observability'
import { loadAppearanceEntries } from '@/lib/rag/appearance-entries'
import {
  type AttachmentDescriptionMeta,
  type DescribeSkipReason,
  DESCRIPTION_META_VERSION,
  cleanDescription,
  parseDescriptionMeta,
} from '@/lib/schemas/attachment-description'

import {
  type Frame,
  type FramesResult,
  imageToFrame,
  videoToFrames,
} from './frames'
import {
  type AttachmentKind,
  type AttachmentStatus,
  isAttachmentKind,
  isAttachmentStatus,
} from './kind'
import {
  GUEST_MEDIA_BUCKET,
  downloadAttachment,
  downloadTargetFor,
} from './rehost'

type AdminSupabaseClient = SupabaseClient<Database>

/** The longest a turn waits for re-host to make an attachment `ready`. */
export const DESCRIBE_SETTLE_MS = 15_000
export const DESCRIBE_SETTLE_POLL_MS = 1_500

/** The most attachments described on one turn. */
export const MAX_DESCRIBED_PER_TURN = 4

/** An attachment row, as far as this file reads it. */
export type DescribeTarget = {
  id: string
  messageId: string
  kind: AttachmentKind
  status: AttachmentStatus
  providerType: string | null
  providerUrl: string | null
  storagePath: string | null
  mimeType: string | null
  description: string | null
  descriptionMeta: unknown
  describedAt: string | null
}

/** What comes back for each attachment a description exists or was tried for. */
export type DescribedAttachment = {
  attachmentId: string
  messageId: string
  mediaKind: DescribedMediaKind
  /** Already cleaned for a prompt. Null when there is nothing usable. */
  description: string | null
  meta: AttachmentDescriptionMeta | null
  /** The images the model was shown, from THIS run only. Never stored. */
  frames: Frame[]
}

const MEDIA_KIND = {
  image: 'photo',
  video: 'video',
  gif: 'gif',
  story_mention: 'story',
} as const satisfies Partial<Record<AttachmentKind, DescribedMediaKind>>

type DescribableKind = keyof typeof MEDIA_KIND

function isDescribableKind(kind: AttachmentKind): kind is DescribableKind {
  return kind in MEDIA_KIND
}

export type DescribePlan =
  /** Settled by an earlier run. Its row is read, nothing is fetched. */
  | { action: 'already' }
  /** Read from our bucket. */
  | { action: 'describe'; source: 'stored' }
  /** Fetched from the provider for this call and dropped. A story. */
  | { action: 'describe'; source: 'transient' }
  /** Re-host has not finished. Looked at again after a pause. */
  | { action: 'wait' }
  /** Not something this describes, or nothing to describe it from. */
  | { action: 'never' }

/**
 * What to do with one attachment row. Pure, and what the harness runs.
 *
 * `unknown` waits while it is pending: re-host settles an unknown row's kind
 * from the file it downloads, so it may yet turn out to be a photo.
 */
export function planDescribe(target: DescribeTarget): DescribePlan {
  if (target.describedAt !== null) {
    return isDescribableKind(target.kind)
      ? { action: 'already' }
      : { action: 'never' }
  }
  if (target.kind === 'story_mention') {
    return target.providerUrl !== null
      ? { action: 'describe', source: 'transient' }
      : { action: 'never' }
  }
  if (target.kind === 'unknown') {
    return target.status === 'pending'
      ? { action: 'wait' }
      : { action: 'never' }
  }
  if (!isDescribableKind(target.kind)) return { action: 'never' }
  if (target.status === 'pending') return { action: 'wait' }
  // `ready` with no file of ours is a Giphy link: a sticker or reaction GIF.
  if (target.status === 'ready' && target.storagePath !== null) {
    return { action: 'describe', source: 'stored' }
  }
  return { action: 'never' }
}

type LoadedBytes =
  { ok: true; bytes: Uint8Array; mimeType: string | null } | { ok: false }

/** Everything this file reaches outside itself, so the harness can stand in for it. */
export type DescribeDeps = {
  loadTargets: (messageIds: readonly string[]) => Promise<DescribeTarget[]>
  sleep: (ms: number) => Promise<void>
  loadStoredBytes: (target: DescribeTarget) => Promise<LoadedBytes>
  downloadTransient: (target: DescribeTarget) => Promise<LoadedBytes>
  toFrames: (
    bytes: Uint8Array,
    mimeType: string | null,
    isVideo: boolean,
  ) => Promise<FramesResult>
  loadAppearanceNotes: (venueId: string) => Promise<string[]>
  describe: (
    input: DescribeAttachmentInput,
  ) => Promise<AIResult<DescribeAttachmentResult>>
  save: (
    attachmentId: string,
    description: string | null,
    meta: AttachmentDescriptionMeta,
  ) => Promise<void>
  report: (props: GuestMediaDegradedProps) => Promise<void>
}

const DESCRIBE_COLUMNS =
  'id, message_id, kind, status, provider_type, provider_url, storage_path, mime_type, description, description_meta, described_at'

function defaultDeps(supabase: AdminSupabaseClient): DescribeDeps {
  return {
    async loadTargets(messageIds) {
      if (messageIds.length === 0) return []
      const { data, error } = await supabase
        .from('message_attachments')
        .select(DESCRIBE_COLUMNS)
        .in('message_id', [...messageIds])
        .order('message_id', { ascending: true })
        .order('position', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []).map((row) => ({
        id: row.id,
        messageId: row.message_id,
        kind: isAttachmentKind(row.kind) ? row.kind : 'unknown',
        status: isAttachmentStatus(row.status) ? row.status : 'failed',
        providerType: row.provider_type,
        providerUrl: row.provider_url,
        storagePath: row.storage_path,
        mimeType: row.mime_type,
        description: row.description,
        descriptionMeta: row.description_meta,
        describedAt: row.described_at,
      }))
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async loadStoredBytes(target) {
      if (target.storagePath === null) return { ok: false }
      const { data, error } = await supabase.storage
        .from(GUEST_MEDIA_BUCKET)
        .download(target.storagePath)
      if (error || data === null) return { ok: false }
      const bytes = new Uint8Array(await data.arrayBuffer())
      return bytes.byteLength === 0
        ? { ok: false }
        : { ok: true, bytes, mimeType: target.mimeType }
    },
    async downloadTransient(target) {
      if (target.providerUrl === null) return { ok: false }
      // The same refusals re-host makes before any request: https, a public
      // name, and on Instagram only Meta's own CDN hosts, at every redirect.
      const where = downloadTargetFor(target.providerUrl, target.providerType)
      if (!where.ok) return { ok: false }
      const downloaded = await downloadAttachment(
        where.url,
        target.providerType,
        fetch,
      )
      return downloaded.ok
        ? { ok: true, bytes: downloaded.bytes, mimeType: downloaded.mimeType }
        : { ok: false }
    },
    toFrames: (bytes, mimeType, isVideo) =>
      isVideo ? videoToFrames(bytes) : imageToFrame(bytes, mimeType),
    async loadAppearanceNotes(venueId) {
      const notes = await loadAppearanceEntries(supabase, venueId)
      if (!notes.ok) {
        console.warn('[describe] appearance notes not loaded; naming nothing', {
          venueId,
          error: notes.error,
        })
        return []
      }
      return notes.data
    },
    describe: describeAttachment,
    async save(attachmentId, description, meta) {
      const { error } = await supabase
        .from('message_attachments')
        .update({
          description,
          description_meta: meta as unknown as Json,
          described_at: new Date().toISOString(),
        })
        .eq('id', attachmentId)
        // Settled once: a second run over the same row writes nothing.
        .is('described_at', null)
      if (error) throw new Error(error.message)
    },
    report: captureGuestMediaDegraded,
  }
}

export type DescribeMessageAttachmentsInput = {
  /** The message the turn answers, and any media-only message paired with it. */
  messageIds: readonly string[]
  venue: { id: string; name: string | null; menuItemNames: readonly string[] }
  guestId: string
  trace?: AgentTrace
  deps?: Partial<DescribeDeps>
}

function isVideoBytes(
  target: DescribeTarget,
  mimeType: string | null,
): boolean {
  if (target.kind === 'video') return true
  // A story is a photo or a clip, and only the download says which.
  return (
    target.kind === 'story_mention' &&
    (mimeType ?? '').toLowerCase().startsWith('video/')
  )
}

function skippedMeta(reason: DescribeSkipReason): AttachmentDescriptionMeta {
  return { version: DESCRIPTION_META_VERSION, outcome: 'skipped', reason }
}

function alreadyDescribed(
  target: DescribeTarget,
  mediaKind: DescribedMediaKind,
): DescribedAttachment {
  return {
    attachmentId: target.id,
    messageId: target.messageId,
    mediaKind,
    description: cleanDescription(target.description),
    meta: parseDescriptionMeta(target.descriptionMeta),
    frames: [],
  }
}

/**
 * Describe every describable attachment on these messages, and return what is
 * now known about each. Awaited by the agent turn before it drafts.
 *
 * An attachment missing from the result is one this never describes (a voice
 * note, a share, a Giphy sticker) or one that could not be described this
 * time. Either way the turn treats it as it always has.
 */
export async function describeMessageAttachments(
  supabase: AdminSupabaseClient,
  input: DescribeMessageAttachmentsInput,
): Promise<DescribedAttachment[]> {
  const deps: DescribeDeps = { ...defaultDeps(supabase), ...input.deps }
  const reportSkip = (
    target: DescribeTarget | null,
    reason: string,
  ): Promise<void> =>
    deps.report({
      stage: 'describe',
      reason,
      venueId: input.venue.id,
      guestId: input.guestId,
      messageId: target?.messageId ?? input.messageIds[0] ?? null,
      attachmentId: target?.id ?? null,
      host: null,
    })

  try {
    let targets = await deps.loadTargets(input.messageIds)
    for (
      let waited = 0;
      waited < DESCRIBE_SETTLE_MS &&
      targets.some((target) => planDescribe(target).action === 'wait');
      waited += DESCRIBE_SETTLE_POLL_MS
    ) {
      await deps.sleep(DESCRIBE_SETTLE_POLL_MS)
      targets = await deps.loadTargets(input.messageIds)
    }

    const results: DescribedAttachment[] = []
    let notes: string[] | null = null
    let described = 0
    for (const target of targets) {
      const plan = planDescribe(target)
      if (plan.action === 'never') continue
      if (!isDescribableKind(target.kind)) {
        // Still `unknown` and still pending after the wait.
        await reportSkip(target, 'not_ready')
        continue
      }
      const mediaKind = MEDIA_KIND[target.kind]
      if (plan.action === 'already') {
        results.push(alreadyDescribed(target, mediaKind))
        continue
      }
      if (plan.action === 'wait') {
        // Re-host is still running, or died. Nothing is written, so a later
        // turn that finds the row ready can still describe it.
        await reportSkip(target, 'not_ready')
        continue
      }
      if (described >= MAX_DESCRIBED_PER_TURN) continue
      described += 1

      const loaded =
        plan.source === 'transient'
          ? await deps.downloadTransient(target)
          : await deps.loadStoredBytes(target)
      if (!loaded.ok) {
        await reportSkip(target, 'bytes_unavailable')
        // A story's link does not come back. A stored file that would not
        // load may load next time, so only the story is settled.
        if (plan.source === 'transient') {
          const meta = skippedMeta('bytes_unavailable')
          await deps.save(target.id, null, meta)
          results.push({ ...alreadyDescribed(target, mediaKind), meta })
        }
        continue
      }

      const isVideo = isVideoBytes(target, loaded.mimeType)
      const framed = await deps.toFrames(loaded.bytes, loaded.mimeType, isVideo)
      if (!framed.ok) {
        await reportSkip(target, framed.error)
        if (framed.error === 'unsupported_type') {
          const meta = skippedMeta('unsupported_type')
          await deps.save(target.id, null, meta)
          results.push({ ...alreadyDescribed(target, mediaKind), meta })
        }
        // A missing or failing ffmpeg is the deployment's fault, not the
        // file's. Nothing is written.
        continue
      }

      notes ??= await deps.loadAppearanceNotes(input.venue.id)
      const span = input.trace?.generation('describe_attachment', {
        attachmentId: target.id,
        kind: mediaKind,
        frames: framed.frames.length,
        appearanceNotes: notes.length,
      })
      const call = await deps.describe({
        frames: framed.frames,
        kind: mediaKind,
        venueName: input.venue.name,
        menuItemNames: input.venue.menuItemNames,
        appearanceNotes: notes,
      })
      if (!call.ok) {
        span?.end({ level: 'ERROR', statusMessage: call.error })
        await reportSkip(target, call.errorCode ?? 'model_failed')
        continue
      }

      const description = cleanDescription(call.data.description)
      const meta: AttachmentDescriptionMeta = {
        version: DESCRIPTION_META_VERSION,
        outcome: 'described',
        promptVersion: call.data.promptVersion,
        model: call.data.modelId ?? 'unknown',
        legibility: call.data.legibility,
        showsVenue: call.data.showsVenue,
        peoplePresent: call.data.peoplePresent,
        items: call.data.items,
        frames: framed.frames.length,
        source: plan.source,
      }
      // THE PICTURE NEVER GOES TO THE TRACE, whatever the capture setting:
      // for a story that would be keeping it. The sentence does.
      span?.end({
        output: {
          legibility: meta.legibility,
          showsVenue: meta.showsVenue,
          peoplePresent: meta.peoplePresent,
          itemCount: meta.items.length,
          source: meta.source,
        },
        content: { description },
        model: call.data.modelId,
        usage: toAgentUsage(call.data.usage),
      })
      await deps.save(target.id, description, meta)
      results.push({
        attachmentId: target.id,
        messageId: target.messageId,
        mediaKind,
        description,
        meta,
        frames: framed.frames,
      })
    }
    return results
  } catch (e) {
    console.warn('[describe] describe step threw; media left undescribed', {
      venueId: input.venue.id,
      error: e instanceof Error ? e.message : String(e),
    })
    await reportSkip(null, e instanceof Error ? e.message : String(e))
    return []
  }
}
