// TAC-582: the guest's attachments, as far as the agent's history goes.
//
// The agent's history query has always skipped a message with no text, so a
// photo a guest sent an hour ago was simply not in the conversation the model
// read. This file loads what that query leaves out and words it, and nothing
// else changes about how history is loaded.
//
// TWO THINGS COME BACK, AND THEY ARE KEPT APART ON PURPOSE.
//
//   linesByMessageId   the bracketed lines for every guest message in the
//                      window that has attachments. buildRuntimeContext puts
//                      them on the matching `recentMessages` entry, so a photo
//                      sent WITH a caption shows above the caption.
//
//   mediaOnlyInbounds  the guest messages that were ONLY media, or that Meta
//                      flagged unsupported: no text at all. These are NOT
//                      added to `recentMessages`. They ride on the context
//                      beside it and are merged in by historyForPrompt, at the
//                      two places a prompt is built.
//
// WHY THEY ARE NOT IN recentMessages (owner ruling 4, 2026-10-11, the narrow
// reading). A media-only message is conversation history for the model and is
// NOT the guest having written to us: a story mention is often a guest's first
// touch, the operator may never answer its card, and the guest's first real
// text should still get the first-visit flow. `recentMessages` is what decides
// that, in a dozen places: the opener (computeFirstTouchAfterQrScan reads
// `recentMessages.length === 0`), `returningGuest`, the pending question, the
// pacing brake, contextual retrieval. Leaving the list exactly as it was is
// what makes "text behaves exactly as today" true by construction, with no
// reader to re-check. isFirstContactNeutral below is the condition, named.
//
// FAILS SOFT, to no lines. This is context on top of a turn that works without
// it. A read that fails is logged and the turn runs as it did before TAC-582.
//
// NEVER THROWS. It runs inside buildRuntimeContext's Promise.all, where a
// rejection fails the whole context build.

import type { RecentMessage } from '@/lib/ai'
import {
  type HistoryAttachment,
  historyAttachmentLines,
} from '@/lib/ai/prompts/attachment-lines'
import { captureGuestMediaDegraded } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { isAttachmentKind } from '@/lib/messaging/attachments/kind'

import { MEDIA_COMPANION_WINDOW_MS } from './inbound-media'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

/** More attachment rows than a 14-day window of one guest's messages holds. */
const MAX_ATTACHMENT_ROWS = 500

export interface MediaHistory {
  linesByMessageId: Map<string, string[]>
  mediaOnlyInbounds: RecentMessage[]
}

export const EMPTY_MEDIA_HISTORY: MediaHistory = {
  linesByMessageId: new Map(),
  mediaOnlyInbounds: [],
}

export interface LoadMediaHistoryInput {
  venueId: string
  guestId: string
  /** The same cutoff the history query uses. */
  historyCutoffIso: string
  /** How many media-only messages to carry at most, newest kept. */
  maxMessages: number
  /** The message this turn answers, left out exactly as the history query leaves it out. */
  currentMessageId?: string
  /** A pinned history's upper bound (the Voices regen path). */
  historyEndIso?: string
}

/** A row the history query skips and this file is here for: a guest message with no text. */
export interface MediaOnlyRow {
  id: string
  created_at: string
  media_urls: string[] | null
  unsupported_content: boolean | null
}

export interface AttachmentHistoryRow {
  message_id: string
  kind: string
  provider_type: string | null
  title: string | null
}

/**
 * Rows to the two things the context carries. Pure, and what the harness runs.
 *
 * `attachmentRows` must be in position order within a message, which is how
 * loadMediaHistory selects them.
 */
export function buildMediaHistory(
  mediaOnlyRows: readonly MediaOnlyRow[],
  attachmentRows: readonly AttachmentHistoryRow[],
): MediaHistory {
  const attachmentsByMessage = new Map<string, HistoryAttachment[]>()
  for (const row of attachmentRows) {
    const attachment: HistoryAttachment = {
      kind: isAttachmentKind(row.kind) ? row.kind : 'unknown',
      providerType: row.provider_type,
      title: row.title,
    }
    const list = attachmentsByMessage.get(row.message_id)
    if (list) list.push(attachment)
    else attachmentsByMessage.set(row.message_id, [attachment])
  }

  const linesByMessageId = new Map<string, string[]>()
  for (const [messageId, attachments] of attachmentsByMessage) {
    linesByMessageId.set(
      messageId,
      historyAttachmentLines({
        unsupported: false,
        hasMedia: true,
        attachments,
      }),
    )
  }

  const mediaOnlyInbounds: RecentMessage[] = []
  for (const row of mediaOnlyRows) {
    const attachmentLines = historyAttachmentLines({
      unsupported: row.unsupported_content === true,
      hasMedia: (row.media_urls ?? []).length > 0,
      attachments: attachmentsByMessage.get(row.id) ?? [],
    })
    if (attachmentLines.length === 0) continue
    mediaOnlyInbounds.push({
      direction: 'inbound',
      body: '',
      createdAt: new Date(row.created_at),
      delivery: 'delivered',
      attachmentLines,
    })
  }
  mediaOnlyInbounds.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )
  return { linesByMessageId, mediaOnlyInbounds }
}

