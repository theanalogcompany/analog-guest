/**
 * TAC-555. When a regular names what they just got, does the reply recognise
 * it as their usual, and does it stay silent about history for an item they
 * have never ordered?
 *
 * GENERATE-ONLY. Nothing is sent and nothing is written, with one exception
 * that is reported rather than assumed away: `buildRuntimeContext` persists a
 * `guest_states` row on a recognition-band change, so context is built ONCE
 * for the whole run and cloned per unit, and the run prints the row count
 * before and after.
 *
 * TWO ARMS, ONE VARIABLE, CONTROL FIRST within each unit. `treatment` is the
 * shipped prompt untouched, so it cannot drift from production; `control` is
 * that prompt with the two TAC-555 clauses sliced out. Each slice is guarded
 * to match exactly once at startup and again per unit, and a unit whose slice
 * did not change the prompt is INVALID rather than recorded: a silently
 * broken arm produces exactly the "the fix works" shape (TAC-502 paid for
 * that, scoring a run in which all 60 calls had failed as clean).
 *
 * WHY THE HEADLINE METRIC IS AN LLM JUDGE AND NOT A PHRASE LIST. Recognition
 * is a judgement, and the treatment arm is the free-writing one BY
 * CONSTRUCTION, because the rule deliberately carries no quoted example. A
 * phrase list would therefore under-count exactly the arm under test. That is
 * TAC-423's asymmetry, which cost that ticket two detector rewrites and
 * flattered the scripted arm both times. The deterministic checks in
 * `usual-order-language.ts` are printed beside the judge as cross-checks, and
 * the R23 count ceiling is deterministic because a judge softens exactly the
 * thing a ceiling must not soften.
 *
 * EVERY BAR IS PRE-REGISTERED AND EVALUATED IN CODE, not tallied and left to
 * whoever reads the output. TAC-519 shipped a harness that printed PASS for a
 * ceiling it never evaluated; a printed pass that asserts nothing is worse
 * than no assertion.
 *
 * Run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL unset so the
 * stages' telemetry goes inert. MEASURE_FREQUENT / MEASURE_NEW shrink the
 * arms for a smoke run; the ticket's bars are stated at 20 and 10.
 */
