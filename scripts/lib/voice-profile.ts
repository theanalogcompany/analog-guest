// How a venue's team actually texts, measured from the replies they sent.
//
// Ruled 2026-10-07: nothing about HOW a venue texts is written by us. Length,
// how often an answer is split into several messages, emoji, capitalisation,
// punctuation and openers are all read off the team's own Instagram replies
// (the history import, scripts/backfill-instagram-contacts.ts) and this file
// is the reading. Pure: rows in, numbers out. The script beside it does the
// database read.
//
// WHAT COUNTS AS A REPLY. A run of the venue's messages that follows a message
// from the guest. Each message in the run is a bubble. A run is cut where the
// venue paused longer than BUBBLE_GAP_MS, because a message an hour later is a
// follow-up and not the rest of the same answer. A run with no guest message
// in front of it (the venue wrote first, or Meta's 20-message window starts
// mid-thread) is not a reply and is left out.
//
// WHAT IS DROPPED AS CANNED. A bubble whose text, ignoring case, punctuation
// and emoji, went to CANNED_MIN_GUESTS or more different guests is a saved
// reply or an auto-responder, and a reply containing one is left out whole.
// It is how the app texts, not how the team does.
//
// THE TWO CONSTANTS BELOW ARE ANALYSIS CHOICES, not style. They decide what
// is measured, and the script prints how many replies each one removed so the
// choice can be argued with.

import {
  isAnsweringUs,
  pureCloseKind,
  type PureCloseKind,
} from '@/lib/agent/pure-close'
import type { VoiceProfile } from '@/lib/schemas'

/** A longer pause than this between two venue messages starts a new reply. */
export const BUBBLE_GAP_MS = 5 * 60_000

/** The same text to this many guests is a canned line. */
export const CANNED_MIN_GUESTS = 3

export interface ProfileMessage {
  guestId: string
  direction: 'inbound' | 'outbound'
  body: string
  at: Date
}

export interface TeamReply {
  guestId: string
  /** The guest message this answers. */
  inbound: string
  bubbles: string[]
  at: Date
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function wordCount(text: string): number {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

/** A typed smiley: ":)", ":-)", ";)", ":D", ":(" and the like. */
function hasSmiley(text: string): boolean {
  return /(^|[\s\p{L}\p{N}.!?,])[:;]-?[)(DPp]+(?=$|[\s.!?,])/u.test(text)
}

function hasEmoji(text: string): boolean {
  return /\p{Extended_Pictographic}/u.test(text)
}

/** Group one venue's messages into the team's replies to guests. */
export function collectReplies(messages: readonly ProfileMessage[]): {
  replies: TeamReply[]
  dropped: { venueWroteFirst: number; canned: number }
} {
  const byGuest = new Map<string, ProfileMessage[]>()
  for (const m of messages) {
    if (m.body.trim() === '') continue
    const list = byGuest.get(m.guestId) ?? []
    list.push(m)
    byGuest.set(m.guestId, list)
  }

  const all: TeamReply[] = []
  let venueWroteFirst = 0
  for (const [guestId, list] of byGuest) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime())
    let lastInbound: string | null = null
    let run: ProfileMessage[] = []
    const close = () => {
      if (run.length === 0) return
      if (lastInbound === null) venueWroteFirst += 1
      else {
        all.push({
          guestId,
          inbound: lastInbound,
          bubbles: run.map((m) => m.body.trim()),
          at: (run[0] as ProfileMessage).at,
        })
      }
      run = []
    }
    for (const m of list) {
      if (m.direction === 'inbound') {
        close()
        lastInbound = m.body.trim()
        continue
      }
      const previous = run[run.length - 1]
      if (
        previous !== undefined &&
        m.at.getTime() - previous.at.getTime() > BUBBLE_GAP_MS
      ) {
        close()
        // The later message is the venue following up, not answering.
        lastInbound = null
      }
      run.push(m)
    }
    close()
  }

  const guestsByText = new Map<string, Set<string>>()
  for (const r of all) {
    for (const b of r.bubbles) {
      const key = normalise(b)
      if (key === '') continue
      const set = guestsByText.get(key) ?? new Set<string>()
      set.add(r.guestId)
      guestsByText.set(key, set)
    }
  }
  const isCanned = (b: string) =>
    (guestsByText.get(normalise(b))?.size ?? 0) >= CANNED_MIN_GUESTS
  const replies = all.filter((r) => !r.bubbles.some(isCanned))
  return {
    replies,
    dropped: { venueWroteFirst, canned: all.length - replies.length },
  }
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  // Nearest rank: a value the team actually wrote, never an interpolation.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1] as number
}

function share(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 1000
}

