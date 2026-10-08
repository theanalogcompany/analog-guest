/**
 * golden-set.ts - what does v1 say, and what does v2 say, to the questions a
 * guest actually asks?
 *
 *   npm run measure-golden-set
 *   npm run measure-golden-set -- --questions=hours,oat-milk --concurrency=4
 *
 * NO GRADER, NO JUDGE, NO PASS/FAIL (owner-ruled 2026-10-08). The output is
 * `question | v1 | v2` for a human to read at /admin/tests/golden, and the
 * set deliberately carries no expected answers: deciding what passing means
 * is the operator's job on this one. That is why this harness breaks the
 * measurement convention's BAR/CEILING shape (scripts/CLAUDE.md #8) - it is
 * not measuring a rate, so there is no number to pre-register. Every other
 * property of the convention still holds: timestamped JSONL, checkpoint per
 * unit, self-describing header, and a failed arm recorded as a failure rather
 * than as silence.
 *
 * THE QUESTIONS ARE CODE - GOLDEN_QUESTIONS in lib/eval/golden-set.ts. No SQL
 * to add one (decision 0011's direction; migration 078's header has the why).
 *
 * EVERY QUESTION IS A COLD OPEN, so both arms see a stranger with zero
 * visits. That is exact parity and also where the engines differ most: v2
 * resolves to first_contact and will often spend part of the reply on a
 * welcome. Real behaviour, not an artifact.
 *
 * WHAT THE OUTPUT CANNOT TELL YOU, stated here because the columns invite it:
 *   - bubble COUNT. Both arms record real bubble boundaries, but v1's test
 *     path pins the probabilistic sentence split off (TEST_RUN_SPLIT_RNG),
 *     so a v1 reply splits only where a tail earns its own bubble - the
 *     further-help offer, the getting-to-know-you question - while v2 emits
 *     `messages[]` directly. First full run: v1 26 single / 5 two, v2
 *     19/8/3/1. Part of that gap is this harness, so do not read the count
 *     as a difference between the engines.
 *   - whether v1 would have sent or queued. `draftInboundReply` stops before
 *     the 20 approval triggers and the four post-generation checks, so v1 has
 *     no route to report. v2's gate verdict is recorded for v2 alone.
 *   - anything across two runs in different open/closed states. The prompt
 *     carries an open/closed line, so a run after close hedges through all 31
 *     questions. The state is in the run header and on the page.
 *
 * IT WRITES TO PRODUCTION `messages`. The v1 arm materializes each question
 * as rows against a per-venue, per-slot `is_test_synthetic` guest and deletes
 * them on the next call - pre-existing by design (v1-arm.ts explains why a
 * hand-built context would be worse), but a full run churns ~60 rows across
 * up to 10 synthetic guests. RUN IT DURING THE VENUE'S OPEN HOURS.
 */

import { execFileSync } from 'node:child_process'
import { createAdminClient } from '@/lib/db/admin'
import {
  draftV1ForSandbox,
  SANDBOX_SLOTS,
} from '@/app/admin/(authed)/playground/api/run/v1-arm'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { V2_PROMPT_VERSION } from '@/lib/ai/v2/template'
import { GOLDEN_QUESTIONS, validateGoldenSet } from '@/lib/eval/golden-set'
import { EMPTY_MEMORY, EMPTY_PROFILE } from '@/lib/relationship/profile'
import { runTurn } from '@/lib/relationship/run-turn'
import { VenueHoursSchema } from '@/lib/schemas/venue-info'
import { resolveOpenState } from '@/lib/schemas/venue-hours'
import type { GoldenQuestion, GoldenV1, GoldenV2 } from '@/lib/schemas/golden'
import { createRunLog } from './run-log'

/**
 * Questions in flight at once. Capped by SANDBOX_SLOTS because that is the
 * real constraint: each in-flight v1 arm needs its own synthetic guest, and
 * there are ten slots. Nothing like template-regression's 64 - the binding
 * limit here is slots, not rate limits.
 */
const DEFAULT_CONCURRENCY = 8

// A type alias rather than an interface so it carries an implicit index
// signature and satisfies `appendUnit`'s Record<string, unknown>.
type Unit = {
  question: GoldenQuestion
  v1: GoldenV1
  v2: GoldenV2
}

