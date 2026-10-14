// TAC-582: should this reply be held because it was written around media the
// agent cannot see?
//
// The agent is told a guest sent a photo and that it cannot see it. Measured
// (TAC-582, 20 generations, two venues), it never described a photo it had
// not seen, and in 7 of 20 replies it told the guest "we can't see it on our
// end", which is false: the operator can. Two rewordings moved which false
// thing it said and not whether it said one. So the owner ruled (2026-10-11)
// to stop fixing it with words: the agent still drafts, and the draft is HELD
// for an operator, never auto-sent, whenever media is part of what it is
// answering.
//
// TAC-584: THE AGENT CAN NOW BE TOLD WHAT A PHOTO SHOWS, AND THE HOLD STAYS.
// A described attachment's line carries its description. The model that
// drafts is never shown the picture itself. The owner's ruling on that ticket
// is the same one: every media reply is held, at first. So this rule is
// unchanged, and handle-inbound also sets the flag directly on any turn it
// described media for, so the hold does not depend on this rule and the
// describe step continuing to pick out the same turns. A turn with no text
// never reaches this rule at all: its card is written by its own path.
//
// THE RULE, as ruled. Hold when either:
//   (a) the inbound being answered has text AND attachments, or
//   (b) it is text, and the guest's most recent earlier inbound was media-only
//       (or unsupported), with no outbound reaching the guest since.
//
// HOW IT IS READ HERE, in three places where the wording leaves a choice.
// Each one holds MORE than the narrowest reading, never less:
//
//   "attachments" in (a) includes the story a guest is replying to. It is an
//   attachment row on the message and the model is told it cannot see it.
//
//   (b) is read as "there is a media-only or unsupported message from the
//   guest that no outbound has reached them since", not only "the message
//   immediately before this one". They differ on photo, "hi", "is this one of
//   yours?": nothing reaches the guest for "hi" (it is held, or silenced
//   behind the photo's own card), and the narrowest reading would then let
//   the reply to the question auto-send, about the same photo. Unanswered
//   media stays in view until somebody answers.
//
// WHAT IT DOES NOT COVER, known and left for a ruling (found in review): an
// earlier message with text AND a photo, or a text reply to a story, is not
// "media-only", so once its own reply is held as a card, a follow-up text is
// NOT held by this rule and can auto-send about the same photo. Widening the
// walk to any unanswered inbound with media would close it and would hold
// more.
//
//   A photo that arrives just AFTER the text it belongs to (one burst, the
//   turn answers the text) is neither clause to the letter and is held: it is
//   unanswered media-only from the guest, which is the same test.
//
// "REACHING THE GUEST" is the thread's definition, the one lib/operator/thread.ts
// and migrations 043 and 044 share: an outbound row that is sending, sent or
// delivered and not pending review. A reply staff typed in the Instagram app
// counts; a held card does not.
//
// 14 DAYS BACK, the agent's history window. A photo older than that is not in
// the prompt, so there is nothing written around it to hold.
//
// A FAILED READ HOLDS. The cost is one card nobody needed. The other
// direction auto-sends exactly the reply this rule exists to stop, and does it
// silently. Reported through captureGuestMediaDegraded so it can be counted.
// loadMediaContextRows never throws.

import { captureGuestMediaDegraded } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'

import { DELIVERED_OUTBOUND_STATUSES } from './group-responses'

const LOOKBACK_DAYS = 14
const MS_PER_DAY = 24 * 60 * 60 * 1000
// Newest first, and the walk stops at the first outbound that reached the
// guest, so this only has to cover the stretch since the venue last spoke.
// When it does NOT cover that stretch (a full page with no such outbound in
// it), the answer is not known and the loader says so: see below.
const MAX_ROWS = 100

export interface MediaContextRow {
  id: string
  direction: 'inbound' | 'outbound'
  /** The row has words in it. Read on inbound rows only. */
  hasText: boolean
  /** An inbound row with media links, or Meta's unsupported flag. */
  hasMediaOrUnsupported: boolean
  /** An outbound row the guest received. Ignored on an inbound row. */
  reachedGuest: boolean
  createdAt: Date
}

export type MediaContextReason =
  /** (a): the message being answered carries attachments itself. */
  | 'attachments_on_message'
  /** (b): a media-only or unsupported message of theirs is still unanswered. */
  | 'unanswered_media'
  /** The rows could not be read. Held, for the reason in the header. */
  | 'lookup_failed'

export type MediaContextDecision =
  { hold: true; reason: MediaContextReason } | { hold: false; reason: null }

export interface MediaContextInput {
  /** The message this turn answers. */
  currentMessageId: string
  /** It has media links, attachment rows, or is a reply to a story. */
  currentHasAttachments: boolean
  /** This guest's recent rows, any order. Null when the read failed. */
  rows: readonly MediaContextRow[] | null
}

