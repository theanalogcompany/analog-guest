/**
 * price-discretion.ts - does v2 quote a price the guest did not ask for?
 *
 *   npx tsx scripts/measurement/price-discretion.ts [--samples=5] [--concurrency=8]
 *
 * THE BAR IS A RATE ON THE WITHHOLD SET and the CEILING IS THE QUOTE SET, and
 * the second one is the whole reason this harness is not a one-liner. A prompt
 * that never says a number passes any "stop volunteering price" check
 * perfectly while destroying the answer to "how much is a latte" - so the
 * quote set asks directly for prices and a reply that withholds one THERE is
 * a breach, counted and printed whatever the withhold rate reads.
 *
 * NOT A SINGLE-QUESTION HARNESS, deliberately. The defect was found on "do you
 * have oat milk?", and copy naming that question would pass its own test and
 * leave every sibling broken (root CLAUDE.md, "find the mechanism by
 * ablation"). The withhold set is therefore eight DIFFERENT shapes of question
 * that do not ask what anything costs - availability, description, dietary,
 * sourcing, a modification, a list - and a fix has to move all of them.
 *
 * The detector is a pattern, not a phrase list (harness convention #7): a
 * currency figure, a bare cents figure, or the handful of words that name a
 * charge without a number ("there's an upcharge"). Both sets are scored by
 * the SAME detector, which is what makes the two rates comparable - an
 * asymmetric detector would flatter whichever set it reads more strictly.
 *
 * v2 only. v1's equivalent rule already holds (1/10 on the oat question,
 * 7/10 with its one bullet deleted), and that ablation is what identified
 * the mechanism this harness measures.
 */

import { mentionsPrice } from '@/lib/eval/price-detector'
import { createAdminClient } from '@/lib/db/admin'
import { loadVoicePack } from '@/lib/rag/voice-pack'
import { V2_PROMPT_VERSION } from '@/lib/ai/v2/template'
import { resolveV2ModelProfile } from '@/lib/ai/v2/model-call'
import { EMPTY_MEMORY, EMPTY_PROFILE } from '@/lib/relationship/profile'
import { runTurn } from '@/lib/relationship/run-turn'
import { createRunLog } from './run-log'

/** Venue-local hour every sample's clock is pinned to - mid-service. */
const WALL_HOUR = 11
const DEFAULT_SAMPLES = 5
const DEFAULT_CONCURRENCY = 8

/**
 * The bar. 10% or lower on the withhold set (owner-ruled 2026-10-15).
 *
 * A rate and not a per-question verdict: these are eight unrelated questions
 * and the thing being measured is a disposition, not eight behaviours. One
 * question at 3/5 with seven clean is the same defect as all eight at 1/5,
 * and a per-question bar would call the first one seven passes.
 */
const WITHHOLD_RATE_CEILING = 0.1

/**
 * Questions that do not ask what anything costs. Prices are ON the menu for
 * every one of these, so the fact is always available to volunteer.
 */
const WITHHOLD_SET = [
  { key: 'have-oat', question: 'Do you have oat milk?' },
  { key: 'have-vegan', question: 'do you have anything vegan?' },
  { key: 'extra-shot', question: 'can i add an extra shot?' },
  { key: 'describe-signature', question: "what's the Pink Panther like?" },
  { key: 'pastry-list', question: 'what pastries do you have?' },
  { key: 'milk-sourcing', question: 'what milk do you use?' },
  { key: 'make-it-iced', question: 'can i get it iced?' },
  { key: 'nut-free', question: 'anything nut free?' },
] as const

/**
 * The ceiling set: these ask for a price outright. A reply with no figure
 * here is a BREACH - the guest asked and got nothing.
 */
const QUOTE_SET = [
  { key: 'ask-latte-price', question: 'how much is a latte?' },
  { key: 'ask-oat-upcharge', question: 'how much extra is oat milk?' },
  {
    key: 'ask-pastry-price',
    question: 'what does the rose pistachio loaf cost?',
  },
  { key: 'ask-prices-general', question: 'what are your prices like?' },
] as const

function offsetMs(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  return (
    Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    ) - at.getTime()
  )
}

/** Venue-local WALL_HOUR today as a real instant, so no reply carries a close. */
function pinnedClock(timezone: string, realNow: Date): Date {
  const offset = offsetMs(timezone, realNow)
  const local = new Date(realNow.getTime() + offset)
  return new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      WALL_HOUR,
    ) - offset,
  )
}

interface Unit {
  set: 'withhold' | 'quote'
  key: string
  question: string
  sample: number
  /** Null when generation failed - DISQUALIFIED, never scored as a negative. */
  reply: string | null
  failure: string | null
  quoted: boolean | null
}

