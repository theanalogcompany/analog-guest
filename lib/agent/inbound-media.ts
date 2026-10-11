// TAC-574: what a photo, GIF or other attachment does to an inbound turn.
//
// THE DEFECT. A message with media and no text is stored with `body = ''`
// (both webhooks). The agent never read `media_urls`, so the turn reached
// classification with an empty body, threw `classifyStage: invalid_input`, was
// retried once and threw again. The guest got nothing and nobody at the venue
// learned they had written. Worse, a turn ADOPTS the newest message of a
// burst, so "do you have oat milk?" followed by a photo failed on the photo
// and the question was never answered either.
//
// THE RULING (2026-10-06), which is what every branch here implements:
//   - A turn with any text is DRAFTED normally. The agent is told the guest
//     also sent a photo. (Since the 2026-10-11 ruling that draft is held for
//     an operator and never auto-sent: lib/agent/media-context.ts. Whether a
//     reply is held is that file's question, not this one's.)
//   - A blank card only for a turn with no text at all. The owner answers by
//     hand.
//   - The photo-last case must not fail.
//
// WHAT "THE TURN" MEANS HERE. Coalescing has no burst membership: a turn is
// the newest message plus whatever history shows. So this module draws the
// line itself. A media-only message looks at the guest's text from the last
// MEDIA_COMPANION_WINDOW_MS and goes one of three ways:
//
//   answer_text  a text there is still UNANSWERED. The turn answers it, with
//                the note. This is the photo-last case.
//   covered      every text there is answered, and one of those answers was
//                written AFTER the media arrived. The media was already part
//                of that turn when its reply or its card went out (it landed
//                while the turn was dispatching, or behind a draft that
//                queued), so a card now would be a reply AND a card for one
//                burst. Nothing is written. That reply did not acknowledge the
//                photo, which is the cost.
//   card         anything else: no text nearby, or the text's turn had already
//                finished BEFORE the media arrived. A photo sent after a
//                finished turn is a turn of its own. Folding it backwards
//                would make it vanish, which is the failure this ticket
//                exists to remove.
//
// WHAT THIS CANNOT DO.
//   - It cannot see the media. No model looks at the image. (The operator app
//     can be sent it since TAC-582, through the thread endpoints.)
//   - From the LINKS alone it cannot tell a photo from a GIF on Instagram:
//     Meta's CDN links carry no file extension, so a message with no
//     attachment row reads as 'unknown' and the agent is told "a photo or
//     GIF". A message that has rows is read off them instead (mediaKindOf,
//     TAC-582), which is every Instagram message saved since that table
//     existed.
//   - An Instagram message with nothing to show (Meta's `is_unsupported`, or
//     attachments with no link) reaches the agent as a row with
//     `unsupported_content` and takes the card path beside this one
//     (handle-inbound.ts). It has no media links, so nothing here sees it.
//   - A text that arrives after the card was written goes through the
//     ordinary gate with that card pending: a question gets its own card
//     (always a card now, never a reply: the media_context hold), a bare
//     "thanks" is silenced behind it, and a correction regenerates it
//     (resolveConversationDisposition). The wait before carding exists to
//     make that rare, not impossible.

import { createAdminClient } from '@/lib/db/admin'
import type { InboundMediaKind } from '@/lib/ai/types'
// TAC-582: the extension lists moved beside the attachment kinds, which read
// the same links for the same reason. One list, two readers.
import {
  type AttachmentKind,
  GIF_EXTENSIONS,
  PHOTO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  extensionOf,
  isAttachmentKind,
} from '@/lib/messaging/attachments/kind'

/**
 * How far back a media-only message looks for the text it belongs with.
 * Matches the turn claim's lease (CLAIM_LEASE_MS): past that, the earlier
 * message's turn is over by construction. Not measured.
 */
export const MEDIA_COMPANION_WINDOW_MS = 120_000

