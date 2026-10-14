// What a guest's photos, voice notes, stories and shares do to a v2 turn.
//
// THE DEFECT THIS CLOSES. v2 was text-only: `runTurn` selected `body` and
// dropped every row whose body was empty, so a guest's photo was invisible to
// the engine - not mentioned on the turn it arrived, not in the transcript an
// hour later, and nothing holding the reply. v1 has had all three since
// TAC-574/582/584. At Le Mil's that is not a corner: every one of the 120
// attachments on the venue is on a message with NO TEXT, so v2 read those
// turns as a guest who wrote nothing at all.
//
// NOTHING HERE IS NEW BEHAVIOUR, AND ALMOST NOTHING HERE IS NEW CODE. Every
// rule and every sentence is v1's, imported:
//
//   which lines a turn produces   turnMediaPromptLines (attachment-lines.ts)
//   how a line reads              mediaLine / describedHistoryLine /
//                                 describedMediaLine / unclearMediaLine, all
//                                 owner-approved verbatim on TAC-582 and -584
//   which messages a turn answers mediaMessageIdsForTurn, mediaAlongsideText,
//                                 repliesToStory (inbound-media.ts)
//   whether the reply is held     decideMediaContextHold (media-context.ts)
//   what the window's media says  loadTurnMediaHistory (media-history.ts)
//   what may be named            nameableItems, usableDescription
//                                 (lib/schemas/attachment-description.ts)
//
// This file is the v2-shaped assembly of those, and it is the only thing v2
// adds. If a rule reads wrong here, it reads wrong in v1 too, which is the
// property worth having.
//
// THE DESCRIBE STEP IS NOT CALLED FROM HERE, deliberately. It makes a vision
// call and writes `message_attachments`; `run-turn.ts` reads production data
// and writes nothing, and a measurement harness running hundreds of samples
// must not spend vision calls or settle rows. So v2 READS what the describe
// step recorded - the same posture v1 takes on a test run, where it skips
// describing and a replay behaves as it did. Running it on the live v2 path is
// phase 6, in the position v1 has it (handle-inbound.ts, before generation,
// awaited), not here.
//
// TWO DIFFERENCES FROM v1, both deliberate and both stated at the code:
//
//   1. A turn with media and NO TEXT. v1 writes a blank operator card (or a
//      card carrying a draft, once the media is described) and never reaches
//      an ordinary prompt. v2 has no card path of its own yet: it drafts, and
//      the gate holds it. So an undescribed media-only turn is given the lines
//      history would show for that message - `fallbackLines` in
//      turnMediaPromptLines - rather than nothing at all, which would be a
//      prompt with no inbound in it.
//   2. The description-on-a-held-turn rule is resolved HERE, pre-generation,
//      from the same decision the gate is handed. v1 resolves it in
//      handle-inbound after classification (showDescribedHistory). Same rule,
//      same fact behind it: a described line only exists on a turn that is
//      held, so no auto-sendable reply is ever written from a description.
//
// FAILURE DIRECTION, inherited rather than chosen: an unreadable row HOLDS
// (media-context.ts says why - the other direction auto-sends exactly the
// reply the rule exists to stop, silently). History lines fail SOFT to none,
// with `degraded` on the trace so "we did not look" is not read as "the guest
// sent nothing".
//
// NEVER THROWS. It is awaited inside a turn.

import {
  loadTurnMediaRows,
  mediaAlongsideText,
  mediaKindFromUrls,
  mediaMessageIdsForTurn,
  repliesToStory,
  type TurnInboundRow,
  type TurnMediaRows,
} from '@/lib/agent/inbound-media'
import {
  decideMediaContextHold,
  loadMediaContextRows,
  type MediaContextDecision,
} from '@/lib/agent/media-context'
import {
  loadTurnMediaHistory,
  type MediaOnlyPromptMessage,
} from '@/lib/agent/media-history'
import {
  describedWordFor,
  historyAttachmentLines,
  turnMediaPromptLines,
} from '@/lib/ai/prompts/attachment-lines'
import type {
  DescribedMediaWord,
  InboundDescribedMedia,
  InboundMediaKind,
} from '@/lib/ai/types'
import { createAdminClient } from '@/lib/db/admin'
import {
  isAttachmentKind,
  type AttachmentKind,
} from '@/lib/messaging/attachments/kind'
import {
  nameableItems,
  parseDescriptionMeta,
  usableDescription,
} from '@/lib/schemas/attachment-description'

