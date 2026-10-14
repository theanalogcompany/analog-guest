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
// TAC-584: A DESCRIBED ATTACHMENT'S LINE CAN SAY WHAT IT SHOWS, ON A HELD
// TURN. The rows read here carry `description` and `description_meta`
// (migration 081). buildMediaHistory words every message twice: without
// descriptions, which is what the context is built with and what every
// prompt gets by default, and with them, carried beside it. withDescribedHistory
// has the rule for when the second is used. This file still decides nothing
// about wording: lib/ai/prompts/attachment-lines.ts does.
//
// FAILS SOFT, to no lines. This is context on top of a turn that works without
// it. A read that fails is logged and the turn runs as it did before TAC-582.
//
// NEVER THROWS. It runs inside buildRuntimeContext's Promise.all, where a
// rejection fails the whole context build.
//
// IT SERVES BOTH ENGINES, in two layers. `loadTurnMediaHistory` and
// `buildTurnMediaHistory` are the queries and the wording, with no engine's
// types in them; `loadMediaHistory` and `buildMediaHistory` are v1's view,
// mapping the same result to `RecentMessage`. v2 reads the neutral pair
// (lib/relationship/turn-media.ts). Nothing is duplicated between them, which
// is the point - a second copy of "two wordings, the described one only on a
// held turn" is exactly the rule that would be rewritten on one side only.
//
// IT OUTLIVES v1. Phase 6 deletes lib/agent/, and this file, inbound-media.ts
// and media-context.ts are three that have to move rather than go - they are
// the media lane for both engines. Moving them now would be a wide rename
// through v1 for no behaviour; `lib/messaging/attachments/` is the home that
// matches when it happens.

import type { RecentMessage } from '@/lib/ai'
import {
  type HistoryAttachment,
  historyAttachmentLines,
} from '@/lib/ai/prompts/attachment-lines'
import { captureGuestMediaDegraded } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { isAttachmentKind } from '@/lib/messaging/attachments/kind'
import { usableDescription } from '@/lib/schemas/attachment-description'

import { MEDIA_COMPANION_WINDOW_MS } from './inbound-media'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

/** More attachment rows than a 14-day window of one guest's messages holds. */
const MAX_ATTACHMENT_ROWS = 500

/**
 * A guest message with NO TEXT, worded as a prompt turn. Engine-neutral: no
 * `RecentMessage`, so v2 reads it without v1's runtime types.
 *
 * `messageId` is carried because v2 needs it and v1 does not. v2 merges these
 * into a transcript it loaded by id, and a line it cannot key back to a row is
 * a line it cannot place in time.
 */
export interface MediaOnlyPromptMessage {
  messageId: string
  createdAt: Date
  attachmentLines: string[]
  describedAttachmentLines?: string[]
}

/**
 * What a window of one guest's attachments says, before either engine's own
 * types are involved. `MediaHistory` below is v1's view of the same thing, and
 * `buildMediaHistory` is the adapter - so the wording, the two-wordings rule
 * and the skip-a-message-with-no-lines rule exist once for both engines.
 */
export interface TurnMediaHistory {
  linesByMessageId: Map<string, string[]>
  describedLinesByMessageId: Map<string, string[]>
  mediaOnlyMessages: MediaOnlyPromptMessage[]
  /**
   * The read failed and this is empty for that reason, NOT because the guest
   * sent nothing. v1 does not need it (it reports through
   * captureGuestMediaDegraded and carries on), v2 puts it on the trace: a turn
   * that ran without the guest's media looks exactly like a turn for a guest
   * who sent none, and "we did not look" has to be distinguishable from
   * "there was nothing to look at" (.claude/rules/errors-as-values.md).
   */
  degraded: boolean
}

export interface MediaHistory {
  linesByMessageId: Map<string, string[]>
  /**
   * TAC-584: for a message with at least one described attachment, its lines
   * with the descriptions in. Kept beside `linesByMessageId`, never merged
   * into it: see withDescribedHistory.
   */
  describedLinesByMessageId: Map<string, string[]>
  mediaOnlyInbounds: RecentMessage[]
}

