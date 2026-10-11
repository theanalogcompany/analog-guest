// TAC-582: the pure half of `backfill-instagram-contacts --attachments-only`.
//
// The history import (TAC-515) asked Meta for a message's text and nothing
// else, so no imported row has an attachment. This mode goes back for them:
// it lists the venue's conversations again with the media fields, matches
// Meta's message ids to rows we ALREADY hold, and writes `message_attachments`
// rows for those. IT NEVER WRITES A MESSAGE ROW (ruled 2026-10-11).
//
// Everything that DECIDES is here, for the reason the import's own planner is
// split out: the entry script runs the same plan for --dry-run and --confirm,
// so a dry run cannot describe a backfill the real run would not make.
//
// WHAT THAT RULE LEAVES BEHIND, and why it is counted. The import skipped
// every message with no text, and on Instagram a photo, a voice note or a reel
// is normally a message of its own. Those have no row to hang an attachment
// on. `metaOnly` is that number, by kind: it is what a later import of
// media-only messages would be deciding about.
//
// THE CONTROL. Meta does not document the media fields on this path, and a
// request that silently returned none would print a clean "nothing found".
// Rows the live WEBHOOK stored with attachments are the thing that can
// disagree: Meta sent us their media once, so the listing must show it again.
//
// No `@/` import that constructs a client: types and pure helpers only.

import {
  type AttachmentKind,
  type AttachmentStatus,
  type ParsedAttachment,
  initialStatusFor,
  kindFromInstagramType,
  kindFromMimeType,
} from '@/lib/messaging/attachments/kind'
import type {
  ConversationMessage,
  GraphMessageMedia,
} from '@/lib/messaging/instagram/fetch-conversations'

import type {
  CheckVerdict,
  MessageDirection,
} from './backfill-instagram-contacts'

/**
 * A share's `provider_type`, read off its link (ruled 2026-10-11): Meta's
 * conversation API names no type, and `ig_reel` is what makes a share read as
 * a reel to the operator and the model (isReelProviderType). Anything else is
 * null rather than a guess.
 */
