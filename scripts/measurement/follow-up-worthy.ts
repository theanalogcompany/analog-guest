// TAC-386 arm A: does `followUpWorthy` draw the line the rulings drew?
//
//   npm run measure-follow-up-worthy -- <venue-slug>
//
// WHAT MAKES THIS EVIDENCE rather than a demonstration: every case carries a
// hand-assigned `expected` written BEFORE the run, and the four false-positive
// arms below are hand-chosen from the rulings' own exclusions. Labelling after
// the fact, or deriving labels from the classifier's output, measures nothing —
// the bar was posted on TAC-386 before any of this generated.
//
// THE FOUR NAMED ARMS EACH HAVE A BAR OF ZERO. They are separate rather than
// pooled so a failure says WHICH line moved. Two of them (complaints, business
// inquiries) have a structural belt behind them in
// lib/agent/schedule-inquiry-followup.ts, so a hit there is a prompt failure
// with a working backstop; the other two (pure facts, small talk) have no belt,
// which is why they carry the same bar.
//
// It also measures the classifier's OUTPUT-TOKEN HEADROOM against its 200-token
// cap. Nothing measures that today, and the ordering is why it matters: the
// unbounded `reasoning` field precedes all three booleans, which is the shape
// that truncated generation in TAC-309 and the grounding check in TAC-367.

import {
  classifyMessage,
  MAX_CLASSIFIER_INPUT_CHARS,
} from '@/lib/ai/classify-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { createAdminClient } from '@/lib/db/admin'
import { createRunLog } from './run-log'
import {
  scoreArm,
  scoreFalsePositiveArm,
  scoreHeadroom,
  type ArmScore,
  type FalsePositiveArm,
  type ScoredCase,
} from './follow-up-worthy-score'

/** The cap in classify-message.ts. Read from there, not restated. */
const OUTPUT_TOKEN_CAP = 200

interface LabelledFixture {
  id: string
  body: string
}

/**
 * ARM A1 — pure facts. Ruling 1 of 2026-09-17 excluded a bare hours question
 * and the 2026-09-30 widening kept it: there is nothing to have worked out.
 * NO STRUCTURAL BELT behind this one, so the prompt is all there is.
 */
const A1_PURE_FACTS: LabelledFixture[] = [
  { id: 'a1-labor-day', body: 'are you open on Labor Day?' },
  { id: 'a1-close', body: 'what time do you close' },
  { id: 'a1-sunday', body: 'what time do you close on Sundays?' },
  { id: 'a1-open-early', body: 'do you open early in the summer?' },
  { id: 'a1-wifi', body: 'do you have wifi' },
  { id: 'a1-open-now', body: 'are you open right now?' },
]

/** ARM A2 — small talk. No belt behind this one either. */
const A2_SMALL_TALK: LabelledFixture[] = [
  { id: 'a2-neighborhood', body: 'this neighborhood is wild' },
  { id: 'a2-couch', body: 'love this couch' },
  { id: 'a2-good-day', body: 'hope you have a good day!' },
  { id: 'a2-photo', body: 'your photos always look so good' },
  { id: 'a2-thanks', body: 'ok cool, thanks' },
]

/**
 * ARM A3 — complaints. A human's job (ruled 2026-09-30). A cheerful check-in
 * three hours behind one of these is the worst thing this mechanism can emit.
 * Belted structurally by the `comp_complaint` refusal.
 */
const A3_COMPLAINTS: LabelledFixture[] = [
  { id: 'a3-stale', body: 'the muffin was stale' },
  { id: 'a3-wait', body: 'waited 20 minutes for a cortado' },
  { id: 'a3-wrong', body: 'my order was wrong again' },
  { id: 'a3-cold', body: 'the latte was cold by the time I got it' },
]

/**
 * ARM A4 — what an operator arranges rather than the venue answering.
 *
 * WIDENED 2026-09-30, narrowly, after the first run: the instruction said "a
 * business, press, wholesale or hiring inquiry" and `a4-event-space` still
 * fired, because the model read a private-event rental as a venue SERVICE
 * rather than a business enquiry. The same shape fired on eight real inbounds.
 * So each of the five is now named in the prompt, and each has cases here.
 *
 * NOT belted structurally: ruled explicitly that `event_question` and
 * `mechanic_request` stay off the scheduler's deny-list, because that would
 * also stop "can I bring my dog" and a pre-order. The prompt is the only gate
 * on this arm, which is why its bar is zero.
 */