async function runQuestion(
  venueId: string,
  question: GoldenQuestion,
  slot: number,
): Promise<Unit> {
  // The two arms are independent given the same inbound, so this is
  // max(v1, v2) rather than the sum - the same reasoning the playground route
  // uses. `allSettled`: an arm that throws costs its own column and nothing
  // else, because "v1 errored on this question" is a finding worth keeping
  // next to v2's answer.
  const v1Started = Date.now()
  const v2Started = Date.now()
  const [v2Settled, v1Settled] = await Promise.allSettled([
    runTurn({
      venueId,
      guestId: null,
      inbound: [question.question],
      sessionHistory: [],
      // A stranger: no profile, no memory, no visits. Matches what the v1 arm
      // sees by construction, since its synthetic guest has no transactions
      // and a transcript one message long.
      session: {
        profile: EMPTY_PROFILE,
        memory: EMPTY_MEMORY,
        facts: { visitCount: 0, replyCount: 1, daysSinceLastContact: null },
      },
    }),
    draftV1ForSandbox({
      venueId,
      sessionHistory: [],
      inbound: [question.question],
      slot,
    }),
  ])

  let v1: GoldenV1
  if (v1Settled.status === 'rejected') {
    v1 = {
      ok: false,
      stage: 'threw',
      error:
        v1Settled.reason instanceof Error
          ? v1Settled.reason.message
          : String(v1Settled.reason),
      durationMs: Date.now() - v1Started,
    }
  } else if (!v1Settled.value.ok) {
    v1 = {
      ok: false,
      stage: v1Settled.value.stage,
      error: v1Settled.value.error,
      durationMs: Date.now() - v1Started,
    }
  } else {
    const draft = v1Settled.value.data
    v1 = {
      ok: true,
      bubbles: draft.bubbles,
      category: draft.category,
      recognitionState: draft.recognitionState,
      substitute: draft.substitute,
      promptVersion: draft.promptVersion,
      durationMs: Date.now() - v1Started,
    }
  }

  let v2: GoldenV2
  if (v2Settled.status === 'rejected') {
    v2 = {
      ok: false,
      stage: 'threw',
      error:
        v2Settled.reason instanceof Error
          ? v2Settled.reason.message
          : String(v2Settled.reason),
      durationMs: Date.now() - v2Started,
    }
  } else {
    const trace = v2Settled.value
    v2 = trace.generation.ok
      ? {
          ok: true,
          messages: trace.generation.output.messages,
          stateKey: trace.state.resolvedKey,
          gateVerdict: trace.gate?.verdict ?? null,
          gateMatched: (trace.gate?.matched ?? []).map((m) => m.policyKey),
          promptVersion: V2_PROMPT_VERSION,
          durationMs: trace.totalDurationMs,
        }
      : {
          ok: false,
          stage: 'generation',
          error: trace.generation.error,
          durationMs: trace.totalDurationMs,
        }
  }

  return { question, v1, v2 }
}

/** Run `items` with at most `limit` in flight, each worker owning one slot. */
async function withSlots<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, slot: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async (_, slot) => {
      // A worker keeps its slot for the whole run, so the synthetic guest a
      // worker writes to is never touched by another worker. Handing out
      // slots per ITEM instead would let two items share a slot the moment
      // one finished early, which is the bug the slots exist to prevent.
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        results[index] = await run(items[index], slot)
      }
    }),
  )
  return results
}