export interface TurnMedia {
  /** Lines above the guest's words this turn: the story they are replying to. */
  before: string[]
  /** Lines after them: what arrived, and the rules for replying to it. */
  after: string[]
  /**
   * The bracketed lines for a history message, by message id, with the
   * described-or-not question ALREADY SETTLED by `hold`. A renderer picks
   * nothing; it joins what is here.
   */
  historyLines: Map<string, string[]>
  /**
   * The guest's messages with no text at all, which v2's transcript query
   * drops. Lines already settled, same as above.
   */
  mediaOnly: MediaOnlyPromptMessage[]
  /** v1's media_context rule over this thread, verbatim. */
  hold: MediaContextDecision
  /** A read failed and the lines are thinner for it, not the thread. */
  degraded: boolean
  /** What this turn's media is, for the trace. Null when it carries none. */
  kind: InboundMediaKind | null
  storyReply: boolean
  /** This turn's attachments that have a description on file. */
  described: InboundDescribedMedia[]
}

export const NO_TURN_MEDIA: TurnMedia = {
  before: [],
  after: [],
  historyLines: new Map(),
  mediaOnly: [],
  hold: { hold: false, reason: null },
  degraded: false,
  kind: null,
  storyReply: false,
  described: [],
}

/**
 * InboundMediaKind back to the attachment kind whose history line words it.
 *
 * ONLY FOR A DECLARED TURN - a sandbox or golden scenario states "a photo"
 * and has no rows behind it, while `historyAttachmentLines` is keyed by what a
 * row says. A loaded turn never comes through here: its lines are built from
 * its real rows.
 *
 * `satisfies Record` so a new kind cannot arrive without an answer.
 */
const ATTACHMENT_KIND_BY_MEDIA_KIND = {
  photo: 'image',
  gif: 'gif',
  video: 'video',
  voice_note: 'audio',
  other: 'file',
  unknown: 'unknown',
} as const satisfies Record<InboundMediaKind, AttachmentKind>

function describedWordForMediaKind(
  kind: InboundMediaKind,
): DescribedMediaWord | null {
  return describedWordFor(ATTACHMENT_KIND_BY_MEDIA_KIND[kind])
}

/** Media a caller STATES, with no rows behind it: a sandbox or golden turn. */
export interface DeclaredTurnMedia {
  /**
   * Attachment links on the guest's last message, as a golden scenario writes
   * them. Read for their file extension and nothing else, exactly as
   * production reads a link with no attachment row behind it.
   */
  mediaUrls?: readonly string[]
  /** States the kind outright, where a link's extension cannot (Instagram's). */
  kind?: InboundMediaKind
  /** As if the describe step had run and written this. */
  description?: string
  /** The menu items that description permits naming. */
  nameableItems?: readonly string[]
  /** The guest is replying to one of the venue's stories. */
  storyReply?: boolean
}

/**
 * A stated turn's media. Pure - no DB, no clock.
 *
 * IT HOLDS, like a loaded one. A sandbox turn that carried a photo and then
 * auto-sent would be a surface that disagrees with production about the one
 * rule every media reply has.
 */
export function declaredTurnMedia(
  media: DeclaredTurnMedia,
  hasText: boolean,
): TurnMedia {
  const kind = media.kind ?? mediaKindFromUrls(media.mediaUrls ?? [])
  const word = describedWordForMediaKind(kind)
  // A description for a kind nothing describes (a voice note, a share) is
  // dropped rather than worded: the describe step could not have produced it.
  const described: InboundDescribedMedia[] =
    media.description !== undefined && word !== null
      ? [
          {
            word,
            description: media.description,
            nameableItems: [...(media.nameableItems ?? [])],
          },
        ]
      : []
  const lines = turnMediaPromptLines({
    hasText,
    storyReply: media.storyReply === true,
    kind,
    described,
    fallbackLines: historyAttachmentLines({
      unsupported: false,
      hasMedia: true,
      attachments: [
        {
          kind: media.storyReply
            ? 'story_reply'
            : ATTACHMENT_KIND_BY_MEDIA_KIND[kind],
          providerType: null,
          title: null,
          description: null,
        },
      ],
    }),
  })
  return {
    ...lines,
    historyLines: new Map(),
    mediaOnly: [],
    hold: { hold: true, reason: 'attachments_on_message' },
    degraded: false,
    kind,
    storyReply: media.storyReply === true,
    described,
  }
}