const A4_OPERATOR_ARRANGED: LabelledFixture[] = [
  // wholesale / press / hiring / partnership
  { id: 'a4-wholesale', body: 'do you do wholesale pricing for offices?' },
  {
    id: 'a4-press',
    body: 'I write for a food blog, can I interview the owner?',
  },
  { id: 'a4-hiring', body: 'are you hiring baristas right now?' },
  {
    id: 'a4-partnership',
    body: 'we run a co-working space nearby, any interest in a partnership?',
  },
  // private events and space rental — the shape that breached the first run
  { id: 'a4-event-space', body: 'can I rent the space for a private event?' },
  { id: 'a4-buyout', body: 'could we book the whole cafe for a work party?' },
  // catering — fired on three real inbounds
  { id: 'a4-catering', body: 'do you offer catering' },
  { id: 'a4-catering-50', body: 'do you do catering for 50 people' },
  { id: 'a4-event-form', body: 'can you send me an event form' },
  // bookings and reservations
  { id: 'a4-reserve', body: 'can I reserve a table for six on Saturday?' },
]

/**
 * ARM A5 — explicit arrivals. Excluded by ruling 1 of 2026-09-17, dropped by the
 * widening because the trigger stopped being about visits, RESTORED 2026-09-30.
 * TAC-297's arrival capture owns these, and it is fewer messages.
 *
 * Two of these are real Le Mil's inbounds that fired on the first run.
 */
const A5_ARRIVALS: LabelledFixture[] = [
  {
    id: 'a5-walking-over',
    body: 'i\u2019m walking over. can you get a pink panther ready for me',
  },
  { id: 'a5-omw', body: 'omw can you get my order ready' },
  { id: 'a5-heading-in', body: 'heading in now, save me a cortado' },
  { id: 'a5-here', body: 'here now, just walked in' },
]

/**
 * The positive control. Without it a classifier stuck on `false` would pass
 * every arm above with a perfect score, which is the single most important
 * thing this harness must not be able to report.
 */
const POSITIVE_CONTROL: LabelledFixture[] = [
  { id: 'p-parking', body: 'where do I park around there' },
  {
    id: 'p-directions',
    body: 'whats the easiest way to get to you from the mission',
  },
  {
    id: 'p-beans',
    body: 'which bag should I buy if I like something chocolatey',
  },
  { id: 'p-brew', body: 'how should I brew the beans I got from you' },
  { id: 'p-dog', body: 'can I bring my dog' },
  { id: 'p-try', body: 'whats something I should try when I get there' },
  // The carve-out inside A4's exclusion: a PUBLIC event stays eligible (ruled
  // 2026-09-30). It is in the control rather than in A4 precisely because the
  // two lines sit next to each other in the prompt and the risk is the
  // exclusion swallowing this.
  { id: 'p-public-events', body: 'do you have any events coming up' },
  {
    id: 'p-events-november',
    body: 'do you have any events coming up in november?',
  },
]

interface RealInbound {
  id: string
  body: string
}

/** Every real guest inbound at this venue, oldest first. */
async function loadRealInbounds(venueSlug: string): Promise<RealInbound[]> {
  const supabase = createAdminClient()
  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .select('id')
    .eq('slug', venueSlug)
    .maybeSingle()
  if (venueError || !venue) {
    throw new Error(
      `could not find venue "${venueSlug}": ${venueError?.message}`,
    )
  }

  const { data, error } = await supabase
    .from('messages')
    .select('id, body, created_at')
    .eq('venue_id', venue.id)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: true })
  if (error) throw new Error(`could not read inbounds: ${error.message}`)

  return (data ?? [])
    .filter((row) => (row.body ?? '').trim().length > 0)
    .map((row) => ({ id: row.id, body: row.body as string }))
}

interface Classified {
  worthy: boolean
  /**
   * The category, which decides whether the STRUCTURAL BELT catches this message
   * when followUpWorthy is wrong.
   *
   * Recorded because the first run of this harness did not, and that turned out
   * to be the difference between "the prompt slipped" and "the prompt slipped and
   * nothing behind it catches the slip". A false positive in a belted category is
   * a prompt defect; the same one in an unbelted category ships.
   */
  category: string
  reasoning: string
  outputTokens: number | null
}

