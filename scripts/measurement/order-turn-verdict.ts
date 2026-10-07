/**
 * TAC-575: does a bare item name, sent in answer to "what did you get just
 * now?", arm AND keep "how is it so far?" on both classifier arms?
 *
 * WHY IT EXISTS. Phone test 2026-10-07: the guest answered "pink panther", the
 * classifier said `reply` (0.57), and `orderTurnVerdict` only accepted
 * `casual_chatter` / `acknowledgment`, so nothing was asked.
 *
 * WHAT IT MEASURES. Each phrase goes through the real arming rule
 * (`resolveSameVisitOrderAt` with the real `bodyMentionsMenuItem` against the
 * venue's stored menu), then through Jev and Haiku with the conversation the
 * guest was in, then through the real `orderTurnVerdict`. A phrase that does
 * not arm is `skip` without a model call, which is what production does.
 *
 * PRE-REGISTERED on TAC-575 (comment of 2026-10-07) before any call:
 *   - every menu item as a bare name                         -> ask
 *   - "do you still have the X?" for every menu item         -> skip
 *   - "not yet", "still deciding", "just looking", "yes", "haha" -> skip
 *   on both arms, every repeat. A failed call voids the run.
 *
 * THE CONTROL IS IN THE SAME RUN: `wouldAskOnMain` is the verdict the two
 * category allow-list gave before this change. If no bare name reads
 * `wouldAskOnMain: false`, this harness cannot see the defect and a pass
 * proves nothing; the run says so and fails.
 *
 * THE PERSONA IS LOAD-BEARING. classifyStage passes the venue's persona, and
 * the first run of this file did not: Jev then read 21 of 22 bare names as
 * `new_question`, where production had read "pink panther" as `reply`. With
 * the persona the same names read `reply`. A harness that drops an input
 * production passes measures a different classifier.
 *
 * WHAT IT CANNOT TELL YOU:
 *   - The guest is `new` with a three-message thread. Production sees longer
 *     threads and other bands, so a rate here is not a production rate.
 *   - It does not show what the reply then says. That is the device UAT.
 *
 * Reads one venue's config. Writes nothing but the run log.
 *
 *   npx tsx --env-file=.env.local scripts/measurement/order-turn-verdict.ts
 *   MEASURE_VENUE=<slug>, --repeats <n> (Haiku only; Jev is one call).
 */

import { bodyMentionsMenuItem } from '@/lib/agent/extract-reported-order'
import {
  orderTurnVerdict,
  resolveSameVisitOrderAt,
  type OrderTurnVerdict,
} from '@/lib/agent/visit-checkin'
import {
  classifyMessage,
  classifyMessageJevArm,
} from '@/lib/ai/classify-message'
import { checkTypesafeEnv } from '@/lib/ai/typesafe-env'
import type { ClassifyMessageInput, RecentMessage } from '@/lib/ai/types'
import { createAdminClient } from '@/lib/db/admin'
import { BrandPersonaSchema } from '@/lib/schemas/brand-persona'
import { VenueInfoSchema } from '@/lib/schemas/venue-info'
import { createRunLog } from './run-log'

const NOT_ORDERS = ['not yet', 'still deciding', 'just looking', 'yes', 'haha']
const MAIN_ALLOW_LIST = new Set(['casual_chatter', 'acknowledgment'])

interface Phrase {
  kind: 'bare_name' | 'question' | 'not_an_order'
  body: string
  expected: OrderTurnVerdict
}