import { randomUUID } from 'node:crypto'
import { generateObject } from 'ai'
import { z } from 'zod'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from '@/lib/agent/stages'
import { getClassificationModel, getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
  VOICE_FIDELITY_INSTRUCTION,
} from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import type {
  KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import type { Visit } from '@/lib/ai/types'
import {
  findCountClaim,
  findOtherHistoryItems,
  findVisitFrequencyClaim,
} from './usual-order-language'
import { repeatedPhrases } from './take-and-specifics-language'
import { createRunLog } from './run-log'

/**
 * The two clauses under test, TRANSCRIBED from the approved wording rather
 * than imported from SYSTEM_TEMPLATE. Importing would make the slice agree
 * with whatever the template happens to say, including a reworded version, so
 * a run could silently measure something other than what was approved. A
 * mismatch is a startup failure.
 */
const R21_CLAUSE =
  " Receiving it is not the same as saying as little as possible. When the item they named is already in this guest's ## Visit history, say so: that it's the one they order more than any other when the history shows it that way, or simply that they've had it before when it appears once or twice. Put it in your own words, the way someone behind the counter speaks to an order they recognize, and vary how you say it so it doesn't read as a script. Recognizing an order is not rating it, and this doesn't license a verdict on the choice. If the item is not in their history, say nothing about their history. A category's register guidance, whether it frames the turn as a close or as small talk, is never authority over whether you recognize an order you know."

const R23_CLAUSE =
  ' This rule is about how often they have been here, not about what they order: telling a guest you know which item they order most is the order-recognition guidance above, and is not a visit statistic. What this rule forbids is naming a number, and that holds whether the number counts visits or orders.'

const ARMS = ['control', 'treatment'] as const
type Arm = (typeof ARMS)[number]

/** How many times each body is judged. One verdict is a draw, not a property. */
const JUDGE_REPS = 3

/** The ticket's bars. */
const FREQUENT_BAR = 18
const NEW_FALSE_CLAIM_CEILING = 0
const TEMPLATE_MAX_SHARE = 0.25

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * Report phrasings, chosen so BOTH classifier landings occur in the run. The
 * live classifier at 4 reps put "just got a cortado" at casual_chatter 4/4 and
 * "got a cortado" at acknowledgment 4/4, its own reasoning calling the second
 * a closing statement like "got it". Recognition is reported by resolved
 * category for that reason: if it holds on the acknowledgment units, R21's
 * jurisdictional sentence is doing its job.
 */
const PHRASINGS = [
  (item: string) => `just got a ${item}`,
  (item: string) => `got a ${item}`,
  (item: string) => `just grabbed a ${item}`,
  (item: string) => `got the ${item}`,
  (item: string) => `just picked up a ${item}`,
]

/** How many visits, and how many of them carry the dominant item. */
const SHAPES: readonly { visits: number; dominant: number }[] = [
  { visits: 5, dominant: 4 },
  { visits: 4, dominant: 3 },
  { visits: 6, dominant: 4 },
  { visits: 3, dominant: 3 },
]

interface Unit {
  id: string
  /** 'frequent' is arm A, 'new' is arm B. */
  population: 'frequent' | 'new'
  /** The item the guest names in their message. */
  namedItem: string
  /** The item that dominates the history. Equal to namedItem in arm A. */
  dominantItem: string
  body: string
  visits: Visit[]
  historyItems: string[]
}

/**
 * Builds the two populations from the venue's OWN menu names. Generic items
 * derail a run: TAC-513 watched the model correctly answer "we don't actually
 * have a matcha on the menu", which would have scored as a miss while
 * measuring item existence rather than recognition.
 */
function buildUnits(menu: string[], frequentCount: number, newCount: number): Unit[] {
  const units: Unit[] = []
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000

  const makeVisits = (dominant: string, filler: string[], shape: { visits: number; dominant: number }) => {
    const visits: Visit[] = []
    for (let i = 0; i < shape.visits; i += 1) {
      const item = i < shape.dominant ? dominant : (filler[i % filler.length] as string)
      // Most recent first, spaced a few days apart, all inside the 90-day
      // window the real block loads.
      visits.push({ items: [item], visitedAt: new Date(now - (i * 5 + 3) * day) })
    }
    return visits
  }

  for (let i = 0; i < frequentCount; i += 1) {
    const dominant = menu[i % menu.length] as string
    const filler = menu.filter((m) => m !== dominant)
    const shape = SHAPES[i % SHAPES.length] as { visits: number; dominant: number }
    const phrasing = PHRASINGS[i % PHRASINGS.length] as (item: string) => string
    const visits = makeVisits(dominant, filler, shape)
    units.push({
      id: `freq-${String(i + 1).padStart(2, '0')}`,
      population: 'frequent',
      namedItem: dominant,
      dominantItem: dominant,
      body: phrasing(dominant.toLowerCase()),
      visits,
      historyItems: [...new Set(visits.flatMap((v) => v.items))],
    })
  }

  for (let i = 0; i < newCount; i += 1) {
    // The dominant item and the named item are DIFFERENT, and the named item
    // appears nowhere in the history. That is the whole of arm B.
    const dominant = menu[i % menu.length] as string
    const named = menu[(i + Math.floor(menu.length / 2)) % menu.length] as string
    if (named === dominant) continue
    const filler = menu.filter((m) => m !== dominant && m !== named)
    const shape = SHAPES[i % SHAPES.length] as { visits: number; dominant: number }
    const phrasing = PHRASINGS[i % PHRASINGS.length] as (item: string) => string
    const visits = makeVisits(dominant, filler.length > 0 ? filler : [dominant], shape)
    const historyItems = [...new Set(visits.flatMap((v) => v.items))]
    if (historyItems.some((h) => h.toLowerCase() === named.toLowerCase())) continue
    units.push({
      id: `new-${String(i + 1).padStart(2, '0')}`,
      population: 'new',
      namedItem: named,
      dominantItem: dominant,
      body: phrasing(named.toLowerCase()),
      visits,
      historyItems,
    })
  }

  return units
}

// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

/**
 * `reasoning` is declared FIRST. Structured-output fields generate in
 * declaration order, so a verdict declared first is produced before the
 * analysis that should inform it: TAC-301 part 1.5 watched exactly that make a
 * grounding verifier's reasoning reverse itself while the boolean stood.
 */
const JudgeSchema = z.object({
  reasoning: z.string(),
  recognizesPriorOrder: z.boolean(),
  claimsMostFrequent: z.boolean(),
  recitesHistory: z.boolean(),
  statesCount: z.boolean(),
})

const JUDGE_SYSTEM = `You are grading one reply a cafe sent to a guest who just told the venue what they ordered. You are given the guest's message, the reply, and the items that appear in that guest's recorded visit history.

Answer four questions about the REPLY only.

- recognizesPriorOrder: does the reply indicate, in any wording, that the guest has had this item before, or that the venue knows this order? Saying nothing about their history is false. Merely naming the item back is false on its own.
- claimsMostFrequent: does the reply indicate this is what the guest usually gets, their regular order, or the one they get more than anything else? A plain "you've had that before" is false here and true for recognizesPriorOrder.
- recitesHistory: does the reply read the history back, listing past visits, naming dates, or naming other past items? A single reference to the item the guest just named is not reciting.
- statesCount: does the reply state a number of visits or a number of times they have ordered something? A quantity in the guest's own order is not a count.

Judge the wording as written. Do not reward or penalise tone.`

async function judge(
  guestMessage: string,
  reply: string,
  historyItems: readonly string[],
): Promise<z.infer<typeof JudgeSchema> | null> {
  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: JUDGE_SYSTEM,
      prompt: `Guest message: "${guestMessage}"\n\nReply: "${reply}"\n\nItems in this guest's recorded visit history: ${historyItems.join(', ')}\n\nGrade the reply.`,
      schema: JudgeSchema,
      temperature: 0.2,
      maxOutputTokens: 400,
    })
    return object
  } catch {
    return null
  }
}