/**
 * Categories lib/agent/schedule-inquiry-followup.ts refuses outright.
 *
 * Restated here rather than imported: the point of the report is to check the
 * two independently, and importing the set would make the harness agree with the
 * code by construction.
 */
const BELTED = new Set([
  'comp_complaint',
  'manual',
  'opt_out',
  'acknowledgment',
])

async function classifyOne(body: string): Promise<Classified> {
  const r = await classifyMessage({ inboundBody: body })
  if (!r.ok) throw new Error(`classifier failed on "${body}": ${r.error}`)
  const usage = r.data.usage as { outputTokens?: number } | undefined
  return {
    worthy: r.data.followUpWorthy,
    category: r.data.category,
    reasoning: r.data.reasoning,
    outputTokens: usage?.outputTokens ?? null,
  }
}

async function runFalsePositiveArm(
  name: string,
  fixtures: readonly LabelledFixture[],
  log: ReturnType<typeof createRunLog>,
  tokens: number[],
): Promise<FalsePositiveArm> {
  const results: {
    id: string
    body: string
    actual: boolean
    reasoning: string
  }[] = []
  for (const fixture of fixtures) {
    const out = await classifyOne(fixture.body)
    if (out.outputTokens !== null) tokens.push(out.outputTokens)
    // Checkpoint per unit: the expensive half is the model calls, and losing
    // them to a late throw in the cheap half is the specific failure.
    log.appendUnit({
      arm: name,
      id: fixture.id,
      body: fixture.body,
      expected: false,
      actual: out.worthy,
      category: out.category,
      belted: BELTED.has(out.category),
      reasoning: out.reasoning,
      outputTokens: out.outputTokens,
    })
    results.push({
      id: fixture.id,
      body: fixture.body,
      actual: out.worthy,
      reasoning: out.reasoning,
    })
  }
  return scoreFalsePositiveArm(name, results)
}

function pct(n: number | null): string {
  return n === null ? 'n/a (fired on nothing)' : `${(n * 100).toFixed(1)}%`
}

function reportArm(score: ArmScore): void {
  console.log(`\n--- ${score.name} (${score.total} cases) ---`)
  console.log(
    `  tp ${score.truePositives}  fp ${score.falsePositives}  tn ${score.trueNegatives}  fn ${score.falseNegatives}`,
  )
  console.log(
    `  precision ${pct(score.precision)}  recall ${pct(score.recall)}`,
  )
  if (score.disagreements.length > 0) {
    console.log(`  disagreements (${score.disagreements.length}):`)
    for (const d of score.disagreements) {
      console.log(
        `    [${d.expected ? 'expected true' : 'expected false'}] ${d.id}: ${JSON.stringify(d.body)}`,
      )
      if (d.reasoning) console.log(`        model: ${d.reasoning}`)
    }
  }
}