export function deriveVoiceProfile(
  replies: readonly TeamReply[],
): VoiceProfile {
  const bubbles = replies.flatMap((r) => r.bubbles)
  const perReply = replies.map((r) => wordCount(r.bubbles.join(' ')))
  const perBubble = bubbles.map(wordCount)
  const spread = (v: readonly number[]) => ({
    median: percentile(v, 50),
    p75: percentile(v, 75),
    p90: percentile(v, 90),
    max: Math.max(0, ...v),
  })

  const bubblesPerReply: Record<string, number> = {}
  for (const r of replies) {
    const key = String(r.bubbles.length)
    bubblesPerReply[key] = (bubblesPerReply[key] ?? 0) + 1
  }

  const lettered = bubbles.filter((b) => /^\p{L}/u.test(b))
  const endings = {
    nothing: 0,
    period: 0,
    exclamation: 0,
    question: 0,
    emoji: 0,
    other: 0,
  }
  for (const b of bubbles) {
    const last = [...b.trimEnd()].pop() ?? ''
    if (/[\p{L}\p{N}]/u.test(last)) endings.nothing += 1
    else if (last === '.') endings.period += 1
    else if (last === '!') endings.exclamation += 1
    else if (last === '?') endings.question += 1
    else if (/\p{Extended_Pictographic}|\p{Emoji_Modifier}|️/u.test(last))
      endings.emoji += 1
    else endings.other += 1
  }

  const openerCounts = new Map<string, number>()
  for (const r of replies) {
    const first = (r.bubbles[0] ?? '')
      .toLowerCase()
      .match(/[\p{L}\p{N}']+/u)?.[0]
    if (first) openerCounts.set(first, (openerCounts.get(first) ?? 0) + 1)
  }
  const openers = [...openerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word, count]) => ({ word, share: share(count, replies.length) }))

  const n = bubbles.length
  return {
    replies: replies.length,
    bubbles: n,
    guests: new Set(replies.map((r) => r.guestId)).size,
    wordsPerReply: spread(perReply),
    wordsPerBubble: spread(perBubble),
    splitShare: share(
      replies.filter((r) => r.bubbles.length > 1).length,
      replies.length,
    ),
    bubblesPerReply,
    emojiShareOfReplies: share(
      replies.filter((r) => r.bubbles.some(hasEmoji)).length,
      replies.length,
    ),
    emojiShareOfBubbles: share(bubbles.filter(hasEmoji).length, n),
    smileyShareOfBubbles: share(bubbles.filter(hasSmiley).length, n),
    lowercaseStartShare: share(
      lettered.filter((b) => /^\p{Ll}/u.test(b)).length,
      lettered.length,
    ),
    endings: {
      nothing: share(endings.nothing, n),
      period: share(endings.period, n),
      exclamation: share(endings.exclamation, n),
      question: share(endings.question, n),
      emoji: share(endings.emoji, n),
      other: share(endings.other, n),
    },
    marks: {
      exclamation: share(bubbles.filter((b) => b.includes('!')).length, n),
      parenthesis: share(bubbles.filter((b) => /[()]/.test(b)).length, n),
      dash: share(bubbles.filter((b) => /[—–]| - /.test(b)).length, n),
    },
    openers,
  }
}

/**
 * Replies that could be shown to the model as examples of how the team texts.
 *
 * Chosen for shape, not content: inside the middle of the team's own length
 * range, with nothing in them that identifies a guest or would be copied as a
 * fact. A person approves the final list line by line; this only narrows it.
 */
export function exampleCandidates(
  replies: readonly TeamReply[],
  profile: VoiceProfile,
  guestNames: ReadonlyMap<string, readonly string[]>,
): TeamReply[] {
  const seen = new Set<string>()
  return replies.filter((r) => {
    const text = r.bubbles.join(' ')
    const words = wordCount(text)
    if (words < 2 || words > profile.wordsPerReply.p90) return false
    if (/https?:\/\/|www\.|@|\d{4,}/.test(text)) return false
    const names = guestNames.get(r.guestId) ?? []
    const folded = text.toLowerCase()
    if (
      names.some(
        (name) => name.length > 1 && folded.includes(name.toLowerCase()),
      )
    ) {
      return false
    }
    const key = normalise(text)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A reply this long after a close is the team writing again, not answering it. */
export const CLOSE_REPLY_WINDOW_MS = 24 * 60 * 60_000

/**
 * What the team did when a guest sent a pure close after one of their
 * messages: "ok", "thanks", a lone emoji. Counted with the same two functions
 * the inbound turn decides with (lib/agent/pure-close.ts), so the share
 * describes exactly the messages the agent would stay silent on.
 *
 * "Unanswered" means no message from the venue before the guest's next one,
 * or none within CLOSE_REPLY_WINDOW_MS. A reaction is not a message and is
 * not in the import, so a close the team hearted counts as unanswered.
 */
export function measureCloses(messages: readonly ProfileMessage[]): {
  seen: number
  unanswered: number
  byKind: Record<PureCloseKind, { seen: number; unanswered: number }>
} {
  const byGuest = new Map<string, ProfileMessage[]>()
  for (const m of messages) {
    if (m.body.trim() === '') continue
    const list = byGuest.get(m.guestId) ?? []
    list.push(m)
    byGuest.set(m.guestId, list)
  }
  const byKind: Record<PureCloseKind, { seen: number; unanswered: number }> = {
    ok: { seen: 0, unanswered: 0 },
    thanks: { seen: 0, unanswered: 0 },
    emoji_only: { seen: 0, unanswered: 0 },
  }
  for (const list of byGuest.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime())
    list.forEach((m, i) => {
      const before = list[i - 1]
      if (m.direction !== 'inbound' || before?.direction !== 'outbound') return
      const kind = pureCloseKind(m.body)
      if (kind === null || isAnsweringUs(before.body)) return
      const after = list[i + 1]
      const answered =
        after !== undefined &&
        after.direction === 'outbound' &&
        after.at.getTime() - m.at.getTime() <= CLOSE_REPLY_WINDOW_MS
      byKind[kind].seen += 1
      if (!answered) byKind[kind].unanswered += 1
    })
  }
  const kinds = Object.values(byKind)
  return {
    seen: kinds.reduce((n, k) => n + k.seen, 0),
    unanswered: kinds.reduce((n, k) => n + k.unanswered, 0),
    byKind,
  }
}