export function shareProviderType(link: string | null): string | null {
  if (link === null) return null
  let path: string
  try {
    path = new URL(link).pathname
  } catch {
    return null
  }
  if (/\/reels?\//.test(path)) return 'ig_reel'
  if (/\/p\//.test(path)) return 'ig_post'
  return null
}

/**
 * Meta's conversation shape to the rows the webhook would have written, in
 * the webhook's order: files, shares, the guest's story mention, and last the
 * venue's story being replied to (parse-events.ts parseAttachments).
 *
 * `providerType` is null for everything but a share. The webhook stores
 * Meta's own name for the attachment there, and this API gives none.
 */
export function attachmentsFromGraphMedia(
  media: GraphMessageMedia,
): ParsedAttachment[] {
  const attachments: ParsedAttachment[] = []
  for (const file of media.files) {
    const kind: AttachmentKind =
      file.source === 'image_data'
        ? kindFromInstagramType('image', file.url)
        : file.source === 'video_data'
          ? 'video'
          : kindFromMimeType(file.mimeType)
    attachments.push({ kind, providerType: null, url: file.url, title: null })
  }
  for (const share of media.shares) {
    attachments.push({
      kind: 'share',
      providerType: shareProviderType(share.link),
      url: share.link,
      title: share.name,
    })
  }
  if (media.storyMention !== null)
    attachments.push({
      kind: 'story_mention',
      providerType: null,
      url: media.storyMention.link,
      title: null,
    })
  if (media.storyReply !== null)
    attachments.push({
      kind: 'story_reply',
      providerType: null,
      url: media.storyReply.link,
      title: null,
    })
  return attachments
}

export type KindCounts = Record<AttachmentKind, number>

export function emptyKindCounts(): KindCounts {
  return {
    image: 0,
    gif: 0,
    video: 0,
    audio: 0,
    file: 0,
    share: 0,
    story_mention: 0,
    story_reply: 0,
    unknown: 0,
  } satisfies Record<AttachmentKind, number>
}

export type StatusCounts = Record<AttachmentStatus, number>

function emptyStatusCounts(): StatusCounts {
  return {
    pending: 0,
    ready: 0,
    link_only: 0,
    expired: 0,
    failed: 0,
  } satisfies Record<AttachmentStatus, number>
}

/** One of our rows, as the plan needs it. */
export type StoredInstagramRow = {
  id: string
  guestId: string
  direction: string
  /** On the import's ledger, i.e. the import wrote it and not the webhook. */
  imported: boolean
  /** The kinds of the attachment rows it already has. Empty for none. */
  storedKinds: readonly string[]
  /** Its guest was erased by a deletion request (a tombstoned scoped id). */
  guestErased: boolean
}

/** What happened to one of our rows. Every row lands in exactly one. */
export type RowOutcome =
  /** Attachments found at Meta and no rows of ours for them yet. */
  | 'to_write'
  /** Meta listed the message with nothing but its text. */
  | 'no_attachments'
  | 'already_has_rows'
  | 'guest_erased'
  /** Only the id came back, and Meta refused the fetch by id. */
  | 'detail_unavailable'
  /**
   * Not in any conversation's listed messages. Meta gives details for a
   * conversation's 20 most recent only, so this is "too old", plus any row
   * whose conversation Meta no longer lists or we could not read.
   */
  | 'too_old'

export function emptyRowOutcomes(): Record<RowOutcome, number> {
  return {
    to_write: 0,
    no_attachments: 0,
    already_has_rows: 0,
    guest_erased: 0,
    detail_unavailable: 0,
    too_old: 0,
  } satisfies Record<RowOutcome, number>
}

export type PlannedAttachmentWrite = {
  messageId: string
  guestId: string
  attachments: ParsedAttachment[]
}

/** Messages at Meta, by who sent them. `unknown` is neither side. */
export type SenderCounts = Record<MessageDirection | 'unknown', number>

export type AttachmentsPlan = {
  toWrite: PlannedAttachmentWrite[]
  rowOutcomes: Record<RowOutcome, number>
  /** The rows this run looked for, split the way the report prints them. */
  rowsByOrigin: {
    importedInbound: number
    importedOutbound: number
    liveInbound: number
    liveOutbound: number
  }
  /** Attachments on `toWrite`, by kind and by the status each is written with. */
  foundByKind: KindCounts
  foundByStatus: StatusCounts
  /** Of the `to_write` messages, by direction. */
  toWriteByDirection: Record<string, number>
  /** Our rows Meta flags `is_unsupported`. Reported only: that is a column on `messages`. */
  unsupportedOnOurRows: number
  metaOnly: {
    /** Messages at Meta carrying media, or flagged unsupported, with no row of ours. */
    messagesWithMedia: number
    bySender: SenderCounts
    /** Of those, the ones that also had text. */
    withText: number
    attachmentsByKind: KindCounts
    /** Flagged `is_unsupported` and carrying nothing else. */
    unsupportedOnly: number
    /** Text only and no row of ours: what the import's skip rules left out. */
    messagesWithoutMedia: number
    /** No row of ours, and Meta refused the fetch by id: contents unknown. */
    detailUnavailable: number
  }
  /** Messages Meta listed that matched a row, counted once. */
  matched: number
  /** The same Meta id listed twice. Counted, and acted on once. */
  duplicateIds: number
  control: {
    /** Webhook rows with stored attachments that Meta listed. */
    seen: number
    /** Of those, the ones Meta returned with at least one attachment. */
    withMedia: number
    /** Of those, the ones whose kinds are exactly the kinds we stored. */
    sameKinds: number
    /** Stored kinds on control rows Meta returned with NO media. */
    emptyByStoredKind: Record<string, number>
    /** Where the kinds differed: "stored image → found video", and how often. */
    kindMismatches: Record<string, number>
  }
  /**
   * Where the links point, as `kind host` (and for a share, the provider type
   * read off its path). Host names only: a link's path and query are what make
   * it work and are never kept here. Counted over EVERY attachment Meta
   * listed, with a row of ours or without.
   */
  linkHosts: Record<string, number>
  /** Every key name seen under the media fields. Names only. */
  keyPaths: string[]
}

export function emptyAttachmentsPlan(): AttachmentsPlan {
  return {
    toWrite: [],
    rowOutcomes: emptyRowOutcomes(),
    rowsByOrigin: {
      importedInbound: 0,
      importedOutbound: 0,
      liveInbound: 0,
      liveOutbound: 0,
    },
    foundByKind: emptyKindCounts(),
    foundByStatus: emptyStatusCounts(),
    toWriteByDirection: {},
    unsupportedOnOurRows: 0,
    metaOnly: {
      messagesWithMedia: 0,
      bySender: { inbound: 0, outbound: 0, unknown: 0 },
      withText: 0,
      attachmentsByKind: emptyKindCounts(),
      unsupportedOnly: 0,
      messagesWithoutMedia: 0,
      detailUnavailable: 0,
    },
    matched: 0,
    duplicateIds: 0,
    control: {
      seen: 0,
      withMedia: 0,
      sameKinds: 0,
      emptyByStoredKind: {},
      kindMismatches: {},
    },
    linkHosts: {},
    keyPaths: [],
  }
}

function hostLabel(attachment: ParsedAttachment): string {
  let host = '(no link)'
  if (attachment.url !== null) {
    try {
      host = new URL(attachment.url).hostname.toLowerCase()
    } catch {
      host = '(unparseable link)'
    }
  }
  return attachment.kind === 'share'
    ? `${attachment.kind} ${host} (${attachment.providerType ?? 'no provider type'})`
    : `${attachment.kind} ${host}`
}

/**
 * Accumulates the plan one Meta message at a time, so the entry script can
 * page through conversations without holding them. `finish` settles the rows
 * Meta never listed.
 */
export function createAttachmentsPlanner(
  rowsByMid: ReadonlyMap<string, StoredInstagramRow>,
): {
  /** `direction` is who sent it, as the import derives it, or null. */
  add: (
    message: ConversationMessage,
    direction: MessageDirection | null,
  ) => void
  finish: () => AttachmentsPlan
} {
  const plan = emptyAttachmentsPlan()
  const seenMids = new Set<string>()
  const keyPaths = new Set<string>()

  function add(
    message: ConversationMessage,
    direction: MessageDirection | null,
  ): void {
    if (seenMids.has(message.id)) {
      plan.duplicateIds += 1
      return
    }
    seenMids.add(message.id)
    for (const path of message.media.keyPaths) keyPaths.add(path)

    const attachments = attachmentsFromGraphMedia(message.media)
    const row = rowsByMid.get(message.id)
    for (const attachment of attachments) {
      const label = hostLabel(attachment)
      plan.linkHosts[label] = (plan.linkHosts[label] ?? 0) + 1
    }

    if (row === undefined) {
      if (message.needsDetail) {
        plan.metaOnly.detailUnavailable += 1
        return
      }
      if (attachments.length === 0 && !message.media.unsupported) {
        plan.metaOnly.messagesWithoutMedia += 1
        return
      }
      plan.metaOnly.messagesWithMedia += 1
      plan.metaOnly.bySender[direction ?? 'unknown'] += 1
      if (message.text !== null) plan.metaOnly.withText += 1
      if (attachments.length === 0) plan.metaOnly.unsupportedOnly += 1
      for (const attachment of attachments)
        plan.metaOnly.attachmentsByKind[attachment.kind] += 1
      return
    }

    plan.matched += 1
    if (row.guestErased) {
      plan.rowOutcomes.guest_erased += 1
      return
    }
    // Before anything that reads `media`: a bare id carries none, and reading
    // its empty media as "no attachments" would be a claim nothing checked.
    if (message.needsDetail) {
      plan.rowOutcomes.detail_unavailable += 1
      return
    }
    if (row.storedKinds.length > 0) {
      plan.rowOutcomes.already_has_rows += 1
      // Only a row the WEBHOOK stored is evidence. One this mode wrote on an
      // earlier run holds what this same parser read, and would agree with
      // itself whatever Meta returned.
      if (!row.imported) {
        plan.control.seen += 1
        if (attachments.length > 0) {
          plan.control.withMedia += 1
          const stored = [...row.storedKinds].sort().join('+')
          const found = attachments
            .map((attachment) => attachment.kind)
            .sort()
            .join('+')
          if (stored === found) plan.control.sameKinds += 1
          else {
            const label = `stored ${stored} → found ${found}`
            plan.control.kindMismatches[label] =
              (plan.control.kindMismatches[label] ?? 0) + 1
          }
        } else {
          for (const kind of row.storedKinds)
            plan.control.emptyByStoredKind[kind] =
              (plan.control.emptyByStoredKind[kind] ?? 0) + 1
        }
      }
      return
    }
    if (message.media.unsupported) plan.unsupportedOnOurRows += 1
    if (attachments.length === 0) {
      plan.rowOutcomes.no_attachments += 1
      return
    }
    plan.rowOutcomes.to_write += 1
    plan.toWriteByDirection[row.direction] =
      (plan.toWriteByDirection[row.direction] ?? 0) + 1
    for (const attachment of attachments) {
      plan.foundByKind[attachment.kind] += 1
      plan.foundByStatus[initialStatusFor(attachment.kind, attachment.url)] += 1
    }
    plan.toWrite.push({
      messageId: row.id,
      guestId: row.guestId,
      attachments,
    })
  }

  function finish(): AttachmentsPlan {
    for (const [mid, row] of rowsByMid) {
      const inbound = row.direction === 'inbound'
      if (row.imported) {
        if (inbound) plan.rowsByOrigin.importedInbound += 1
        else plan.rowsByOrigin.importedOutbound += 1
      } else if (inbound) plan.rowsByOrigin.liveInbound += 1
      else plan.rowsByOrigin.liveOutbound += 1
      if (!seenMids.has(mid)) plan.rowOutcomes.too_old += 1
    }
    plan.keyPaths = [...keyPaths].sort()
    return plan
  }

  return { add, finish }
}

export type ControlCheck = { verdict: CheckVerdict; detail: string }

/**
 * Pure. Whether the media fields demonstrably came back.
 *
 * FAIL is the shape a request that returns no media would produce: we HAD
 * rows whose media Meta once sent us, Meta listed those messages, and not one
 * came back with any. --confirm refuses on it. Some-but-not-all is PASS with
 * the gap spelled out, because one kind this parser cannot read (a story
 * mention, say) is a narrower fact than "the request is not working".
 */
export function controlCheck(
  control: AttachmentsPlan['control'],
): ControlCheck {
  if (control.seen === 0)
    return {
      verdict: 'INCONCLUSIVE',
      detail:
        'Meta listed no message that the webhook stored with attachments, so nothing here could contradict an empty result',
    }
  const empty = Object.entries(control.emptyByStoredKind)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ')
  if (control.withMedia === 0)
    return {
      verdict: 'FAIL',
      detail: `${control.seen} message(s) the webhook stored with attachments were listed, and Meta returned media on none of them (stored kinds: ${empty}): the media fields are not coming back`,
    }
  const mismatches = Object.entries(control.kindMismatches)
    .map(([label, count]) => `${label} (${count})`)
    .join('; ')
  return {
    verdict: 'PASS',
    detail:
      `${control.withMedia} of ${control.seen} message(s) the webhook stored with attachments came back with media; ${control.sameKinds} with exactly the kinds we stored` +
      (mismatches !== '' ? `. KINDS DIFFER: ${mismatches}` : '') +
      (control.withMedia < control.seen
        ? `. NOT RETURNED for stored kinds: ${empty}. This run cannot find those kinds on older messages either`
        : ''),
  }
}