export const EMPTY_TURN_MEDIA_HISTORY: TurnMediaHistory = {
  linesByMessageId: new Map(),
  describedLinesByMessageId: new Map(),
  mediaOnlyMessages: [],
  degraded: false,
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}

/**
 * TAC-584: the history with every described attachment's line saying what it
 * shows. Pure.
 *
 * A DESCRIPTION IS IN A PROMPT ONLY WHEN THE REPLY IS HELD. Every media reply
 * is held for an operator (owner ruling 2026-10-11), and the hold is decided
 * per turn (media-context.ts): once the venue has answered a photo, the
 * guest's next message is an ordinary turn and can auto-send. If the photo's
 * description sat in that turn's history, a reply written from it would go
 * out with nobody reading it. So the history is built WITHOUT descriptions,
 * exactly as it was before they existed, and handle-inbound calls this only
 * after it knows the turn is held. The owner accepted that on 2026-10-11:
 * an unheld later turn does not read a description.
 */
export function withDescribedHistory(
  messages: readonly RecentMessage[],
): RecentMessage[] {
  return messages.map((message) =>
    message.describedAttachmentLines === undefined
      ? message
      : { ...message, attachmentLines: message.describedAttachmentLines },
  )
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
  // TAC-584: what the describe step wrote, when it has run. Optional so a
  // row built by hand, or by a caller older than the columns, reads as not
  // described.
  description?: string | null
  description_meta?: unknown
}

/**
 * Rows to the two things the context carries. Pure, and what the harness runs.
 *
 * v1's view: `mediaOnlyInbounds` as `RecentMessage`, which is what
 * `buildRuntimeContext` carries and `historyForPrompt` merges. The work is
 * `buildTurnMediaHistory`'s; this is the adapter, and it exists so v2 reading
 * the same rows cannot end up with a second wording of the same attachment.
 */
export function buildMediaHistory(
  mediaOnlyRows: readonly MediaOnlyRow[],
  attachmentRows: readonly AttachmentHistoryRow[],
): MediaHistory {
  const history = buildTurnMediaHistory(mediaOnlyRows, attachmentRows)
  return {
    linesByMessageId: history.linesByMessageId,
    describedLinesByMessageId: history.describedLinesByMessageId,
    mediaOnlyInbounds: history.mediaOnlyMessages.map(
      (message): RecentMessage => ({
        direction: 'inbound',
        body: '',
        createdAt: message.createdAt,
        delivery: 'delivered',
        attachmentLines: message.attachmentLines,
        ...(message.describedAttachmentLines !== undefined
          ? { describedAttachmentLines: message.describedAttachmentLines }
          : {}),
      }),
    ),
  }
}

/**
 * Rows to lines, engine-neutral. Pure.
 *
 * `attachmentRows` must be in position order within a message, which is how
 * loadMediaHistory selects them.
 */
