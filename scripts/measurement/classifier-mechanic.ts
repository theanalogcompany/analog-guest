/**
 * TAC-574: do ordering questions classify as `new_question`, and do real
 * mechanic requests still classify as `mechanic_request`, on BOTH classifier
 * arms?
 *
 * WHAT IT MEASURES. The seven phrases in the ticket's acceptance criteria run
 * through Haiku (`classifyMessage` with the Jev gate forced off) and through
 * Jev (`classifyMessageJevArm`, no fallback, so a Jev failure scores as a
 * failure rather than silently as Haiku's answer). Haiku runs at temperature
 * 0.2, so each phrase repeats; Jev is one request per phrase.
 *
 * TWO ARMS, ONE FILE, TWO CHECKOUTS. The wording under test is module
 * constants, so the arm is whichever checkout this file runs in:
 *   --arm control    on `main`'s wording. It must REPRODUCE the defect: the
 *                    two phrases held in the 2026-10-06 phone test classify
 *                    `mechanic_request` on the Jev arm. If it does not, this
 *                    harness cannot see the defect and the treatment run
 *                    proves nothing.
 *   --arm treatment  on the branch's wording. The bar below applies.
 * The header records PROMPT_VERSION and CLASSIFY_JEV_PROMPT_VERSION, which is
 * what tells two run files apart afterwards.
 *
 * PRE-REGISTERED, evaluated in code (posted on TAC-574 before any call):
 *   - Treatment bar: all four ordering phrases `new_question` and all three
 *     mechanic phrases `mechanic_request`, on both arms, every repeat.
 *   - Control: both observed phrases `mechanic_request` on Jev.
 *   - A failed call is not a result. Any failed unit fails the run, whatever
 *     the remaining units read.
 *
 * WHAT IT CANNOT TELL YOU:
 *   - Both arms run bare: no persona, venue info, history or guest state (the
 *     same limit `jev-classify-eval.ts` states). Production sees venue
 *     context, so an absolute rate here is not a production rate.
 *   - Seven phrases are the ticket's own examples, which the new wording
 *     quotes. Passing shows the wording is read; it does not show how a
 *     phrase nobody wrote down is classified. The 30-day replay
 *     (`jev-classify-eval.ts`) is the instrument for that.
 *
 * Model calls: 7 x repeats on Haiku plus 7 on Jev. Writes nothing but the run
 * log. Phrases are synthetic strings that live in this file.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/measurement/classifier-mechanic.ts --arm treatment
 */

import {
  classifyMessage,
  classifyMessageJevArm,
} from '@/lib/ai/classify-message'
import { CLASSIFY_JEV_PROMPT_VERSION } from '@/lib/ai/classify-message-jev'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { checkTypesafeEnv } from '@/lib/ai/typesafe-env'
import type { AIResult, ClassifyMessageResult } from '@/lib/ai/types'
import { createRunLog } from './run-log'

const DEFAULT_HAIKU_REPEATS = 5

type Arm = 'control' | 'treatment'
type Classifier = 'haiku' | 'jev'
type Expected = 'new_question' | 'mechanic_request'

interface Phrase {
  id: string
  body: string
  expected: Expected
  /** Held as mechanic_request in the 2026-10-06 phone test. */
  observedDefect: boolean
}

const PHRASES: readonly Phrase[] = [
  {
    id: 'order_flat_white',
    body: 'can i get a flat white',
    expected: 'new_question',
    observedDefect: true,
  },
  {
    id: 'order_ahead',
    body: 'can i order ahead',
    expected: 'new_question',
    observedDefect: true,
  },
  {
    id: 'order_pre_orders',
    body: 'do you do pre-orders',
    expected: 'new_question',
    observedDefect: false,
  },
  {
    id: 'order_oat_milk',
    body: 'can i get oat milk in that',
    expected: 'new_question',
    observedDefect: false,
  },
  {
    id: 'mechanic_hold_couch',
    body: 'can you hold the couch',
    expected: 'mechanic_request',
    observedDefect: false,
  },
  {
    id: 'mechanic_on_the_house',
    body: 'is the tea on the house',
    expected: 'mechanic_request',
    observedDefect: false,
  },
  {
    id: 'mechanic_open_mic_list',
    body: 'can i get on the open mic list',
    expected: 'mechanic_request',
    observedDefect: false,
  },
]

interface Args {
  arm: Arm
  repeats: number
  outputPath: string | null
  force: boolean
}

function parseArgs(argv: string[]): Args {
  let arm: string | null = null
  const args = {
    repeats: DEFAULT_HAIKU_REPEATS,
    outputPath: null as string | null,
    force: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--arm') arm = argv[++i] ?? null
    else if (flag === '--repeats') args.repeats = Number(argv[++i])
    else if (flag === '--out') args.outputPath = argv[++i] ?? null
    else if (flag === '--force') args.force = true
  }
  if (arm !== 'control' && arm !== 'treatment') {
    throw new Error('--arm must be "control" or "treatment"')
  }
  if (!Number.isInteger(args.repeats) || args.repeats <= 0) {
    throw new Error(`--repeats must be a positive integer, got ${args.repeats}`)
  }
  return { arm, ...args }
}