function gitValue(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2)
  const problems = validateGoldenSet()
  if (problems.length > 0) {
    // Offline boundary, fails closed and loudly: an hour of model calls lost
    // to a typo in the array is the failure being prevented.
    console.error('the golden set does not satisfy its own schema:')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }

  const filter = flags
    .find((f) => f.startsWith('--questions='))
    ?.split('=')[1]
    ?.split(',')
    .filter((s) => s.length > 0)
  const concurrencyFlag = flags.find((f) => f.startsWith('--concurrency='))
  const requested = concurrencyFlag
    ? Number.parseInt(concurrencyFlag.split('=')[1], 10)
    : DEFAULT_CONCURRENCY
  if (!Number.isInteger(requested) || requested < 1) {
    console.error('--concurrency must be a positive integer')
    process.exit(1)
  }
  const concurrency = Math.min(requested, SANDBOX_SLOTS)
  if (concurrency !== requested)
    console.warn(
      `--concurrency=${requested} capped to ${SANDBOX_SLOTS}: one in-flight v1 arm needs its own sandbox guest and there are ${SANDBOX_SLOTS} slots`,
    )

  const questions = GOLDEN_QUESTIONS.filter(
    (q) => filter === undefined || filter.includes(q.key),
  )
  if (questions.length === 0) {
    console.error('--questions matched nothing')
    process.exit(1)
  }
  const fullRun = questions.length === GOLDEN_QUESTIONS.length
  if (!fullRun)
    console.warn(
      `FILTERED: ${questions.length} of ${GOLDEN_QUESTIONS.length} questions. Stored as a partial run.`,
    )

  // TEST_VENUE_ID when it names a real venue, else the venue every prior v2
  // measurement ran on, so these replies sit beside those runs.
  const supabase = createAdminClient()
  const envVenueId = process.env.TEST_VENUE_ID
  let venue: {
    id: string
    name: string
    slug: string
    timezone: string
  } | null = null
  if (envVenueId) {
    const { data } = await supabase
      .from('venues')
      .select('id, name, slug, timezone')
      .eq('id', envVenueId)
      .maybeSingle()
    venue = data
    if (!venue)
      console.warn(
        `TEST_VENUE_ID ${envVenueId} matches no venue - falling back to the default measurement venue`,
      )
  }
  if (!venue) {
    const { data, error } = await supabase
      .from('venues')
      .select('id, name, slug, timezone')
      .ilike('name', "Le Mil's Coffee")
      .maybeSingle()
    if (error || !data) {
      console.error(`no usable venue: ${error?.message ?? 'not found'}`)
      process.exit(1)
    }
    venue = data
  }

  // The open/closed line the prompt carries. Three-state, never a boolean:
  // "the hours were unreadable" must stay distinguishable from "the venue was
  // closed", or a failed read is recorded as a stated closure.
  const configRow = await supabase
    .from('venue_configs')
    .select('venue_info')
    .eq('venue_id', venue.id)
    .maybeSingle()
  //
  // The HOURS SUB-OBJECT, never the whole VenueInfoSchema: that schema
  // requires `address`, so a venue missing an unrelated field would have its
  // open state read as unknown for a reason that has nothing to do with hours
  // (the trap loadVenueClock in lib/agent/instagram-scan-greeting.ts
  // documents).
  const rawInfo = configRow.data?.venue_info
  const parsedHours =
    rawInfo != null && typeof rawInfo === 'object' && !Array.isArray(rawInfo)
      ? VenueHoursSchema.safeParse(
          (rawInfo as Record<string, unknown>).hours ?? {},
        )
      : null
  const openState =
    parsedHours?.success === true
      ? resolveOpenState(parsedHours.data, venue.timezone, new Date()).state
      : 'unknown'
  if (openState !== 'open')
    console.warn(
      `\nVENUE IS ${openState.toUpperCase()}. The prompt carries that line, so every reply in` +
        `\nthis run will read differently from one taken mid-morning - and this run is not` +
        `\ncomparable with one taken in another state. Run during open hours for the set` +
        `\nanyone is going to read (scripts/CLAUDE.md).\n`,
    )

  const gitSha = gitValue(['rev-parse', 'HEAD'])
  const gitSubject = gitValue(['log', '-1', '--format=%s'])
  const gitDirty = (gitValue(['status', '--porcelain']) ?? '').length > 0

  const log = createRunLog({
    name: 'golden-set',
    meta: {
      arm: `${venue.slug} v1-vs-v2`,
      venueId: venue.id,
      venueName: venue.name,
      venueOpenState: openState,
      v1PromptVersion: PROMPT_VERSION,
      v2PromptVersion: V2_PROMPT_VERSION,
      questions: questions.length,
      fullRun,
      concurrency,
      gitDirty,
      gitSubject,
    },
  })
  console.log(`\nrun log: ${log.path}`)
  console.log(
    `${questions.length} questions, ${concurrency} at a time, ${venue.name} (${openState})\n`,
  )

  const startedAt = new Date().toISOString()
  const units = await withSlots(questions, concurrency, async (q, slot) => {
    const unit = await runQuestion(venue.id, q, slot)
    // Checkpoint per unit: the expensive half is the model calls, and losing
    // them to a late throw in the cheap half is the specific failure the
    // run-log convention exists for.
    log.appendUnit(unit)
    const v1Line = unit.v1.ok
      ? (unit.v1.substitute ?? unit.v1.bubbles.join(' / ')).slice(0, 60)
      : `ERROR ${unit.v1.stage}`
    const v2Line = unit.v2.ok
      ? unit.v2.messages.join(' / ').slice(0, 60)
      : `ERROR ${unit.v2.stage}`
    console.log(`${q.key}\n  v1: ${v1Line}\n  v2: ${v2Line}`)
    return unit
  })

  const v1Failures = units.filter((u) => !u.v1.ok).length
  const v2Failures = units.filter((u) => !u.v2.ok).length
  console.log(
    `\n${units.length} questions run. v1 errors: ${v1Failures}, v2 errors: ${v2Failures}.`,
  )

  // The viewing copy for /admin/tests/golden. The JSONL above is the record;
  // a failure here warns and exits nonzero-safe rather than losing the run.
  const runInsert = await supabase
    .from('golden_runs')
    .insert({
      venue_id: venue.id,
      git_sha: gitSha,
      git_subject: gitSubject,
      git_dirty: gitDirty,
      v1_prompt_version: PROMPT_VERSION,
      v2_prompt_version: V2_PROMPT_VERSION,
      venue_open_state: openState,
      questions_total: units.length,
      full_run: fullRun,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (runInsert.error || !runInsert.data) {
    console.error(
      `\ngolden_runs write failed (migration 078 applied?): ${runInsert.error?.message ?? 'no row'} - the JSONL run log is the record`,
    )
    return
  }
  const unitsInsert = await supabase.from('golden_run_units').insert(
    units.map((u) => ({
      run_id: runInsert.data.id,
      question_key: u.question.key,
      v1: u.v1,
      v2: u.v2,
    })),
  )
  if (unitsInsert.error) {
    console.error(
      `\ngolden_run_units write failed: ${unitsInsert.error.message} - the JSONL run log is the record`,
    )
    return
  }
  console.log(`\nstored: /admin/tests/golden (run ${runInsert.data.id})\n`)
}

void main()
