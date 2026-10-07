/**
 * TAC-575: on a turn that armed "how is it so far?", does the order
 * extractor's read ask after an order and stay quiet after everything else?
 *
 * WHY IT EXISTS. Phone test 2026-10-07: we asked "what did you get just now?",
 * the guest answered "pink panther", the classifier said `reply`, and nothing
 * was asked. Deciding it from the category was measured and missed (Jev read
 * 3 of 22 bare names as `new_question`), so the armed turn now waits for the
 * extractor (ruled 2026-10-07).
 *
 * WHAT IT MEASURES. Each phrase goes through the real arming rule
 * (`resolveSameVisitOrderAt` with the real `bodyMentionsMenuItem`), the
 * production classifier call (Jev first, persona and thread as classifyStage
 * passes them), the extractor's real read half (`readReportedOrder`), and the
 * real `orderTurnVerdict`. A phrase that does not arm is `skip` with no model
 * call, which is what production does. The read is timed: it is the wait the
 * armed turn now adds.
 *
 * PRE-REGISTERED on TAC-575 (second [PLAN] comment, 2026-10-07) before any
 * call, and evaluated in code below:
 *   - bare item names -> ask; at most one name may miss on any repeat
 *   - the four multi-item orders -> ask, every repeat
 *   - the three menu questions, "do you still have the X?" for every item,
 *     and the five non-orders -> skip, every repeat
 *   - latency p50 / p95 of the read: reported, no bar
 *   - a failed call voids the run
 *   - INFO phrases are printed and never scored
 *
 * WHAT IT CANNOT TELL YOU:
 *   - It stops at the read. Production asks only when the extractor went on
 *     to WRITE the order (recordedOrderForThisVisit); a write that fails is
 *     one unasked question this file cannot see. The timing likewise leaves
 *     out the two lookups and one insert that follow the read.
 *   - The guest is new, created by the sign thirty seconds ago, with a
 *     three-message thread. A rate here is not a production rate.
 *   - It does not show what the reply then says. That is the device UAT.
 *   - The five non-orders name nothing on the menu, so they never arm and
 *     their skip cannot fail. They are evidence about arming, not about the
 *     extractor.
 *   - Every phrase is a fresh guest. A guest whose order is already on
 *     today's row (`no_new_items_ongoing`) is not reached here.
 *
 * Reads one venue's config. Writes nothing but the run log.
 *
 *   npx tsx --env-file=.env.local scripts/measurement/order-turn-verdict.ts
 *   MEASURE_VENUE=<slug>, --repeats <n> (extractor reads per armed phrase).
 */

import {
  bodyMentionsMenuItem,
  isOrderOnTheMessagesDay,
  readReportedOrder,
  type ReportedOrderContext,
} from '@/lib/agent/extract-reported-order'
import {
  orderTurnVerdict,
  resolveSameVisitOrderAt,
  type OrderTurnVerdict,
} from '@/lib/agent/visit-checkin'
import { classifyMessage } from '@/lib/ai/classify-message'
import { checkTypesafeEnv } from '@/lib/ai/typesafe-env'
import type { RecentMessage } from '@/lib/ai/types'
import { createAdminClient } from '@/lib/db/admin'
import { BrandPersonaSchema } from '@/lib/schemas/brand-persona'
import { VenueInfoSchema } from '@/lib/schemas/venue-info'
import { createRunLog } from './run-log'

type Kind = 'bare_name' | 'multi_item' | 'menu_question' | 'not_an_order'

interface Phrase {
  kind: Kind | 'info'
  body: string
  /** Null on an INFO phrase: printed, never scored. */
  expected: OrderTurnVerdict | null
}

const MULTI_ITEM = [
  'pink panther and a croissant',
  '2 lattes',
  'flat white, almond croissant',
  'a pour over with a cookie',
]
const MENU_QUESTIONS = [
  'pour over or americano',
  'is the pour over good',
  "what's the pour over like",
]
const NOT_ORDERS = ['not yet', 'still deciding', 'just looking', 'yes', 'haha']
const INFO = ['can i get a pour over']

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
}