async function main(): Promise<void> {
  const repeatsFlag = process.argv.indexOf('--repeats')
  const repeats = repeatsFlag === -1 ? 2 : Number(process.argv[repeatsFlag + 1])
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error('--repeats must be a positive integer')
  }
  const envCheck = checkTypesafeEnv(process.env)
  if (!envCheck.ok) {
    throw new Error(`Jev env not usable: ${envCheck.problems.join('; ')}`)
  }

  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const db = createAdminClient()
  const { data: venue } = await db
    .from('venues')
    .select('id, venue_configs(venue_info, brand_persona)')
    .eq('slug', venueSlug)
    .single()
  const config = Array.isArray(venue?.venue_configs)
    ? venue?.venue_configs[0]
    : venue?.venue_configs
  const venueInfo = VenueInfoSchema.parse(config?.venue_info)
  const persona = BrandPersonaSchema.parse(config?.brand_persona)
  const menu = venueInfo.menu.items

  const phrases: Phrase[] = [
    ...menu.map((item): Phrase => {
      return {
        kind: 'bare_name',
        body: item.name.toLowerCase(),
        expected: 'ask',
      }
    }),
    ...menu.map((item): Phrase => {
      return {
        kind: 'question',
        body: `do you still have the ${item.name.toLowerCase()}?`,
        expected: 'skip',
      }
    }),
    ...NOT_ORDERS.map((body): Phrase => {
      return { kind: 'not_an_order', body, expected: 'skip' }
    }),
  ]

  const now = new Date()
  const ago = (seconds: number): Date =>
    new Date(now.getTime() - seconds * 1000)
  const recentMessages: RecentMessage[] = [
    {
      direction: 'inbound',
      body: "Hi Le Mil's!",
      createdAt: ago(20),
      delivery: 'delivered',
    },
    {
      direction: 'outbound',
      body: 'hey 👋',
      createdAt: ago(12),
      delivery: 'delivered',
    },
    {
      direction: 'outbound',
      body: 'what did you get just now?',
      createdAt: ago(10),
      delivery: 'delivered',
    },
  ]

  const log = createRunLog({
    name: 'tac575-order-turn-verdict',
    meta: {
      arm: 'treatment',
      venueSlug,
      haikuRepeats: repeats,
      phraseCount: phrases.length,
    },
  })
  console.log(
    `venue=${venueSlug} menu=${menu.length} phrases=${phrases.length}`,
  )
  console.log(`run log: ${log.path}`)

  let units = 0
  let failed = 0
  let controlSawDefect = 0
  const misses: string[] = []
  const tally = new Map<string, number>()

  for (const phrase of phrases) {
    const mentionsMenuItem = bodyMentionsMenuItem(phrase.body, menu)
    const armed =
      resolveSameVisitOrderAt({
        scanAt: null,
        guestCreatedVia: 'qr_scan',
        guestCreatedAt: ago(30),
        inboundAt: now,
        mentionsMenuItem,
        answeringOurQuestion: true,
        alreadyAskedThisVisit: false,
      }) !== null

    const record = (
      classifier: string,
      repeat: number,
      category: string | null,
      praised: boolean,
      error: string | null,
    ): void => {
      units += 1
      const verdict: OrderTurnVerdict | null =
        error !== null
          ? null
          : !armed || category === null
            ? 'skip'
            : orderTurnVerdict({
                category,
                praisedExperience: praised,
                mentionsMenuItem,
              })
      const wouldAskOnMain =
        armed && category !== null && MAIN_ALLOW_LIST.has(category) && !praised
      log.appendUnit({
        ...phrase,
        classifier,
        repeat,
        armed,
        category,
        verdict,
        wouldAskOnMain,
        error,
      })
      if (verdict === null) {
        failed += 1
        return
      }
      const key = `${phrase.kind} ${classifier} ${category ?? 'not armed'} -> ${verdict}`
      tally.set(key, (tally.get(key) ?? 0) + 1)
      if (phrase.kind === 'bare_name' && !wouldAskOnMain) controlSawDefect += 1
      if (verdict !== phrase.expected) {
        misses.push(
          `${classifier} #${repeat} "${phrase.body}": ${category ?? 'not armed'} -> ${verdict}, expected ${phrase.expected}`,
        )
      }
    }

    if (!armed) {
      record('none', 1, null, false, null)
      continue
    }
    const input: ClassifyMessageInput = {
      inboundBody: phrase.body,
      persona,
      venueInfo,
      recentMessages,
      guestState: 'new',
    }
    const viaJev = await classifyMessageJevArm(input)
    record(
      'jev',
      1,
      viaJev.ok ? viaJev.data.category : null,
      viaJev.ok && viaJev.data.praisedExperience === true,
      viaJev.ok ? null : viaJev.error,
    )
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      // The gate forced OFF, so this is the Haiku arm and nothing else.
      const viaHaiku = await classifyMessage(input, { enabled: false })
      record(
        'haiku',
        repeat,
        viaHaiku.ok ? viaHaiku.data.category : null,
        viaHaiku.ok && viaHaiku.data.praisedExperience === true,
        viaHaiku.ok ? null : viaHaiku.error,
      )
    }
  }

  console.log('\nkind, classifier, category -> verdict (units):')
  for (const [key, n] of [...tally].sort()) console.log(`  ${key}  x${n}`)
  console.log(`\nunits=${units} failed=${failed} misses=${misses.length}`)
  console.log(`bare-name units main would NOT have asked: ${controlSawDefect}`)
  for (const miss of misses) console.log(`  MISS ${miss}`)

  if (failed > 0) {
    console.log('VERDICT: VOID (a failed unit is not a result)')
    process.exitCode = 1
  } else if (controlSawDefect === 0) {
    console.log('VERDICT: VOID (the control did not reproduce the defect)')
    process.exitCode = 1
  } else {
    console.log(misses.length === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL')
    if (misses.length > 0) process.exitCode = 1
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})