export interface LoadTurnMediaInput {
  venueId: string
  guestId: string
  now: Date
  /**
   * The row this turn answers. Absent when the caller does not know which row
   * its inbound text came from, which is every caller but a replay: the
   * history half still runs, and clause (a) of the hold rule ("the message
   * being answered carries attachments") cannot fire because there is no
   * message to ask about. Clause (b) - unanswered media in the thread - does.
   */
  currentMessageId?: string
  /** The guest sent words this turn as well as whatever else. */
  hasText: boolean
  /**
   * When the message being answered arrived - `created_at` VERBATIM, not a
   * reformatted one - and therefore the instant the whole lane reads the
   * thread as of. Absent means now, which is what production means.
   *
   * It is not a nicety for replay, it is what makes a replayed decision the
   * same decision. Two things break without it, both measured on Le Mil's
   * (2026-10-13): `loadTurnMediaRows` reads a four-minute window around its
   * anchor, so a turn replayed a day later cannot see ITS OWN attachments -
   * the described video came back as "you can't watch it" - and the hold rule
   * walks a thread that now ends in the venue's answer to this very turn, so
   * it returned send where production held.
   *
   * VERBATIM MATTERS: `loadTurnMediaRows` says what a millisecond-truncated
   * bound costs.
   */
  asOfIso?: string
  /** The oldest message in the transcript v2 loaded, so the two cover one span. */
  historyCutoffIso: string
  /** At most this many media-only messages, newest kept. */
  maxMediaOnlyMessages: number
  /** The venue's menu, in its own spelling: what a reply may name. */
  menuItemNames: readonly string[]
}

/**
 * One guest's media, as this turn needs it. Never throws.
 *
 * Three reads concurrently - the window's attachment wording, the hold rule's
 * rows, the turn's own neighbourhood - and then one more, only for a turn that
 * names its inbound row: the metas of the attachments it is answering. That
 * last one is serial because it needs the first three to say WHICH messages
 * this turn answers, and it is skipped entirely otherwise.
 */