async function main(): Promise<void> {
  const venueSlug = process.argv[2]
  if (!venueSlug) {
    console.error('usage: npm run measure-follow-up-worthy -- <venue-slug>')
    process.exit(1)
  }

  const log = createRunLog({
    name: 'tac386-follow-up-worthy',
    meta: {
      arm: `followUpWorthy:${venueSlug}`,
      // The convention asks for the code state as well as the arm. The
      // classifier prompt does not embed this string, so a bump alone does not
      // change what this measures; it is recorded so a run can be placed.
      promptVersion: PROMPT_VERSION,
      venueSlug,
      outputTokenCap: OUTPUT_TOKEN_CAP,
      classifierInputCap: MAX_CLASSIFIER_INPUT_CHARS,
      bars: {
        falsePositiveArms: 'zero true in each of A1..A4',
        positiveControl: 'must fire, or the run proves nothing',
      },
    },
  })
  console.log(`run log: ${log.path}`)

  const tokens: number[] = []

  // The four named arms, each bar zero.
  const arms: FalsePositiveArm[] = []
  for (const [name, fixtures] of [
    ['A1 pure facts', A1_PURE_FACTS],
    ['A2 small talk', A2_SMALL_TALK],
    ['A3 complaints', A3_COMPLAINTS],
    ['A4 operator-arranged', A4_OPERATOR_ARRANGED],
    ['A5 explicit arrivals', A5_ARRIVALS],
  ] as const) {
    arms.push(await runFalsePositiveArm(name, fixtures, log, tokens))
  }

  // The positive control.
  const controlCases: ScoredCase[] = []
  for (const fixture of POSITIVE_CONTROL) {
    const out = await classifyOne(fixture.body)
    if (out.outputTokens !== null) tokens.push(out.outputTokens)
    log.appendUnit({
      arm: 'positive control',
      id: fixture.id,
      body: fixture.body,
      expected: true,
      actual: out.worthy,
      category: out.category,
      belted: BELTED.has(out.category),
      reasoning: out.reasoning,
      outputTokens: out.outputTokens,
    })
    controlCases.push({
      id: fixture.id,
      body: fixture.body,
      expected: true,
      actual: out.worthy,
      reasoning: out.reasoning,
    })
  }
  const control = scoreArm('positive control', controlCases)

  // The real inbounds. UNLABELLED HERE ON PURPOSE: this repo's real traffic is
  // a handful of messages, and hard-coding labels for them in a committed file
  // would make this arm a fixture set that drifts from the table. The run prints
  // each body with the verdict for reading, and the PR records the hand-read.
  const real = await loadRealInbounds(venueSlug)
  const realResults: {
    id: string
    body: string
    worthy: boolean
    category: string
    reasoning: string
  }[] = []
  for (const inbound of real) {
    const out = await classifyOne(inbound.body)
    if (out.outputTokens !== null) tokens.push(out.outputTokens)
    log.appendUnit({
      arm: 'real inbounds',
      id: inbound.id,
      body: inbound.body,
      actual: out.worthy,
      category: out.category,
      belted: BELTED.has(out.category),
      reasoning: out.reasoning,
      outputTokens: out.outputTokens,
    })
    realResults.push({
      id: inbound.id,
      body: inbound.body,
      worthy: out.worthy,
      category: out.category,
      reasoning: out.reasoning,
    })
  }

  // ---- Report ----
  console.log(`\n=== TAC-386 arm A: followUpWorthy at ${venueSlug} ===`)

  let allArmsPassed = true
  for (const arm of arms) {
    reportArm(arm.score)
    console.log(`  BAR (zero true): ${arm.passed ? 'PASS' : 'FAIL'}`)
    if (!arm.passed) {
      allArmsPassed = false
      for (const f of arm.fired) {
        console.log(`    FIRED: ${f.id}: ${JSON.stringify(f.body)}`)
        if (f.reasoning) console.log(`        model: ${f.reasoning}`)
      }
    }
  }

  reportArm(control)
  // A classifier stuck on false passes every arm above. This is the control
  // that makes those passes mean something.
  const controlFired = control.truePositives > 0
  console.log(
    `  CONTROL (must fire at all): ${controlFired ? 'PASS' : 'FAIL — the field is inert, so every arm above proves nothing'}`,
  )

  console.log(`\n--- real inbounds at ${venueSlug} (${realResults.length}) ---`)
  for (const r of realResults) {
    const belt = BELTED.has(r.category) ? ' [BELTED]' : ''
    console.log(
      `  ${r.worthy ? 'TRUE ' : 'false'} (${r.category}${belt}) ${JSON.stringify(r.body)}`,
    )
    console.log(`        model: ${r.reasoning}`)
  }
  console.log(
    `  ${realResults.filter((r) => r.worthy).length} of ${realResults.length} classified follow-up-worthy. HAND-READ these against the rulings.`,
  )

  const headroom = scoreHeadroom(OUTPUT_TOKEN_CAP, tokens)
  console.log(`\n--- output-token headroom (cap ${headroom.cap}) ---`)
  console.log(
    `  max ${headroom.max}, mean ${headroom.mean.toFixed(1)}, worst utilisation ${(headroom.worstUtilisation * 100).toFixed(1)}%`,
  )
  console.log(
    `  any call at or over the cap: ${headroom.anyAtCap ? 'YES — truncation risk, raise the cap in this PR' : 'no'}`,
  )

  console.log(
    `\nOVERALL: ${allArmsPassed && controlFired ? 'every bar met' : 'A BAR BREACHED — report and stop'}`,
  )
  console.log(`run log: ${log.path}`)
  if (!allArmsPassed || !controlFired) process.exitCode = 1
}

void main()