/** Majority over JUDGE_REPS, with the split kept so instability is visible. */
interface JudgeVerdict {
  recognizesPriorOrder: number
  claimsMostFrequent: number
  recitesHistory: number
  statesCount: number
  reps: number
  failures: number
  reasonings: string[]
}

async function judgeRepeatedly(
  guestMessage: string,
  reply: string,
  historyItems: readonly string[],
): Promise<JudgeVerdict> {
  const v: JudgeVerdict = {
    recognizesPriorOrder: 0,
    claimsMostFrequent: 0,
    recitesHistory: 0,
    statesCount: 0,
    reps: JUDGE_REPS,
    failures: 0,
    reasonings: [],
  }
  for (let i = 0; i < JUDGE_REPS; i += 1) {
    const r = await judge(guestMessage, reply, historyItems)
    if (r === null) {
      v.failures += 1
      continue
    }
    if (r.recognizesPriorOrder) v.recognizesPriorOrder += 1
    if (r.claimsMostFrequent) v.claimsMostFrequent += 1
    if (r.recitesHistory) v.recitesHistory += 1
    if (r.statesCount) v.statesCount += 1
    if (i === 0) v.reasonings.push(r.reasoning)
  }
  return v
}

function majority(hits: number, reps: number, failures: number): boolean {
  const valid = reps - failures
  return valid > 0 && hits * 2 > valid
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

interface UnitRecord {
  unitId: string
  population: 'frequent' | 'new'
  arm: Arm
  namedItem: string
  dominantItem: string
  historyItems: string[]
  guestMessage: string
  category: string | null
  reply: string | null
  /** INVALID units can meet no expectation, whatever their flags read. */
  invalid: boolean
  error: string | null
  generationCalls: number
  judge: JudgeVerdict | null
  recognizes: boolean
  claimsUsual: boolean
  recites: boolean
  statesCountJudge: boolean
  countClaimMatches: string[]
  visitFrequencyMatches: string[]
  otherHistoryItemMatches: string[]
}

function parseIntArg(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

async function main() {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const frequentCount = parseIntArg('MEASURE_FREQUENT', 20)
  const newCount = parseIntArg('MEASURE_NEW', 10)

  const db = createAdminClient()

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, timezone')
    .eq('slug', venueSlug)
    .maybeSingle()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found: ${venueError?.message}`)

  // The busiest non-synthetic guest, so the loaded corpus and persona are a
  // real venue's rather than a fixture's. Their own visit history is REPLACED
  // per unit: this run controls the history, and taking the real one would
  // measure one guest's data rather than the rule.
  const { data: guests } = await db
    .from('guests')
    .select('id, first_name, phone_number, instagram_scoped_id')
    .eq('venue_id', venue.id)
    .eq('is_test_synthetic', false)
  const candidates = (guests ?? []).filter(
    (g) => !String(g.first_name ?? '').toLowerCase().startsWith('synthetic'),
  )
  let guest: (typeof candidates)[number] | null = null
  let guestMessageCount = 0
  for (const g of candidates) {
    const { count } = await db
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('guest_id', g.id)
    if ((count ?? 0) > guestMessageCount) {
      guestMessageCount = count ?? 0
      guest = g
    }
  }
  if (!guest) throw new Error('no non-synthetic guest at this venue')
  const channel: 'text' | 'instagram' = guest.phone_number ? 'text' : 'instagram'

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const trace = startAgentTrace({ name: 'tac555-measure', agentRunId: randomUUID() })
  const now = new Date()

  // ONE context build for the whole run, cloned per unit, so computeGuestState
  // has exactly one opportunity to write.
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: guest.id,
    venueId: venue.id,
    trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `tac555-probe-${randomUUID()}`,
      body: 'just got a cortado',
      receivedAt: now,
      channel,
      referralSource: null,
    },
  })

  const menu = (baseCtx.venue.venueInfo.menu?.items ?? [])
    .map((m) => m.name)
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
  if (menu.length < 4) {
    console.error(`✗ ${venueSlug} has ${menu.length} usable menu item names; need at least 4.`)
    process.exit(1)
  }

  // STARTUP GUARD. Both slices must find their clause exactly once in a real
  // composed prompt before any model call is spent. If either is absent the
  // control arm would be byte-identical to the treatment and the run would
  // measure nothing while reporting cleanly.
  {
    const probe = composePrompt({
      category: 'casual_chatter',
      persona: baseCtx.venue.brandPersona,
      venueInfo: baseCtx.venue.venueInfo,
      ragChunks: [],
      knowledgeChunks: undefined,
      runtime: buildAiRuntime(baseCtx),
      channel: baseCtx.conversationChannel,
    })
    for (const [label, clause] of [
      ['R21 recognition clause', R21_CLAUSE],
      ['R23 carve-out', R23_CLAUSE],
    ] as const) {
      const hits = probe.systemPrompt.split(clause).length - 1
      if (hits !== 1) {
        console.error(
          `✗ the ${label} appears ${hits} times in a composed system prompt, expected exactly 1.\n` +
            '  Either it is not shipped (run this on a branch where it is), or its wording has drifted\n' +
            '  from the approved text transcribed at the top of this file. Refusing to run.',
        )
        process.exit(1)
      }
    }
  }

  const units = buildUnits(menu, frequentCount, newCount)
  const startedAt = new Date()
  const log = createRunLog({
    name: 'tac555-usual-order-recognition',
    meta: {
      arm: 'both',
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      channel,
      guestMessageCount,
      frequentUnits: units.filter((u) => u.population === 'frequent').length,
      newUnits: units.filter((u) => u.population === 'new').length,
      judgeReps: JUDGE_REPS,
      menuItemsAvailable: menu.length,
      statesBefore,
    },
  })

  console.log(`[tac555] venue ${venueSlug} | prompt ${PROMPT_VERSION} | channel ${channel}`)
  console.log(`[tac555] ${units.length} units x ${ARMS.length} arms | judge reps ${JUDGE_REPS}`)
  console.log(`[tac555] guest_states rows before: ${statesBefore}`)
  console.log(`[tac555] run log: ${log.path}\n`)

  const records: UnitRecord[] = []

  for (const unit of units) {
    for (const arm of ARMS) {
      const ctx = { ...baseCtx, recentVisits: unit.visits } as typeof baseCtx
      ctx.currentMessage = {
        id: randomUUID(),
        providerMessageId: `tac555-${unit.id}-${arm}`,
        body: unit.body,
        receivedAt: now,
        channel,
        referralSource: null,
      }

      let category: string | null = null
      let reply: string | null = null
      let error: string | null = null
      let invalid = false
      let calls = 0

      try {
        const classification = await classifyStage(ctx)
        ctx.classification = classification
        category = classification.category
        ctx.corpus = await retrieveCorpusStage(ctx)
        ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
          ? await retrieveKnowledgeStage(ctx, classification.category, unit.body)
          : []

        const ragChunks: AiVoiceCorpusChunk[] = (ctx.corpus ?? []).map((c) => ({
          id: c.id,
          text: c.text,
          sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
          relevanceScore: c.similarity,
        }))
        const knowledgeChunks: AiKnowledgeCorpusChunk[] | undefined =
          ctx.knowledgeCorpus === null
            ? undefined
            : ctx.knowledgeCorpus.map((c) => ({
                id: c.id,
                text: c.text,
                sourceType: c.sourceType,
                primaryTags: c.primaryTags,
                secondaryTags: c.secondaryTags,
                relevanceScore: c.similarity,
              }))

        const composed = composePrompt({
          category: classification.category,
          persona: ctx.venue.brandPersona,
          venueInfo: ctx.venue.venueInfo,
          ragChunks,
          knowledgeChunks,
          runtime: buildAiRuntime(ctx),
          channel: ctx.conversationChannel,
        })

        // THE ONE DIFFERENCE BETWEEN THE ARMS. Both clauses come out, each
        // checked to have actually changed the prompt.
        let systemBody = composed.systemPrompt
        if (arm === 'control') {
          for (const [label, clause] of [
            ['R21', R21_CLAUSE],
            ['R23', R23_CLAUSE],
          ] as const) {
            const stripped = systemBody.replace(clause, '')
            if (stripped === systemBody) {
              error = `control slice did not change the prompt (${label})`
              invalid = true
              break
            }
            systemBody = stripped
          }
        }

        if (!invalid) {
          // VOICE_FIDELITY_INSTRUCTION is appended exactly as generateMessage
          // appends it. composePrompt does not include it, and without it the
          // model answers voiceFidelity on a 1-to-10 scale the schema's [0,1]
          // refine rejects, which the TAC-513 harness hit on 11 of its first
          // 14 generations.
          const system = `${systemBody}\n\n${VOICE_FIDELITY_INSTRUCTION}`
          for (let attempt = 0; attempt < 4; attempt += 1) {
            calls += 1
            try {
              const { object } = await generateObject({
                model: getGenerationModel(),
                system,
                prompt: composed.userPrompt,
                schema: GeneratedMessageSchema,
                temperature: 0.7,
                maxOutputTokens: MAX_OUTPUT_TOKENS,
              })
              reply = object.body
              error = null
              break
            } catch (e) {
              error = e instanceof Error ? e.message : String(e)
            }
          }
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }

      // A FAILED UNIT IS NOT A RESULT. It can meet no expectation whatever its
      // flags read (TAC-502 scored a run in which every call failed as clean).
      if (reply === null) invalid = true

      const judgeVerdict = reply === null ? null : await judgeRepeatedly(unit.body, reply, unit.historyItems)
      if (judgeVerdict !== null && judgeVerdict.failures === JUDGE_REPS) invalid = true

      const count = reply === null ? { found: false, matches: [] } : findCountClaim(reply)
      const freq = reply === null ? { found: false, matches: [] } : findVisitFrequencyClaim(reply)
      const others =
        reply === null
          ? { found: false, matches: [] }
          : findOtherHistoryItems(reply, unit.historyItems, unit.namedItem)

      const rec: UnitRecord = {
        unitId: unit.id,
        population: unit.population,
        arm,
        namedItem: unit.namedItem,
        dominantItem: unit.dominantItem,
        historyItems: unit.historyItems,
        guestMessage: unit.body,
        category,
        reply,
        invalid,
        error,
        generationCalls: calls,
        judge: judgeVerdict,
        recognizes:
          judgeVerdict !== null &&
          majority(judgeVerdict.recognizesPriorOrder, judgeVerdict.reps, judgeVerdict.failures),
        claimsUsual:
          judgeVerdict !== null &&
          majority(judgeVerdict.claimsMostFrequent, judgeVerdict.reps, judgeVerdict.failures),
        recites:
          judgeVerdict !== null &&
          majority(judgeVerdict.recitesHistory, judgeVerdict.reps, judgeVerdict.failures),
        statesCountJudge:
          judgeVerdict !== null &&
          majority(judgeVerdict.statesCount, judgeVerdict.reps, judgeVerdict.failures),
        countClaimMatches: count.matches,
        visitFrequencyMatches: freq.matches,
        otherHistoryItemMatches: others.matches,
      }
      records.push(rec)
      log.appendUnit(rec as unknown as Record<string, unknown>)

      const mark = rec.invalid ? 'INVALID' : rec.recognizes || rec.claimsUsual ? 'recognised' : '-'
      console.log(
        `  ${unit.id} ${arm.padEnd(9)} [${(category ?? '?').padEnd(18)}] ${mark.padEnd(10)} ${JSON.stringify(reply ?? error)}`,
      )
    }
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  report(records, statesBefore ?? 0, statesAfter ?? 0, startedAt)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(records: UnitRecord[], statesBefore: number, statesAfter: number, startedAt: Date) {
  const pick = (population: 'frequent' | 'new', arm: Arm) =>
    records.filter((r) => r.population === population && r.arm === arm)

  console.log(`\n${'='.repeat(78)}`)
  console.log('TAC-555 usual-order recognition')
  console.log(`${'='.repeat(78)}\n`)

  const failures: string[] = []

  for (const arm of ARMS) {
    const freq = pick('frequent', arm)
    const valid = freq.filter((r) => !r.invalid)
    const recognised = valid.filter((r) => r.recognizes || r.claimsUsual)
    const usual = valid.filter((r) => r.claimsUsual)
    console.log(
      `arm A (frequent item), ${arm}: recognised ${recognised.length}/${valid.length} valid (${freq.length - valid.length} invalid), of which "usual" ${usual.length}`,
    )
    // Recognition BY CATEGORY. This is the sharpest read on R21's
    // jurisdictional sentence: if it holds on the acknowledgment units, the
    // category veto is genuinely closed.
    const byCategory = new Map<string, { n: number; hit: number }>()
    for (const r of valid) {
      const k = r.category ?? '?'
      const b = byCategory.get(k) ?? { n: 0, hit: 0 }
      b.n += 1
      if (r.recognizes || r.claimsUsual) b.hit += 1
      byCategory.set(k, b)
    }
    for (const [cat, b] of [...byCategory.entries()].sort()) {
      console.log(`    ${cat.padEnd(20)} ${b.hit}/${b.n}`)
    }
  }

  // BAR 1: the treatment arm on the frequent population.
  {
    const valid = pick('frequent', 'treatment').filter((r) => !r.invalid)
    const hit = valid.filter((r) => r.recognizes || r.claimsUsual).length
    const ok = hit >= FREQUENT_BAR && valid.length >= FREQUENT_BAR
    if (!ok) failures.push(`arm A treatment recognised ${hit}/${valid.length}, bar is ${FREQUENT_BAR}`)
    console.log(`\n${ok ? 'PASS' : 'FAIL'}  bar: arm A treatment >= ${FREQUENT_BAR} recognised (got ${hit}/${valid.length} valid)`)
  }

  // CEILING: nothing in arm A may recite history or state a count. A breach
  // fails the arm whatever the recognition rate reads.
  for (const arm of ARMS) {
    const valid = pick('frequent', arm).filter((r) => !r.invalid)
    const recites = valid.filter((r) => r.recites)
    const counts = valid.filter((r) => r.statesCountJudge || r.countClaimMatches.length > 0)
    const ok = recites.length === 0 && counts.length === 0
    if (!ok && arm === 'treatment') {
      failures.push(
        `arm A treatment ceiling breached: ${recites.length} recite history, ${counts.length} state a count`,
      )
    }
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ceiling (${arm}): recites history ${recites.length}, states a count ${counts.length}`,
    )
    for (const r of counts) {
      console.log(`      ${r.unitId}: judge=${r.statesCountJudge} regex=${JSON.stringify(r.countClaimMatches)}`)
    }
  }

  // BAR 2: no false "usual" on the new population, in EITHER arm.
  for (const arm of ARMS) {
    const valid = pick('new', arm).filter((r) => !r.invalid)
    const claims = valid.filter((r) => r.claimsUsual || r.recognizes)
    const ok = claims.length <= NEW_FALSE_CLAIM_CEILING
    if (!ok) failures.push(`arm B ${arm}: ${claims.length} false prior-order claims, ceiling is ${NEW_FALSE_CLAIM_CEILING}`)
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  bar: arm B ${arm} false "usual"/"had it before" claims ${claims.length}/${valid.length} valid (ceiling ${NEW_FALSE_CLAIM_CEILING})`,
    )
    for (const r of claims) console.log(`      ${r.unitId}: ${JSON.stringify(r.reply)}`)
  }

  // BAR 3: templating. TAC-548's detector, whose default share is already the
  // quarter this ticket asks for.
  {
    const bodies = pick('frequent', 'treatment')
      .filter((r) => !r.invalid && r.reply !== null)
      .map((r) => r.reply as string)
    const repeats = repeatedPhrases(bodies, { n: 5, maxShare: TEMPLATE_MAX_SHARE })
    const ok = repeats.length === 0
    if (!ok) failures.push(`templating: ${repeats.length} phrase(s) in more than a quarter of arm A treatment replies`)
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  bar: no phrase in more than ${Math.round(TEMPLATE_MAX_SHARE * 100)}% of ${bodies.length} arm A treatment replies`,
    )
    for (const p of repeats) console.log(`      "${p.phrase}" in ${p.replies}/${bodies.length}`)
  }

  // ADVISORY, NOT BARS. Reported prominently because a visit-frequency claim
  // with no number is the R23 breach a count check structurally cannot see,
  // and it is the specific risk this change introduces. Not pre-registered, so
  // it does not fail the run: Jaipal reads these and decides.
  {
    const flagged = records.filter((r) => !r.invalid && r.visitFrequencyMatches.length > 0)
    console.log(`\nADVISORY (not a bar) visit-frequency claims with no number: ${flagged.length}`)
    for (const r of flagged) {
      console.log(`      ${r.unitId} ${r.arm}: ${JSON.stringify(r.visitFrequencyMatches)} | ${JSON.stringify(r.reply)}`)
    }
  }
  {
    const flagged = records.filter((r) => !r.invalid && r.otherHistoryItemMatches.length > 0)
    console.log(`ADVISORY (not a bar) replies naming a DIFFERENT past item (R15 cap): ${flagged.length}`)
    for (const r of flagged) {
      console.log(`      ${r.unitId} ${r.arm}: ${JSON.stringify(r.otherHistoryItemMatches)} | ${JSON.stringify(r.reply)}`)
    }
  }

  const invalid = records.filter((r) => r.invalid)
  console.log(`\ninvalid units: ${invalid.length}/${records.length}`)
  for (const r of invalid) console.log(`      ${r.unitId} ${r.arm}: ${r.error ?? 'no reply'}`)

  console.log(`\nguest_states rows: ${statesBefore} before, ${statesAfter} after`)
  console.log(`elapsed: ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s`)

  console.log(`\n${'-'.repeat(78)}`)
  console.log(failures.length === 0 ? 'ALL PRE-REGISTERED BARS AND CEILINGS PASS' : 'FAILED:')
  for (const f of failures) console.log(`  - ${f}`)
  console.log(`${'-'.repeat(78)}`)
  console.log('\nRead the bodies, not only the table. A rate cannot tell a correct')
  console.log('recognition from one that named the wrong item.\n')
}

void main()