// A turn that ran without the guest's media in its history looks, from the
// outside, exactly like a turn for a guest who sent none. This is what makes
// the difference countable.
function reportHistoryDegraded(
  input: LoadMediaHistoryInput,
  error: string,
): Promise<void> {
  return captureGuestMediaDegraded({
    stage: 'history',
    reason: error,
    venueId: input.venueId,
    guestId: input.guestId,
    messageId: input.currentMessageId ?? null,
    attachmentId: null,
    host: null,
  })
}

export async function loadMediaHistory(
  supabase: AdminSupabaseClient,
  input: LoadMediaHistoryInput,
): Promise<MediaHistory> {
  try {
    // Inbound, no text, and either media or Meta's unsupported flag. That
    // leaves out what an empty body has always meant here: a scan row and a
    // titleless postback have neither, and a blank card is outbound.
    let mediaOnlyQuery = supabase
      .from('messages')
      .select('id, created_at, media_urls, unsupported_content')
      .eq('venue_id', input.venueId)
      .eq('guest_id', input.guestId)
      .eq('direction', 'inbound')
      .eq('body', '')
      .or('media_urls.neq.{},unsupported_content.is.true')
      .gte('created_at', input.historyCutoffIso)
      .order('created_at', { ascending: false })
      .limit(input.maxMessages)
    if (input.currentMessageId) {
      mediaOnlyQuery = mediaOnlyQuery.neq('id', input.currentMessageId)
    }
    if (input.historyEndIso) {
      mediaOnlyQuery = mediaOnlyQuery.lt('created_at', input.historyEndIso)
    }

    // By guest and window rather than by a list of message ids: the window
    // can hold 180 rows, and that many uuids is a URL PostgREST may refuse.
    const attachmentsQuery = supabase
      .from('message_attachments')
      .select('message_id, kind, provider_type, title')
      .eq('venue_id', input.venueId)
      .eq('guest_id', input.guestId)
      .gte('created_at', input.historyCutoffIso)
      .order('message_id', { ascending: true })
      .order('position', { ascending: true })
      .limit(MAX_ATTACHMENT_ROWS)

    const [mediaOnly, attachments] = await Promise.all([
      mediaOnlyQuery,
      attachmentsQuery,
    ])
    if (mediaOnly.error || attachments.error) {
      const error =
        mediaOnly.error?.message ?? attachments.error?.message ?? 'unknown'
      console.warn('[agent] media history not loaded; history has no media', {
        guestId: input.guestId,
        error,
      })
      await reportHistoryDegraded(input, error)
      return EMPTY_MEDIA_HISTORY
    }
    return buildMediaHistory(mediaOnly.data ?? [], attachments.data ?? [])
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.warn('[agent] media history read threw; history has no media', {
      guestId: input.guestId,
      error,
    })
    await reportHistoryDegraded(input, error)
    return EMPTY_MEDIA_HISTORY
  }
}

/**
 * Owner ruling 4: does this history entry leave first contact where it was?
 *
 * True for a guest message with no text. It is in the model's history and it
 * is not the guest having written to us, so nothing that decides first contact
 * may count it. The context enforces that by never putting one in
 * `recentMessages`; this is the same rule as a predicate, for the harness and
 * for any reader that is ever handed the merged list.
 */
export function isFirstContactNeutral(message: RecentMessage): boolean {
  return message.direction === 'inbound' && message.body.trim() === ''
}

export interface PromptHistoryInput {
  recentMessages: readonly RecentMessage[]
  mediaOnlyInbounds?: readonly RecentMessage[]
  /** Set when this turn's prompt already says "[guest also sent a photo]". */
  inboundMediaAnnounced: boolean
  /** When the message this turn answers arrived. Null on a proactive turn. */
  currentMessageAt: Date | null
}

/**
 * The history a prompt is built from: `recentMessages` with the media-only
 * messages put back in their place, oldest first.
 *
 * ONLY FOR BUILDING A PROMPT. Anything deciding what kind of turn this is
 * reads `recentMessages`.
 *
 * A media-only message this turn already announced is left out. When the
 * guest sends a photo and a text together, the prompt's last line says
 * "[guest also sent a photo]" with the instruction not to describe it; the
 * same photo as a history turn a second earlier would tell the model twice,
 * and the second telling carries no such instruction. "Already announced" is
 * the companion window inbound-media.ts uses to pair the two in the first
 * place, measured the same way.
 */
export function historyForPrompt(input: PromptHistoryInput): RecentMessage[] {
  const mediaOnly = input.mediaOnlyInbounds ?? []
  if (mediaOnly.length === 0) return [...input.recentMessages]

  const currentMs = input.currentMessageAt?.getTime() ?? null
  const kept = mediaOnly.filter(
    (message) =>
      !(
        input.inboundMediaAnnounced &&
        currentMs !== null &&
        Math.abs(message.createdAt.getTime() - currentMs) <=
          MEDIA_COMPANION_WINDOW_MS
      ),
  )
  return [...input.recentMessages, ...kept].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )
}
