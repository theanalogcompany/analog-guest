// TAC-575: do generated closes repeat across guests?
//
// The acceptance criterion is "no two guests (and no one guest twice) get the
// identical warm close". TAC-568 sent the close as a fixed string, which fails
// that by construction; TAC-575 has the model write it. This generates a pool
// of closes for different guests and counts repeats.
//
// GENERATE-ONLY. Nothing is sent and nothing is written, with the one exception
// every harness on this path reports on itself: buildRuntimeContext calls
// computeGuestState, which persists a guest_states row on a recognition-band
// change. Context is therefore built ONCE and reused for every unit, and the
// row count is printed before and after (the TAC-544 precedent).
//
// THE BAR, pre-registered on the ticket before any generation (2026-10-06) and
// evaluated in code by warm-close-variety-score.ts:
//
//   1. exact duplicates among the 20 closes: 0
//   2. no opening four words shared by more than a quarter of them
//
// THE POOL: 20 closes, 10 of each kind the pause timer sends.
//
//   plain   a first conversation that went quiet with no "good" check-in. Ten
//           guests who each asked one different question and got an answer.
//   happy   a guest who named their order, was asked how it is and said it is
//           good. Ten guests with different orders and different answers. The
//           close carries the review invitation.
//
// The pooled verdict is the pre-registered one. Each kind is also scored alone
// and printed as INFORMATION: a template can form inside one kind and hide in
// the mixed pool, and that is worth seeing even though it is not the bar.
//
// WHAT IT TAKES THE PRODUCTION PATH FOR, and what it does not. The prompt is
// production's: the real venue, its persona, its voice pack, its close text and
// review link, composed by buildAiRuntime and generateMessage with the trigger
// the pause timer hands over. What is constructed is each guest's HISTORY, and
// in it the venue's own earlier lines are written by hand, so they are the same
// shape in every unit. That is a pressure TOWARD repetition (the model sees
// near-identical threads), which is the conservative direction for this bar.
//
// WHAT IT CANNOT SHOW. Whether a close reads well, whether a happy sign-off
// asks for a rating, or whether one guest would get the same close twice (the
// close is once per guest; R41 covers a guest's own thread). It reports how
// many happy closes carried the link, because a sign-off without it is a
// finding in its own right, but that is not part of the bar.
//
// A FAILED UNIT IS NOT A RESULT (scripts/CLAUDE.md, convention 5). Any
// generation error voids the run, whatever the counts read.

import { randomUUID } from 'node:crypto'

import type {
  VoiceCorpusChunk as AiVoiceCorpusChunk,
  RecentMessage,
} from '@/lib/ai/types'
import { generateMessage } from '@/lib/ai'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { bodyContainsReviewLink } from '@/lib/agent/review-ask'
import { buildAiRuntime, retrieveCorpusStage } from '@/lib/agent/stages'
import type { RuntimeContext, SignOffKind } from '@/lib/agent/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { findReviewLink, parseVenueLinks } from '@/lib/schemas'
import { createRunLog } from './run-log'
import {
  MAX_OPENING_SHARE,
  OPENING_WORDS,
  scoreVariety,
  type VarietyVerdict,
} from './warm-close-variety-score'

const PER_KIND = 10

/** What ten different guests asked, and what we said. Plain closes follow these. */
const PLAIN_EXCHANGES: readonly { asked: string; answered: string }[] = [
  {
    asked: 'what time do you close today?',
    answered: "we're open till 3 today",
  },
  { asked: 'do you have oat milk?', answered: 'yep, oat and almond' },
  {
    asked: 'is there wifi?',
    answered: 'there is, the password is on the counter',
  },
  { asked: 'can i bring my dog?', answered: 'dogs are welcome out front' },
  {
    asked: 'do you sell beans to take home?',
    answered: 'we do, bags are on the shelf by the door',
  },
  {
    asked: 'is there parking nearby?',
    answered: 'street parking, usually easy before noon',
  },
  { asked: 'do you take card?', answered: 'card and tap, yes' },
  {
    asked: 'anything decaf?',
    answered: 'yes, any espresso drink can be decaf',
  },
  { asked: 'are you open on sundays?', answered: 'we are, same hours' },
  {
    asked: 'do you have somewhere to sit and work?',
    answered: 'a few tables inside, quieter after lunch',
  },
]

/** How ten different guests said their order is good. Happy closes follow these. */
const HAPPY_ANSWERS: readonly string[] = [
  'so good',
  'honestly really good',
  'love it',
  "it's great, thanks",
  'perfect, exactly what i needed',
  'amazing',
  'really nice actually',
  'delicious 😍',
  "best one i've had in a while",
  'yeah it is great',
]

interface Unit {
  id: string
  kind: SignOffKind
  history: RecentMessage[]
}