export async function loadTurnMedia(
  input: LoadTurnMediaInput,
): Promise<TurnMedia> {
  try {
    const supabase = createAdminClient()
    // The anchor for the four-minute companion window. Milliseconds are fine
    // HERE - this one is arithmetic on a window, not a row bound.
    const around =
      input.asOfIso === undefined ? input.now : new Date(input.asOfIso)
    const [history, contextRows, turnRows] = await Promise.all([
      loadTurnMediaHistory(supabase, {
        venueId: input.venueId,
        guestId: input.guestId,
        historyCutoffIso: input.historyCutoffIso,
        maxMessages: input.maxMediaOnlyMessages,
        ...(input.currentMessageId !== undefined
          ? { currentMessageId: input.currentMessageId }
          : {}),
        // Nothing the guest sent AFTER the message being answered is history
        // for it. The field exists for the Voices regen path, which pins
        // history for the same reason.
        ...(input.asOfIso !== undefined
          ? { historyEndIso: input.asOfIso }
          : {}),
      }),
      loadMediaContextRows({
        venueId: input.venueId,
        guestId: input.guestId,
        now: input.now,
        ...(input.asOfIso !== undefined ? { untilIso: input.asOfIso } : {}),
      }),
      input.currentMessageId === undefined
        ? Promise.resolve(null)
        : loadTurnMediaRows({
            venueId: input.venueId,
            guestId: input.guestId,
            // The message's own clock, not the wall clock: this window is
            // four minutes wide and the pairing rules inside it are about
            // what arrived beside the message being answered.
            around,
            ...(input.asOfIso !== undefined ? { untilIso: input.asOfIso } : {}),
          }),
    ])

    const rows: TurnMediaRows | null =
      turnRows !== null && turnRows.ok ? turnRows.data : null
    // The turn's own row, with the rows it was found in: the two pure
    // functions below read both, and carrying them as one pair is what keeps
    // this free of a non-null assertion on `rows`.
    const current: { self: TurnInboundRow; rows: TurnMediaRows } | null =
      input.currentMessageId === undefined || rows === null
        ? null
        : (() => {
            const self = rows.inbound.find(
              (row) => row.id === input.currentMessageId,
            )
            return self === undefined ? null : { self, rows }
          })()

    const kind =
      current === null ? null : mediaAlongsideText(current.self, current.rows)
    const storyReply =
      current === null ? false : repliesToStory(current.self, current.rows)
    const described =
      current === null
        ? []
        : await describedOnFile(
            supabase,
            mediaMessageIdsForTurn(current.self, current.rows),
            input.menuItemNames,
          )

    // v1's reading, verbatim (handle-inbound.ts): the message's own links, or
    // any attachment row on it - a reply to a story has a row and no link.
    const currentHasAttachments =
      current !== null &&
      (current.self.mediaUrls.length > 0 ||
        (current.self.attachmentKinds ?? []).length > 0)
    const hold = decideMediaContextHold({
      // '' never matches a row, which is what we want when the caller does not
      // know the id: the walk then skips nothing and judges the whole thread.
      currentMessageId: input.currentMessageId ?? '',
      currentHasAttachments,
      rows: contextRows,
    })

    // A ROW READ THAT FAILED HOLDS, and `loadTurnMediaRows` failing is one:
    // without it this turn cannot see its own attachments, so clause (a)
    // could not have fired whatever was on the message. `loadMediaContextRows`
    // already holds on its own failure by returning null.
    const turnRowsFailed = turnRows !== null && !turnRows.ok
    const heldForUnreadable: MediaContextDecision = turnRowsFailed
      ? { hold: true, reason: 'lookup_failed' }
      : hold

    const lines = turnMediaPromptLines({
      hasText: input.hasText,
      storyReply,
      kind,
      described,
      // The lines history shows for this very message - see the header's
      // difference 1. Empty when the turn has no media of its own, which is
      // when nothing should be said about any.
      fallbackLines:
        input.currentMessageId === undefined
          ? []
          : (history.linesByMessageId.get(input.currentMessageId) ?? []),
    })

    // THE DESCRIBED WORDING ONLY ON A HELD TURN (media-history.ts has the
    // ruling). Resolved once, here, from the decision the gate is handed.
    const held = heldForUnreadable.hold
    const historyLines = new Map<string, string[]>()
    for (const [messageId, plain] of history.linesByMessageId) {
      const describedLines = history.describedLinesByMessageId.get(messageId)
      historyLines.set(
        messageId,
        held && describedLines !== undefined ? describedLines : plain,
      )
    }
    const mediaOnly = history.mediaOnlyMessages.map((message) => ({
      ...message,
      attachmentLines:
        held && message.describedAttachmentLines !== undefined
          ? message.describedAttachmentLines
          : message.attachmentLines,
    }))

    return {
      ...lines,
      historyLines,
      mediaOnly,
      hold: heldForUnreadable,
      degraded: history.degraded || turnRowsFailed,
      kind,
      storyReply,
      described,
    }
  } catch (e) {
    // The hold is the failed-read one: this ran, it could not see, and the
    // reply waits for a human. Same direction as every other read here.
    console.warn('[v2] turn media not read; the reply will be held', {
      guestId: input.guestId,
      error: e instanceof Error ? e.message : String(e),
    })
    return {
      ...NO_TURN_MEDIA,
      hold: { hold: true, reason: 'lookup_failed' },
      degraded: true,
    }
  }
}

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * The descriptions already on file for the messages this turn answers.
 *
 * READS, NEVER DESCRIBES. `usableDescription` is the one gate on whether a
 * prompt may carry one (never described, skipped, and too unclear to make out
 * all come back null), and `nameableItems` is the one gate on which drinks a
 * reply may name - both shared with v1, so a drink v2 may name is a drink v1
 * may name.
 *
 * A ROW THE DESCRIBE STEP LOOKED AT AND COULD NOT MAKE OUT IS STILL AN ENTRY,
 * with a null description. That is v1's shape (describeTurnMedia) and it is
 * what `unclearMediaLine` needs to exist: on a turn with no text, "it arrived
 * and is too unclear to make out, thank them for it" is the only honest thing
 * to say, and dropping the entry would instead say "you can't see it".
 *
 * Fails open to none: an unreadable row is an undescribed row, which is the
 * "you can't see it" line and a held reply.
 */
async function describedOnFile(
  supabase: AdminClient,
  messageIds: readonly string[],
  menuItemNames: readonly string[],
): Promise<InboundDescribedMedia[]> {
  if (messageIds.length === 0) return []
  const { data, error } = await supabase
    .from('message_attachments')
    .select('message_id, kind, description, description_meta, position')
    .in('message_id', [...messageIds])
    .order('message_id', { ascending: true })
    .order('position', { ascending: true })
  if (error) {
    console.warn('[v2] turn attachments not read; nothing is described', {
      error: error.message,
    })
    return []
  }
  const media: InboundDescribedMedia[] = []
  for (const row of data ?? []) {
    const kind = isAttachmentKind(row.kind) ? row.kind : 'unknown'
    const word = describedWordFor(kind)
    if (word === null) continue
    // Looked at at all? A row with no meta, or one whose describe was skipped,
    // is not an entry - it is a photo nobody has seen, and its line says so.
    const meta = parseDescriptionMeta(row.description_meta)
    if (meta === null || meta.outcome !== 'described') continue
    const usable = usableDescription({
      description: row.description,
      descriptionMeta: row.description_meta,
    })
    media.push({
      word,
      description: usable?.description ?? null,
      nameableItems:
        usable === null ? [] : nameableItems(usable.meta, menuItemNames),
    })
  }
  return media
}