async function main(): Promise<void> {
  const repeatsFlag = process.argv.indexOf('--repeats')
  const repeats = repeatsFlag === -1 ? 3 : Number(process.argv[repeatsFlag + 1])
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error('--repeats must be a positive integer')
  }
  const envCheck = checkTypesafeEnv(process.env)
  if (!envCheck.ok) {
    throw new Error(`Jev env not usable: ${envCheck.problems.join('; ')}`)
  }

  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const db = createAdminClient()
  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, timezone, venue_configs(venue_info, brand_persona)')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) {
    throw new Error(`venue ${venueSlug}: ${venueError?.message ?? 'not found'}`)
  }
  const config = Array.isArray(venue.venue_configs)
    ? venue.venue_configs[0]
    : venue.venue_configs
  const venueInfo = VenueInfoSchema.parse(config?.venue_info)
  const persona = BrandPersonaSchema.parse(config?.brand_persona)
  const menu = venueInfo.menu.items

  const of = (kind: Phrase['kind'], expected: Phrase['expected']) => {
    return (body: string): Phrase => ({ kind, body, expected })
  }
  const phrases: Phrase[] = [
    ...menu.map((item) => item.name.toLowerCase()).map(of('bare_name', 'ask')),
    ...MULTI_ITEM.map(of('multi_item', 'ask')),
    ...MENU_QUESTIONS.map(of('menu_question', 'skip')),
    ...menu
      .map((item) => `do you still have the ${item.name.toLowerCase()}?`)
      .map(of('menu_question', 'skip')),
    ...NOT_ORDERS.map(of('not_an_order', 'skip')),
    ...INFO.map(of('info', null)),
  ]

  const now = new Date()
  const ago = (seconds: number): Date =>
    new Date(now.getTime() - seconds * 1000)
  const said = (
    direction: RecentMessage['direction'],
    body: string,
    secondsAgo: number,
  ): RecentMessage => {
    return {
      direction,
      body,
      createdAt: ago(secondsAgo),
      delivery: 'delivered',
    }
  }
  const recentMessages = [
    said('inbound', "Hi Le Mil's!", 20),
    said('outbound', 'hey 👋', 12),
    said('outbound', 'what did you get just now?', 10),
  ]

  const log = createRunLog({
    name: 'tac575-order-turn-verdict',
    meta: { arm: 'treatment', venueSlug, repeats, phrases: phrases.length },
  })
  console.log(
    `venue=${venueSlug} menu=${menu.length} phrases=${phrases.length}`,
  )
  console.log(`run log: ${log.path}`)

  let failed = 0
  const readMs: number[] = []
  const tally = new Map<string, number>()
  // Per kind, the phrases that missed on at least one repeat.
  const missed = new Map<string, Set<string>>()
  const notes: string[] = []

  for (const phrase of phrases) {
    const armed =
      resolveSameVisitOrderAt({
        scanAt: null,
        guestCreatedVia: 'qr_scan',
        guestCreatedAt: ago(30),
        inboundAt: now,
        mentionsMenuItem: bodyMentionsMenuItem(phrase.body, menu),
        answeringOurQuestion: true,
        alreadyAskedThisVisit: false,
      }) !== null

    const score = (
      repeat: number,
      category: string,
      read: string,
      verdict: OrderTurnVerdict,
    ): void => {
      log.appendUnit({ ...phrase, repeat, armed, category, read, verdict })
      const key = `${phrase.kind}: ${category}, ${read} -> ${verdict}`
      tally.set(key, (tally.get(key) ?? 0) + 1)
      if (phrase.expected === null) {
        notes.push(`INFO "${phrase.body}" #${repeat}: ${read} -> ${verdict}`)
      } else if (verdict !== phrase.expected) {
        const set = missed.get(phrase.kind) ?? new Set<string>()
        set.add(phrase.body)
        missed.set(phrase.kind, set)
        notes.push(
          `MISS "${phrase.body}" #${repeat}: ${category}, ${read} -> ${verdict}`,
        )
      }
    }

    if (!armed) {
      score(1, 'not classified', 'not armed', 'skip')
      continue
    }
    const classified = await classifyMessage({
      inboundBody: phrase.body,
      persona,
      venueInfo,
      recentMessages,
      guestState: 'new',
    })
    if (!classified.ok) {
      failed += 1
      log.appendUnit({ ...phrase, armed, error: classified.error })
      notes.push(`FAILED classify "${phrase.body}": ${classified.error}`)
      continue
    }
    const ctx: ReportedOrderContext = {
      currentMessage: { body: phrase.body, receivedAt: now },
      guest: { id: 'measurement', createdVia: 'qr_scan', createdAt: ago(30) },
      venue: { id: venue.id, timezone: venue.timezone, venueInfo },
    }
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const startedAt = Date.now()
      const read = await readReportedOrder(ctx)
      const elapsed = Date.now() - startedAt
      if (read.kind === 'failed') {
        failed += 1
        log.appendUnit({ ...phrase, repeat, armed, error: read.error })
        notes.push(`FAILED read "${phrase.body}" #${repeat}: ${read.error}`)
        continue
      }
      readMs.push(elapsed)
      const orderRecorded =
        read.kind === 'order' &&
        isOrderOnTheMessagesDay(read.occurredAt, now, venue.timezone)
      score(
        repeat,
        classified.data.category,
        read.kind === 'order' && !orderRecorded
          ? 'order, another day'
          : read.kind,
        orderTurnVerdict({
          category: classified.data.category,
          praisedExperience: classified.data.praisedExperience === true,
          orderRecorded,
        }),
      )
    }
  }

  console.log('\nkind: category, extractor read -> verdict (units):')
  for (const [key, n] of [...tally].sort()) console.log(`  ${key}  x${n}`)
  for (const note of notes) console.log(`  ${note}`)

  readMs.sort((a, b) => a - b)
  if (readMs.length > 0) {
    console.log(
      `\nextractor read, ${readMs.length} calls: p50 ${percentile(readMs, 0.5)}ms, p95 ${percentile(readMs, 0.95)}ms, max ${readMs[readMs.length - 1]}ms`,
    )
  }

  const bareMisses = missed.get('bare_name')?.size ?? 0
  const otherMisses = (['multi_item', 'menu_question', 'not_an_order'] as const)
    .map((kind) => missed.get(kind)?.size ?? 0)
    .reduce((a, b) => a + b, 0)
  console.log(
    `\nbare names that missed on any repeat: ${bareMisses} of ${menu.length} (bar: at most 1)`,
  )
  console.log(
    `other phrases that missed on any repeat: ${otherMisses} (bar: 0)`,
  )
  if (failed > 0) {
    console.log(
      `VERDICT: VOID (${failed} failed calls; a failure is not a result)`,
    )
    process.exitCode = 1
    return
  }
  const pass = bareMisses <= 1 && otherMisses === 0
  console.log(pass ? 'VERDICT: PASS' : 'VERDICT: FAIL')
  if (!pass) process.exitCode = 1
}

main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})