async function withSlots<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await run(items[i])
      }
    }),
  )
  return out
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2)
  const num = (name: string, fallback: number): number => {
    const raw = flags.find((f) => f.startsWith(`--${name}=`))?.split('=')[1]
    if (raw === undefined) return fallback
    const value = Number.parseInt(raw, 10)
    if (!Number.isInteger(value) || value < 1) {
      console.error(`--${name} must be a positive integer`)
      process.exit(1)
    }
    return value
  }
  const samples = num('samples', DEFAULT_SAMPLES)
  const concurrency = num('concurrency', DEFAULT_CONCURRENCY)

  const supabase = createAdminClient()
  const { data: venue } = await supabase
    .from('venues')
    .select('id, name, timezone')
    .ilike('name', "Le Mil's Coffee")
    .maybeSingle()
  if (!venue) {
    console.error('no usable venue')
    process.exit(1)
  }
  const now = pinnedClock(venue.timezone ?? 'America/Los_Angeles', new Date())

  const pack = await loadVoicePack({ venueId: venue.id })
  if (!pack.ok) {
    console.error(`voice pack unreadable: ${pack.error}`)
    process.exit(1)
  }
  const voicePackText = pack.data.map((c) => `- ${c.text}`).join('\n')

  const log = createRunLog({
    name: 'price-discretion',
    meta: {
      arm: 'baseline',
      venue: venue.name,
      promptVersion: V2_PROMPT_VERSION,
      generationModel: resolveV2ModelProfile().id,
      samples,
      withholdRateCeiling: WITHHOLD_RATE_CEILING,
      withholdSet: WITHHOLD_SET.map((q) => q.key),
      quoteSet: QUOTE_SET.map((q) => q.key),
      packRows: pack.data.length,
      pinnedClock: now.toISOString(),
    },
  })
  console.log(`run log: ${log.path}`)

  const work = [
    ...WITHHOLD_SET.flatMap((q) =>
      Array.from({ length: samples }, (_, s) => ({
        set: 'withhold' as const,
        ...q,
        sample: s + 1,
      })),
    ),
    ...QUOTE_SET.flatMap((q) =>
      Array.from({ length: samples }, (_, s) => ({
        set: 'quote' as const,
        ...q,
        sample: s + 1,
      })),
    ),
  ]

  let done = 0
  const units = await withSlots(work, concurrency, async (item) => {
    const trace = await runTurn({
      venueId: venue.id,
      guestId: null,
      inbound: [item.question],
      sessionHistory: [],
      session: {
        profile: EMPTY_PROFILE,
        memory: EMPTY_MEMORY,
        facts: { visitCount: 0, replyCount: 0, daysSinceLastContact: null },
      },
      overrides: { voicePackText },
      skipEvaluation: true,
      now,
    })
    const unit: Unit = trace.generation.ok
      ? {
          set: item.set,
          key: item.key,
          question: item.question,
          sample: item.sample,
          reply: trace.generation.output.messages.join(' / '),
          failure: null,
          quoted: mentionsPrice(trace.generation.output.messages.join(' ')),
        }
      : {
          set: item.set,
          key: item.key,
          question: item.question,
          sample: item.sample,
          reply: null,
          failure: trace.generation.error,
          quoted: null,
        }
    log.appendUnit({ ...unit })
    done += 1
    if (done % 10 === 0) console.log(`  ${done}/${work.length} samples`)
    return unit
  })

  report(units, samples)
}

function report(units: readonly Unit[], samples: number): void {
  // Convention #6: a crash or a skip is not a result. Failures are named and
  // excluded from both denominators before any rate is read.
  const failures = units.filter((u) => u.failure !== null)
  const scored = units.filter(
    (u): u is Unit & { reply: string; quoted: boolean } => u.quoted !== null,
  )

  for (const set of ['withhold', 'quote'] as const) {
    console.log(
      `\n=== ${set === 'withhold' ? 'WITHHOLD SET - a price here is the defect' : 'QUOTE SET - no price here is a BREACH'} ===`,
    )
    const keys = [
      ...new Set(scored.filter((u) => u.set === set).map((u) => u.key)),
    ]
    for (const key of keys) {
      const rows = scored.filter((u) => u.set === set && u.key === key)
      const hits = rows.filter((u) => u.quoted).length
      const bad = set === 'withhold' ? hits : rows.length - hits
      console.log(
        `\n  ${key}: ${set === 'withhold' ? hits : rows.length - hits}/${rows.length} ${
          set === 'withhold' ? 'quoted' : 'withheld'
        }${bad > 0 ? '  <-- bad' : ''}`,
      )
      for (const row of rows) {
        const flag = set === 'withhold' ? row.quoted : !row.quoted
        console.log(`    ${flag ? 'BAD ' : '    '} ${row.reply}`)
      }
    }
  }

  const withhold = scored.filter((u) => u.set === 'withhold')
  const quote = scored.filter((u) => u.set === 'quote')
  const quoted = withhold.filter((u) => u.quoted).length
  const rate = withhold.length === 0 ? 1 : quoted / withhold.length
  const breaches = quote.filter((u) => !u.quoted)

  console.log(`\n=== verdict (n=${samples} per question) ===`)
  if (failures.length > 0) {
    console.log(`  ${failures.length} DISQUALIFIED generation failures:`)
    for (const f of failures)
      console.log(`    ${f.key} s${f.sample}: ${f.failure}`)
  }
  console.log(
    `  withhold set: ${quoted}/${withhold.length} quoted a price = ${(rate * 100).toFixed(1)}% (bar: <= ${WITHHOLD_RATE_CEILING * 100}%)`,
  )
  console.log(
    `  quote set:    ${breaches.length}/${quote.length} withheld a price the guest asked for`,
  )
  const barMet = rate <= WITHHOLD_RATE_CEILING
  // Convention #8: the ceiling is evaluated here, not merely tallied. A
  // breach fails the arm whatever the withhold rate reads.
  console.log(
    `\n  ${
      breaches.length > 0
        ? 'FAIL - ceiling breached: the fix is suppressing prices guests asked for'
        : barMet
          ? 'PASS'
          : 'FAIL - withhold rate above the bar'
    }`,
  )
}

void main()
