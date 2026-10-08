// Measure how a venue's team texts, from the Instagram history import.
//
//   npm run derive-voice-profile -- --venue <slug>
//   npm run derive-voice-profile -- --venue <slug> --examples
//
// READ-ONLY. It reads the messages the import wrote (the ledger,
// instagram_backfill_messages, says which) and prints numbers. It writes one
// file, under measurement-runs/, which is gitignored. Nothing is stored on the
// venue: a person reads the numbers, approves them, and applies them.
//
// The reading itself, and what counts as a reply or a canned line, is
// scripts/lib/voice-profile.ts.
//
// --examples ALSO PRINTS MESSAGE TEXT: the team's own replies that could be
// shown to the model as examples, each with the guest message it answered.
// Without the flag no message text is printed. Candidates with a link, a
// handle, a long number or the guest's own name are left out, and a person
// approves the list line by line before any of it is stored.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAdminClient } from '@/lib/db/admin'
import { RUN_LOG_DIR } from './measurement/run-log'
import {
  BUBBLE_GAP_MS,
  CANNED_MIN_GUESTS,
  collectReplies,
  deriveVoiceProfile,
  exampleCandidates,
  measureCloses,
  wordCount,
  type ProfileMessage,
} from './lib/voice-profile'

const ID_CHUNK = 100
const ROW_PAGE = 1000

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const venueSlug = args[args.indexOf('--venue') + 1]
  if (!args.includes('--venue') || !venueSlug) {
    throw new Error(
      'usage: npm run derive-voice-profile -- --venue <slug> [--examples]',
    )
  }
  const showExamples = args.includes('--examples')

  const db = createAdminClient()
  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  const ledger: { message_id: string }[] = []
  for (let from = 0; ; from += ROW_PAGE) {
    const { data, error } = await db
      .from('instagram_backfill_messages')
      .select('message_id')
      .eq('venue_id', venue.id)
      .order('message_id')
      .range(from, from + ROW_PAGE - 1)
    if (error) throw new Error(`ledger read failed: ${error.message}`)
    ledger.push(...(data ?? []))
    if ((data ?? []).length < ROW_PAGE) break
  }
  if (ledger.length === 0) {
    console.log(
      `[voice-profile] ${venueSlug}: the import has written no messages. Nothing to measure.`,
    )
    process.exit(1)
  }

  const messages: ProfileMessage[] = []
  for (let i = 0; i < ledger.length; i += ID_CHUNK) {
    const ids = ledger.slice(i, i + ID_CHUNK).map((r) => r.message_id)
    const { data, error } = await db
      .from('messages')
      .select('guest_id, direction, body, created_at')
      .in('id', ids)
    if (error) throw new Error(`messages read failed: ${error.message}`)
    for (const row of data ?? []) {
      if (row.direction !== 'inbound' && row.direction !== 'outbound') continue
      messages.push({
        guestId: row.guest_id,
        direction: row.direction,
        body: row.body ?? '',
        at: new Date(row.created_at),
      })
    }
  }

  const outbound = messages.filter((m) => m.direction === 'outbound').length
  const { replies, dropped } = collectReplies(messages)
  const closes = measureCloses(messages)
  const profile = {
    ...deriveVoiceProfile(replies),
    closes: {
      seen: closes.seen,
      unansweredShare:
        closes.seen === 0
          ? 0
          : Math.round((closes.unanswered / closes.seen) * 1000) / 1000,
    },
  }

  console.log(`[voice-profile] ${venueSlug}`)
  console.log(
    `  imported: ${messages.length} messages, ${outbound} from the venue, ${new Set(messages.map((m) => m.guestId)).size} guests`,
  )
  console.log(
    `  measured: ${profile.replies} replies (${profile.bubbles} messages) to ${profile.guests} guests`,
  )
  console.log(
    `  left out: ${dropped.canned} replies with a line sent to ${CANNED_MIN_GUESTS}+ guests; ${dropped.venueWroteFirst} runs with no guest message in front (a new reply starts after a ${BUBBLE_GAP_MS / 60_000}-minute pause)`,
  )
  const w = profile.wordsPerReply
  const b = profile.wordsPerBubble
  console.log('\n  LENGTH, in words')
  console.log(
    `    per reply:   median ${w.median}, p75 ${w.p75}, p90 ${w.p90}, longest ${w.max}`,
  )
  console.log(
    `    per message: median ${b.median}, p75 ${b.p75}, p90 ${b.p90}, longest ${b.max}`,
  )
  console.log('\n  SPLITTING')
  console.log(
    `    ${pct(profile.splitShare)} of replies went out as more than one message`,
  )
  console.log(
    `    messages per reply: ${Object.entries(profile.bubblesPerReply)
      .sort((x, y) => Number(x[0]) - Number(y[0]))
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')}`,
  )
  console.log('\n  EMOJI')
  console.log(
    `    ${pct(profile.emojiShareOfReplies)} of replies have one, ${pct(profile.emojiShareOfBubbles)} of messages`,
  )
  console.log(
    `    a typed smiley like :) is in ${pct(profile.smileyShareOfBubbles)} of messages`,
  )
  console.log('\n  STYLE')
  console.log(
    `    start lowercase: ${pct(profile.lowercaseStartShare)} of messages that start with a letter`,
  )
  const e = profile.endings
  console.log(
    `    a message ends with: nothing ${pct(e.nothing)}, a period ${pct(e.period)}, ! ${pct(e.exclamation)}, ? ${pct(e.question)}, an emoji ${pct(e.emoji)}, other ${pct(e.other)}`,
  )
  const k = profile.marks
  console.log(
    `    contain: an exclamation mark ${pct(k.exclamation)}, a bracket ${pct(k.parenthesis)}, a dash ${pct(k.dash)}`,
  )
  console.log(
    `    first words: ${profile.openers.map((o) => `${o.word} ${pct(o.share)}`).join(', ')}`,
  )

  console.log(
    '\n  CLOSES: a bare "ok", "thanks" or emoji after a message of the team\'s',
  )
  console.log(
    `    ${closes.seen} seen, ${closes.unanswered} left with no reply (${pct(profile.closes.unansweredShare)})`,
  )
  for (const [kind, k] of Object.entries(closes.byKind)) {
    console.log(`    ${kind}: ${k.unanswered} of ${k.seen} unanswered`)
  }

  mkdirSync(RUN_LOG_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(RUN_LOG_DIR, `voice-profile-${venueSlug}-${stamp}.json`)
  writeFileSync(
    path,
    JSON.stringify(
      {
        venue: venueSlug,
        derivedAt: new Date().toISOString(),
        bubbleGapMs: BUBBLE_GAP_MS,
        cannedMinGuests: CANNED_MIN_GUESTS,
        imported: { messages: messages.length, outbound },
        dropped,
        profile,
      },
      null,
      2,
    ),
  )
  console.log(`\n  written: ${path}`)

  if (showExamples) {
    const guestIds = [...new Set(replies.map((r) => r.guestId))]
    const names = new Map<string, string[]>()
    for (let i = 0; i < guestIds.length; i += ID_CHUNK) {
      const { data, error } = await db
        .from('guests')
        .select('id, first_name, last_name, instagram_username')
        .in('id', guestIds.slice(i, i + ID_CHUNK))
      if (error) throw new Error(`guests read failed: ${error.message}`)
      for (const g of data ?? []) {
        names.set(
          g.id,
          [g.first_name, g.last_name, g.instagram_username].filter(
            (x): x is string => typeof x === 'string' && x.trim() !== '',
          ),
        )
      }
    }
    const candidates = exampleCandidates(replies, profile, names)
    console.log(
      `\n  EXAMPLE CANDIDATES: ${candidates.length} of ${replies.length} replies. Guest message, then the team's reply.`,
    )
    candidates.forEach((r, i) => {
      console.log(
        `  ${String(i + 1).padStart(3)}. (${wordCount(r.bubbles.join(' '))}w) guest: ${JSON.stringify(r.inbound.slice(0, 140))}`,
      )
      console.log(
        `       team:  ${r.bubbles.map((x) => JSON.stringify(x)).join(' + ')}`,
      )
    })
  }
  process.exit(0)
}

main().catch((e: unknown) => {
  console.error('[voice-profile] crashed:', e instanceof Error ? e.message : e)
  process.exit(2)
})