export function buildTurnMediaHistory(
  mediaOnlyRows: readonly MediaOnlyRow[],
  attachmentRows: readonly AttachmentHistoryRow[],
): TurnMediaHistory {
  const attachmentsByMessage = new Map<string, HistoryAttachment[]>()
  for (const row of attachmentRows) {
    const attachment: HistoryAttachment = {
      kind: isAttachmentKind(row.kind) ? row.kind : 'unknown',
      providerType: row.provider_type,
      title: row.title,
      // TAC-584: only a description a prompt may carry. Never described,
      // skipped, and too-unclear-to-make-out all come back null here, and the
      // line is then the one it has always been.
      description:
        usableDescription({
          description: row.description ?? null,
          descriptionMeta: row.description_meta ?? null,
        })?.description ?? null,
    }
    const list = attachmentsByMessage.get(row.message_id)
    if (list) list.push(attachment)
    else attachmentsByMessage.set(row.message_id, [attachment])
  }

  // Two wordings of the same attachments: as if nothing had been described,
  // which is what every prompt gets, and with descriptions, which only a held
  // turn is given (withDescribedHistory).
  const undescribed = (attachments: readonly HistoryAttachment[]) =>
    attachments.map((attachment) => ({ ...attachment, description: null }))

  const linesByMessageId = new Map<string, string[]>()
  const describedLinesByMessageId = new Map<string, string[]>()
  for (const [messageId, attachments] of attachmentsByMessage) {
    const lines = historyAttachmentLines({
      unsupported: false,
      hasMedia: true,
      attachments: undescribed(attachments),
    })
    linesByMessageId.set(messageId, lines)
    const described = historyAttachmentLines({
      unsupported: false,
      hasMedia: true,
      attachments,
    })
    if (!sameLines(lines, described)) {
      describedLinesByMessageId.set(messageId, described)
    }
  }

  const mediaOnlyMessages: MediaOnlyPromptMessage[] = []
  for (const row of mediaOnlyRows) {
    const attachmentLines = historyAttachmentLines({
      unsupported: row.unsupported_content === true,
      hasMedia: (row.media_urls ?? []).length > 0,
      attachments: undescribed(attachmentsByMessage.get(row.id) ?? []),
    })
    if (attachmentLines.length === 0) continue
    const describedAttachmentLines = describedLinesByMessageId.get(row.id)
    mediaOnlyMessages.push({
      messageId: row.id,
      createdAt: new Date(row.created_at),
      attachmentLines,
      ...(describedAttachmentLines !== undefined
        ? { describedAttachmentLines }
        : {}),
    })
  }
  mediaOnlyMessages.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )
  return {
    linesByMessageId,
    describedLinesByMessageId,
    mediaOnlyMessages,
    degraded: false,
  }
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

/**
 * v1's view of the window. `loadTurnMediaHistory` does the work; this maps it
 * to `RecentMessage`, which is what `buildRuntimeContext` carries.
 */
export async function loadMediaHistory(
  supabase: AdminSupabaseClient,
  input: LoadMediaHistoryInput,
): Promise<MediaHistory> {
  const history = await loadTurnMediaHistory(supabase, input)
  return {
    linesByMessageId: history.linesByMessageId,
    describedLinesByMessageId: history.describedLinesByMessageId,
    mediaOnlyInbounds: history.mediaOnlyMessages.map(
      (message): RecentMessage => ({
        direction: 'inbound',
        body: '',
        createdAt: message.createdAt,
        delivery: 'delivered',
        attachmentLines: message.attachmentLines,
        ...(message.describedAttachmentLines !== undefined
          ? { describedAttachmentLines: message.describedAttachmentLines }
          : {}),
      }),
    ),
  }
}

/**
 * The window's media, engine-neutral, straight from the two queries.
 *
 * FAILS SOFT, to no lines and `degraded: true`. Never throws: v1 runs it
 * inside `buildRuntimeContext`'s Promise.all, where a rejection fails the
 * whole context build.
 */
export async function loadTurnMediaHistory(
  supabase: AdminSupabaseClient,
  input: LoadMediaHistoryInput,
): Promise<TurnMediaHistory> {
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
      .select(
        'message_id, kind, provider_type, title, description, description_meta',
      )
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
      return { ...EMPTY_TURN_MEDIA_HISTORY, degraded: true }
    }
    return buildTurnMediaHistory(mediaOnly.data ?? [], attachments.data ?? [])
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.warn('[agent] media history read threw; history has no media', {
      guestId: input.guestId,
      error,
    })
    await reportHistoryDegraded(input, error)
    return { ...EMPTY_TURN_MEDIA_HISTORY, degraded: true }
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

/**
 * GENERIC OVER THE ENTRY, because the rule below is about CLOCKS and not about
 * either engine's message shape: v1 merges `RecentMessage`, v2 merges its own
 * transcript turns (lib/relationship/turn-media.ts), and both need the same
 * window and the same sort. `createdAt` is all it reads.
 */
export interface PromptHistoryInput<T extends { createdAt: Date }> {
  recentMessages: readonly T[]
  mediaOnlyInbounds?: readonly T[]
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
export function historyForPrompt<T extends { createdAt: Date }>(
  input: PromptHistoryInput<T>,
): T[] {
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