function turn(
  direction: 'inbound' | 'outbound',
  body: string,
  createdAt: Date,
): RecentMessage {
  return { direction, body, createdAt, delivery: 'delivered' } as RecentMessage
}

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const db = createAdminClient()

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, name, status')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  // Any real, non-opted-out Instagram guest. Only its id is used: everything a
  // close reads about the guest is overridden per unit below.
  const { data: candidates } = await db
    .from('guests')
    .select('id')
    .eq('venue_id', venue.id)
    .is('opted_out_at', null)
    .not('instagram_scoped_id', 'is', null)
    .limit(1)
  const guestId = candidates?.[0]?.id
  if (!guestId) {
    throw new Error(`need one non-opted-out Instagram guest at ${venueSlug}`)
  }

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const startedAt = new Date()
  const trace = startAgentTrace({
    name: 'tac575-warm-close-variety',
    agentRunId: randomUUID(),
  })

  // Built ONCE, as the pause timer's own trigger would build it.
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId,
    venueId: venue.id,
    trace,
    followupTrigger: {
      reason: 'warm_close',
      triggeredAt: startedAt,
      warmClose: { answersMessageId: randomUUID(), signOff: 'plain' },
    },
  })

  const reviewLink = findReviewLink(
    parseVenueLinks(baseCtx.venue.venueInfo.links),
  )
  if (reviewLink === null) {
    throw new Error(
      `${venueSlug} has no review link (kind: 'review' in venue_info.links); the happy arm cannot run`,
    )
  }
  if (baseCtx.venue.warmCloseText.trim() === '') {
    throw new Error(
      `${venueSlug} has no followup_rules.warm_close_text; production sends no plain close there, so the plain arm would measure a prompt it never composes`,
    )
  }
  const menuNames = baseCtx.venue.venueInfo.menu.items
    .map((i) => i.name)
    .filter((n) => n.trim().length > 0)
  if (menuNames.length === 0) throw new Error('venue has no menu items to name')

  // Each thread ends ten minutes before "now", the pause the timer waits out.
  const at = (minutesAgo: number): Date =>
    new Date(startedAt.getTime() - minutesAgo * 60_000)
  const units: Unit[] = [
    ...PLAIN_EXCHANGES.slice(0, PER_KIND).map((x, i) => ({
      id: `plain-${String(i + 1).padStart(2, '0')}`,
      kind: 'plain' as const,
      history: [
        turn('inbound', x.asked, at(12)),
        turn('outbound', x.answered, at(11)),
      ],
    })),
    ...HAPPY_ANSWERS.slice(0, PER_KIND).map((answer, i) => {
      const item = menuNames[i % menuNames.length]
      return {
        id: `happy-${String(i + 1).padStart(2, '0')}`,
        kind: 'happy' as const,
        history: [
          turn('outbound', 'hey, welcome in! what did you get?', at(16)),
          turn('inbound', `the ${item.toLowerCase()}`, at(15)),
          turn(
            'outbound',
            `nice, the ${item.toLowerCase()}. how is it so far?`,
            at(14),
          ),
          turn('inbound', answer, at(12)),
          turn('outbound', 'so glad to hear it', at(11)),
        ],
      }
    }),
  ]

  const log = createRunLog({
    name: 'tac575-warm-close-variety',
    meta: {
      arm: 'treatment-only',
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueName: venue.name,
      venueStatus: venue.status,
      guestId,
      units: units.length,
      perKind: PER_KIND,
      bars: {
        exactDuplicates: 0,
        openingWords: OPENING_WORDS,
        maxOpeningShare: MAX_OPENING_SHARE,
      },
      noControlArm:
        'There is no control: the comparison is against a bar fixed in advance, not against another prompt. The pre-TAC-575 behaviour was one fixed string, which fails bar 1 by construction.',
      constructed:
        "each unit's history, with the venue's earlier lines hand-written and near-identical across units",
    },
  })

  console.log(`[tac575] prompt=${PROMPT_VERSION}`)
  console.log(
    `[tac575] venue ${venueSlug} "${venue.name}" (status=${venue.status})`,
  )
  console.log(`[tac575] guest_states rows before: ${statesBefore}`)
  console.log(
    `[tac575] units: ${units.length} (${PER_KIND} plain, ${PER_KIND} happy)`,
  )
  console.log(`[tac575] run log: ${log.path}\n`)

  // The voice pack is static per venue, so one load serves every unit.
  const corpus = await retrieveCorpusStage(baseCtx)
  const ragChunks: AiVoiceCorpusChunk[] = corpus.map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))

  const closes: { id: string; kind: SignOffKind; body: string }[] = []
  const failed: { id: string; error: string }[] = []
  let happyWithLink = 0

  for (const unit of units) {
    const ctx: RuntimeContext = {
      ...baseCtx,
      // A fresh first-conversation guest with nothing on file, so no unit is
      // told a name or a history the others are not.
      guest: {
        ...baseCtx.guest,
        firstName: null,
        createdAt: at(20),
        firstContactedAt: at(20),
        reviewAskedAt: null,
        warmCloseSentAt: null,
      },
      recentMessages: unit.history,
      recentVisits: [],
      conversationChannel: 'instagram',
      firstConversation: true,
      openIntentions: [],
      pendingQuestion: null,
      corpus,
      knowledgeCorpus: [],
      signOff: unit.kind,
      reviewAsk:
        unit.kind === 'happy'
          ? { url: reviewLink.url, label: reviewLink.label }
          : null,
      // What handleFollowup synthesises for a warm_close trigger.
      classification: {
        category: 'acknowledgment',
        classifierConfidence: 1,
        reasoning: 'Followup trigger: warm_close',
        crisisSafety: false,
        correctsPendingReply: false,
        followUpWorthy: false,
        praisedExperience: false,
      },
    }

    const gen = await generateMessage({
      category: 'acknowledgment',
      persona: ctx.venue.brandPersona,
      venueInfo: ctx.venue.venueInfo,
      ragChunks,
      runtime: buildAiRuntime(ctx),
      channel: 'instagram',
    })

    if (!gen.ok) {
      failed.push({ id: unit.id, error: gen.error })
      log.appendUnit({
        id: unit.id,
        kind: unit.kind,
        failed: true,
        error: gen.error,
      })
      console.log(`  ${unit.id}  FAILED: ${gen.error}`)
      continue
    }

    const body = gen.data.body
    const linkCarried =
      unit.kind === 'happy' && bodyContainsReviewLink(body, reviewLink.url)
    if (linkCarried) happyWithLink += 1
    closes.push({ id: unit.id, kind: unit.kind, body })
    log.appendUnit({
      id: unit.id,
      kind: unit.kind,
      failed: false,
      body,
      reviewAsk: gen.data.reviewAsk,
      linkCarried: unit.kind === 'happy' ? linkCarried : null,
      attempts: gen.data.attempts,
      lastGuestLine: unit.history
        .filter((m) => m.direction === 'inbound')
        .at(-1)?.body,
    })
    console.log(`  ${unit.id}  ${JSON.stringify(body)}`)
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const printVerdict = (label: string, v: VarietyVerdict): void => {
    console.log(`\n[tac575] ${label}: ${v.total} closes`)
    console.log(
      `  exact duplicates: ${v.duplicateGroups.length} group(s)${v.duplicateGroups.map((g) => ` [${g.join(', ')}]`).join('')}`,
    )
    const top = v.openings[0]
    console.log(
      `  most-used opening: ${top ? `"${top.opening}" in ${top.unitIds.length}/${v.total} (${(top.share * 100).toFixed(0)}%)` : 'n/a'}`,
    )
    for (const o of v.overusedOpenings) {
      console.log(
        `  OVER ${MAX_OPENING_SHARE * 100}%: "${o.opening}" in ${o.unitIds.join(', ')}`,
      )
    }
    if (v.shortCloses.length > 0) {
      console.log(
        `  shorter than ${OPENING_WORDS} words: ${v.shortCloses.join(', ')}`,
      )
    }
  }

  const pooled = scoreVariety(closes)
  printVerdict('POOLED (the pre-registered bar)', pooled)
  printVerdict(
    'plain only (information)',
    scoreVariety(closes.filter((c) => c.kind === 'plain')),
  )
  printVerdict(
    'happy only (information)',
    scoreVariety(closes.filter((c) => c.kind === 'happy')),
  )

  const happyTotal = closes.filter((c) => c.kind === 'happy').length
  console.log(
    `\n[tac575] happy closes carrying the review link: ${happyWithLink}/${happyTotal} (not part of the bar)`,
  )
  console.log(
    `[tac575] guest_states rows before/after: ${statesBefore}/${statesAfter}`,
  )

  // Validity before verdict (conventions 5 and 6).
  if (failed.length > 0 || closes.length !== units.length) {
    console.log(
      `\n[tac575] RUN VOID: ${failed.length} unit(s) failed (${failed.map((f) => f.id).join(', ')}). A failed unit is not a result; no verdict.`,
    )
    log.appendUnit({ summary: true, void: true, failed })
    process.exit(2)
  }

  log.appendUnit({
    summary: true,
    void: false,
    pass: pooled.pass,
    duplicateGroups: pooled.duplicateGroups,
    overusedOpenings: pooled.overusedOpenings,
    happyWithLink,
    happyTotal,
    statesBefore,
    statesAfter,
  })
  console.log(`\n[tac575] VERDICT: ${pooled.pass ? 'PASS' : 'FAIL'}`)
  process.exit(pooled.pass ? 0 : 1)
}

main().catch((e: unknown) => {
  console.error('[tac575] crashed:', e instanceof Error ? e.message : e)
  process.exit(2)
})