/**
 * The rule. Pure, and what the harness runs.
 *
 * Only ever called for a turn that has text to answer: a message with no text
 * is carded by its own path before this is reached.
 */
export function decideMediaContextHold(
  input: MediaContextInput,
): MediaContextDecision {
  if (input.currentHasAttachments) {
    return { hold: true, reason: 'attachments_on_message' }
  }
  if (input.rows === null) return { hold: true, reason: 'lookup_failed' }

  const newestFirst = [...input.rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )
  for (const row of newestFirst) {
    if (row.id === input.currentMessageId) continue
    if (row.direction === 'outbound') {
      // The venue has spoken since. Whatever the guest sent before this is
      // answered, by a person or by us, and is no longer what this reply is
      // written around.
      if (row.reachedGuest) return { hold: false, reason: null }
      continue
    }
    if (!row.hasText && row.hasMediaOrUnsupported) {
      return { hold: true, reason: 'unanswered_media' }
    }
  }
  return { hold: false, reason: null }
}

/**
 * This guest's recent rows for the rule above, or null when they could not be
 * read. Never throws.
 */
export async function loadMediaContextRows(input: {
  venueId: string
  guestId: string
  now: Date
  /**
   * The thread AS IT STOOD at this instant, inclusive. Unset in production,
   * where the turn is answering the newest message and "now" is the same
   * thing.
   *
   * IT IS WHAT MAKES A REPLAY FAITHFUL, and without it a replay inverts this
   * rule rather than approximating it. Measured on Le Mil's (2026-10-13):
   * replaying the described-video turn a day later, the newest row in the
   * thread is the venue's own answer TO THAT TURN, so the walk below stops at
   * an outbound that reached the guest and returns `hold: false` - while
   * production held the same turn under `media_context` and an operator
   * approved it. The rule was right both times; the input was not.
   *
   * A STRING, STRAIGHT FROM `created_at`: `Date` keeps milliseconds where
   * Postgres keeps microseconds, so a bound built by round-tripping one
   * truncates downward and excludes the row it came from. See
   * `loadTurnMediaRows`, where that cost a turn its own attachments.
   */
  untilIso?: string
}): Promise<MediaContextRow[] | null> {
  try {
    // THE 14 DAYS RUN BACK FROM THE TURN, not from today, and that matters
    // only when the two differ - a replay. Measured from `now` with `untilIso`
    // in the past, the two bounds cross for anything older than a fortnight:
    // `since` lands AFTER `until`, the query returns nothing, and an empty
    // result reads as "no unanswered media in the thread" when it means
    // "nothing was read at all". The walk below would then auto-send.
    const anchor =
      input.untilIso === undefined ? input.now : new Date(input.untilIso)
    const sinceIso = new Date(
      anchor.getTime() - LOOKBACK_DAYS * MS_PER_DAY,
    ).toISOString()
    let query = createAdminClient()
      .from('messages')
      .select(
        'id, direction, body, media_urls, unsupported_content, status, review_state, created_at',
      )
      .eq('venue_id', input.venueId)
      .eq('guest_id', input.guestId)
      .gte('created_at', sinceIso)
    if (input.untilIso !== undefined) {
      query = query.lte('created_at', input.untilIso)
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS)
    if (error) {
      await reportLookupFailed(input, error.message)
      return null
    }
    const rows: MediaContextRow[] = []
    for (const row of data ?? []) {
      if (row.direction !== 'inbound' && row.direction !== 'outbound') continue
      rows.push({
        id: row.id,
        direction: row.direction,
        hasText: row.body.trim() !== '',
        hasMediaOrUnsupported:
          (row.media_urls ?? []).length > 0 || row.unsupported_content === true,
        reachedGuest:
          DELIVERED_OUTBOUND_STATUSES.has(row.status) &&
          row.review_state !== 'pending',
        createdAt: new Date(row.created_at),
      })
    }
    // A full page with nothing in it that reached the guest: the stretch
    // since the venue last spoke runs past what was read, and an unanswered
    // photo could be on the far side of it. That is "not known", and falling
    // off the end of the walk would read it as "not held" (found in review).
    if (rows.length >= MAX_ROWS && !rows.some((row) => row.reachedGuest)) {
      await reportLookupFailed(input, 'row_cap_reached')
      return null
    }
    return rows
  } catch (e) {
    await reportLookupFailed(input, e instanceof Error ? e.message : String(e))
    return null
  }
}

function reportLookupFailed(
  input: { venueId: string; guestId: string },
  error: string,
): Promise<void> {
  console.warn('[agent] media context not read; the reply will be held', {
    guestId: input.guestId,
    error,
  })
  return captureGuestMediaDegraded({
    stage: 'media_context',
    reason: error,
    venueId: input.venueId,
    guestId: input.guestId,
    messageId: null,
    attachmentId: null,
    host: null,
  })
}