/**
 * The longest a media-only turn waits for a caption before it becomes a card,
 * and how often it looks.
 *
 * A guest who sends a photo and then types "is this the new one?" produces two
 * messages a few seconds apart. Without the wait the photo's run cards it
 * before the text exists, and the guest gets a reply AND the owner gets a
 * blank card for the same moment.
 *
 * Polled, so a caption that is already there is adopted within one interval
 * rather than after the whole wait: this run holds the claim, and the
 * caption's reply cannot start until it lets go. A bare photo costs the owner
 * the full wait before the card appears. Both numbers are guesses, not
 * measurements: move them on evidence.
 */
export const MEDIA_ONLY_SETTLE_MS = 10_000
export const MEDIA_ONLY_SETTLE_POLL_MS = 2_000

/**
 * What the links say was sent.
 *
 *   'unknown'  no link carries a file extension at all, which is every
 *              Instagram attachment. Nothing says it is not a photo.
 *   'other'    a link carries an extension this does not recognize (a voice
 *              memo, a PDF, a contact card over text). That IS evidence it is
 *              not a photo, so the agent is told "an attachment".
 */
export function mediaKindFromUrls(urls: readonly string[]): InboundMediaKind {
  const extensions = urls
    .map(extensionOf)
    .filter((ext): ext is string => ext !== null)
  const has = (list: readonly string[]) =>
    extensions.some((ext) => list.includes(ext))
  if (has(GIF_EXTENSIONS)) return 'gif'
  if (has(PHOTO_EXTENSIONS)) return 'photo'
  if (has(VIDEO_EXTENSIONS)) return 'video'
  return extensions.length > 0 ? 'other' : 'unknown'
}

// TAC-582: what an attachment row says the guest sent, in the vocabulary of
// the "[guest also sent ...]" line. `null` means the row does not settle it
// and the links are read instead.
//   story_reply  is not something the guest sent. It is the venue's story,
//                and the turn says so on its own line (repliesToStory).
//   unknown      is a row that does not know either.
// A share and a story mention are "an attachment": the line has no wording of
// its own for them, and that one is true of both.
const MEDIA_KIND_BY_ATTACHMENT = {
  image: 'photo',
  gif: 'gif',
  video: 'video',
  audio: 'voice_note',
  file: 'other',
  share: 'other',
  story_mention: 'other',
  story_reply: null,
  unknown: null,
} as const satisfies Record<AttachmentKind, InboundMediaKind | null>

/**
 * What one message's media is.
 *
 * THE ATTACHMENT ROW WINS WHEN THERE IS ONE (TAC-582). Meta's CDN links carry
 * no file extension, so the links alone read every Instagram attachment as
 * 'unknown' and a voice note sent beside a text was announced as "a photo or
 * GIF". The row has Meta's own type. The first attachment that settles it
 * names the line, as the first link did; a message with no rows, or whose
 * rows settle nothing, is read off its links exactly as before.
 */
export function mediaKindOf(
  row: Pick<TurnInboundRow, 'mediaUrls' | 'attachmentKinds'>,
): InboundMediaKind {
  for (const kind of row.attachmentKinds ?? []) {
    const settled = MEDIA_KIND_BY_ATTACHMENT[kind]
    if (settled !== null) return settled
  }
  return mediaKindFromUrls(row.mediaUrls)
}

/** Media present and no text at all. Whitespace is not text. */
export function isMediaOnly(
  body: string,
  mediaUrls: readonly string[],
): boolean {
  return body.trim() === '' && mediaUrls.length > 0
}

export interface TurnInboundRow {
  id: string
  body: string
  mediaUrls: string[]
  createdAt: Date
  /**
   * TAC-582: the kinds on this message's attachment rows, in position order.
   * Empty or absent when it has none: a message older than the table, one
   * whose row write failed, or a row built by hand.
   */
  attachmentKinds?: AttachmentKind[]
}

export interface TurnOutboundRow {
  replyToMessageId: string | null
  createdAt: Date
}

export interface TurnMediaRows {
  inbound: TurnInboundRow[]
  outbound: TurnOutboundRow[]
}