interface Unit {
  phraseId: string
  classifier: Classifier
  repeat: number
  expected: Expected
  observedDefect: boolean
  /** null when the call failed: a failed unit carries no verdict. */
  category: string | null
  confidence: number | null
  error: string | null
}

function toUnit(
  phrase: Phrase,
  classifier: Classifier,
  repeat: number,
  result: AIResult<ClassifyMessageResult>,
): Unit {
  const base = {
    phraseId: phrase.id,
    classifier,
    repeat,
    expected: phrase.expected,
    observedDefect: phrase.observedDefect,
  }
  return result.ok
    ? {
        ...base,
        category: result.data.category,
        confidence: result.data.classifierConfidence,
        error: null,
      }
    : { ...base, category: null, confidence: null, error: result.error }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const envCheck = checkTypesafeEnv(process.env)
  if (!envCheck.ok) {
    // A missing key would fail every Jev unit, and a run of failures is not a
    // measurement. Stop before spending the Haiku calls.
    throw new Error(`Jev env not usable: ${envCheck.problems.join('; ')}`)
  }

  const log = createRunLog({
    name: 'classifier-mechanic',
    outputPath: args.outputPath ?? undefined,
    force: args.force,
    meta: {
      arm: args.arm,
      promptVersion: PROMPT_VERSION,
      jevPromptVersion: CLASSIFY_JEV_PROMPT_VERSION,
      haikuRepeats: args.repeats,
      phraseCount: PHRASES.length,
    },
  })
  console.log(
    `arm=${args.arm} PROMPT_VERSION=${PROMPT_VERSION} jev=${CLASSIFY_JEV_PROMPT_VERSION}`,
  )
  console.log(`run log: ${log.path}`)

  const units: Unit[] = []
  for (const phrase of PHRASES) {
    const input = { inboundBody: phrase.body }
    const viaJev = toUnit(phrase, 'jev', 1, await classifyMessageJevArm(input))
    log.appendUnit({ ...viaJev })
    units.push(viaJev)
    for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
      const viaHaiku = toUnit(
        phrase,
        'haiku',
        repeat,
        // The gate forced OFF, so this is the Haiku arm and nothing else.
        await classifyMessage(input, { enabled: false }),
      )
      log.appendUnit({ ...viaHaiku })
      units.push(viaHaiku)
    }
  }

  console.log('\nper phrase (category counts; expected in brackets):')
  for (const phrase of PHRASES) {
    for (const classifier of ['jev', 'haiku'] as const) {
      const mine = units.filter(
        (u) => u.phraseId === phrase.id && u.classifier === classifier,
      )
      const counts = new Map<string, number>()
      for (const u of mine) {
        const key = u.category ?? 'FAILED'
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const rendered = [...counts].map(([k, n]) => `${k} x${n}`).join(', ')
      console.log(
        `  ${phrase.id.padEnd(24)} ${classifier.padEnd(5)} [${phrase.expected}] ${rendered}`,
      )
    }
  }

  // Failures first: a failed unit disqualifies the run before any count is read.
  const failed = units.filter((u) => u.category === null)
  if (failed.length > 0) {
    console.log(`\nFAILED UNITS: ${failed.length}`)
    for (const u of failed) {
      console.log(
        `  ${u.phraseId} ${u.classifier} #${u.repeat}: ${u.error ?? ''}`,
      )
    }
    console.log('\nVERDICT: VOID (a failed unit is not a result)')
    process.exitCode = 1
    return
  }

  if (args.arm === 'control') {
    const reproduced = units.filter(
      (u) => u.observedDefect && u.classifier === 'jev',
    )
    const stillDefect = reproduced.filter(
      (u) => u.category === 'mechanic_request',
    )
    const ok = stillDefect.length === reproduced.length
    console.log(
      `\ncontrol: ${stillDefect.length}/${reproduced.length} observed phrases reproduce mechanic_request on Jev`,
    )
    console.log(
      ok
        ? 'VERDICT: CONTROL REPRODUCES THE DEFECT'
        : 'VERDICT: CONTROL DOES NOT REPRODUCE THE DEFECT (the treatment run proves nothing)',
    )
    if (!ok) process.exitCode = 1
    return
  }

  const misses = units.filter((u) => u.category !== u.expected)
  console.log(
    `\ntreatment: ${units.length - misses.length}/${units.length} units match`,
  )
  for (const u of misses) {
    console.log(
      `  MISS ${u.phraseId} ${u.classifier} #${u.repeat}: got ${u.category ?? ''}, expected ${u.expected}`,
    )
  }
  console.log(misses.length === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL')
  if (misses.length > 0) process.exitCode = 1
}

main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})