export type MediaOnlyResolution =
  /** An unanswered text sits beside the media: answer that, no card. */
  | { kind: 'answer_text'; textMessageId: string }
  /** The media arrived inside a turn whose reply or card already exists. */
  | { kind: 'covered' }
  /** No text in this turn at all: the owner answers by hand. */
  | { kind: 'card' }

type Positioned = Pick<TurnInboundRow, 'id' | 'createdAt'>

/** `a` is at or after `b` on `(created_at, id)`, the order coalescing uses. */
function atOrAfter(a: Positioned, b: Positioned): boolean {
  const delta = a.createdAt.getTime() - b.createdAt.getTime()
  return delta > 0 || (delta === 0 && a.id >= b.id)
}

/**
 * The outbound rows that answer `text`: one that replies to it, one that
 * replies to a LATER inbound (a turn that adopted a newer message covers the
 * earlier ones, and a regenerated card's key moves forward the same way), or
 * one with no inbound behind it written afterwards (staff typing in the
 * Instagram app, a manual send).
 *
 * NOT "any outbound written afterwards". That was the first version, and it
 * read an EARLIER message's card as this one's answer: "my latte was cold",
 * then "also do you have oat milk?", then a photo, with the complaint's draft
 * queueing in between, left the oat milk question judged answered and never
 * replied to. A row keyed to an earlier inbound says nothing about this one.
 */
function answersTo(
  text: Positioned,
  rows: TurnMediaRows,
): readonly TurnOutboundRow[] {
  const inboundById = new Map(rows.inbound.map((row) => [row.id, row]))
  return rows.outbound.filter((out) => {
    if (out.replyToMessageId === null) {
      return out.createdAt.getTime() > text.createdAt.getTime()
    }
    const repliedTo = inboundById.get(out.replyToMessageId)
    // A key outside the loaded window names an older message, not this one.
    return repliedTo !== undefined && atOrAfter(repliedTo, text)
  })
}

/**
 * Which way a media-only message goes. Pure. The three outcomes and why are
 * in this file's header.
 *
 * `current` is the media-only message the turn adopted, which is the newest
 * the run could see, so only EARLIER text is looked for.
 */
export function resolveMediaOnlyTurn(
  current: Positioned,
  rows: TurnMediaRows,
): MediaOnlyResolution {
  const currentMs = current.createdAt.getTime()
  const texts = rows.inbound
    .filter(
      (row) =>
        row.id !== current.id &&
        row.body.trim() !== '' &&
        atOrAfter(current, row) &&
        row.createdAt.getTime() >= currentMs - MEDIA_COMPANION_WINDOW_MS,
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const unanswered = texts.find((row) => answersTo(row, rows).length === 0)
  if (unanswered !== undefined) {
    return { kind: 'answer_text', textMessageId: unanswered.id }
  }
  const answeredAfterMediaArrived = texts.some((row) =>
    answersTo(row, rows).some((out) => out.createdAt.getTime() >= currentMs),
  )
  return answeredAfterMediaArrived ? { kind: 'covered' } : { kind: 'card' }
}

/**
 * What the guest sent beside the text this turn is answering, or null. Pure.
 *
 * Two sources: media on the answered message itself (a caption and a photo in
 * one message), and a media-only message within the companion window on
 * either side of it that nothing has been sent or queued after.
 *
 * "Nothing after it" is deliberately the LOOSE rule that answersTo refuses.
 * The two want opposite strictness: there a wrong "answered" loses a reply,
 * here a wrong "already handled" loses only an acknowledgement, and the
 * strict rule would acknowledge one photo on every turn for two minutes.
 */
export function mediaAlongsideText(
  current: TurnInboundRow,
  rows: TurnMediaRows,
): InboundMediaKind | null {
  // The rows loaded for the turn carry the attachment kinds; `current` is
  // built from the message itself and usually does not.
  const self = rows.inbound.find((row) => row.id === current.id) ?? current
  if (current.mediaUrls.length > 0) {
    return mediaKindOf({
      mediaUrls: current.mediaUrls,
      attachmentKinds: self.attachmentKinds ?? current.attachmentKinds,
    })
  }
  const currentMs = current.createdAt.getTime()
  const beside = rows.inbound
    .filter(
      (row) =>
        row.id !== current.id &&
        isMediaOnly(row.body, row.mediaUrls) &&
        Math.abs(row.createdAt.getTime() - currentMs) <=
          MEDIA_COMPANION_WINDOW_MS &&
        !rows.outbound.some(
          (out) =>
            out.replyToMessageId === row.id ||
            out.createdAt.getTime() > row.createdAt.getTime(),
        ),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  return beside === undefined ? null : mediaKindOf(beside)
}

/**
 * TAC-582: is the message this turn answers a reply to one of the venue's
 * stories? Pure. Read off the same rows, by the attachment row parse-events
 * writes for `message.reply_to.story`.
 */
export function repliesToStory(
  current: Pick<TurnInboundRow, 'id'>,
  rows: TurnMediaRows,
): boolean {
  const self = rows.inbound.find((row) => row.id === current.id)
  return (self?.attachmentKinds ?? []).includes('story_reply')
}

export type TurnMediaRowsResult =
  { ok: true; data: TurnMediaRows } | { ok: false; error: string }

/**
 * This guest's recent rows, both directions, for the two pure functions above.
 *
 * Never throws. A failed read is reported and each caller picks its own
 * direction: the media-only path cards (a human sees it), the text path
 * answers without the note (the reply is not held up for an acknowledgement).
 */
export async function loadTurnMediaRows(input: {
  venueId: string
  guestId: string
  around: Date
}): Promise<TurnMediaRowsResult> {
  try {
    // Twice the window: the message the turn ends up answering can itself be
    // up to one window older than `around`.
    const sinceIso = new Date(
      input.around.getTime() - 2 * MEDIA_COMPANION_WINDOW_MS,
    ).toISOString()
    const supabase = createAdminClient()
    const [{ data, error }, attachments] = await Promise.all([
      supabase
        .from('messages')
        .select(
          'id, direction, body, media_urls, created_at, reply_to_message_id',
        )
        .eq('venue_id', input.venueId)
        .eq('guest_id', input.guestId)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(50),
      // TAC-582: what each of those messages' attachments ARE. By guest and
      // time, like the rows above, so the two cover the same messages.
      supabase
        .from('message_attachments')
        .select('message_id, kind')
        .eq('venue_id', input.venueId)
        .eq('guest_id', input.guestId)
        .gte('created_at', sinceIso)
        .order('message_id', { ascending: true })
        .order('position', { ascending: true })
        .limit(200),
    ])
    if (error)
      return { ok: false, error: `loadTurnMediaRows: ${error.message}` }
    // A failed attachment read does NOT fail the turn's rows: the kinds are
    // then read off the links, which is what happened before the table
    // existed. Logged, because the line may then say "a photo or GIF" for a
    // voice note.
    if (attachments.error) {
      console.warn('[agent] turn attachment kinds not loaded', {
        guestId: input.guestId,
        error: attachments.error.message,
      })
    }
    const kindsByMessage = new Map<string, AttachmentKind[]>()
    for (const row of attachments.data ?? []) {
      if (!isAttachmentKind(row.kind)) continue
      const kinds = kindsByMessage.get(row.message_id)
      if (kinds) kinds.push(row.kind)
      else kindsByMessage.set(row.message_id, [row.kind])
    }
    const rows: TurnMediaRows = { inbound: [], outbound: [] }
    for (const row of data ?? []) {
      const createdAt = new Date(row.created_at)
      if (row.direction === 'inbound') {
        rows.inbound.push({
          id: row.id,
          body: row.body,
          mediaUrls: row.media_urls ?? [],
          createdAt,
          attachmentKinds: kindsByMessage.get(row.id) ?? [],
        })
      } else {
        rows.outbound.push({
          replyToMessageId: row.reply_to_message_id,
          createdAt,
        })
      }
    }
    return { ok: true, data: rows }
  } catch (e) {
    return {
      ok: false,
      error: `loadTurnMediaRows threw: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
