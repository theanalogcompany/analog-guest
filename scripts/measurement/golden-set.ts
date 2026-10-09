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
 * A SCENARIO WITH NO `history` IS A COLD OPEN, so both arms see a stranger
 * with zero visits. That is exact parity and also where the engines differ
 * most: v2 resolves to first_contact and will often spend part of the reply on
 * a welcome. Real behaviour, not an artifact.
 *
 * A SCENARIO WITH `history` CARRIES ITS OWN PAST MESSAGES, authored in the
 * code array (ruled 2026-10-08). Both arms get the same two values - v1
 * materializes them as `messages` rows so its context is built by production's
 * own queries, v2 gets them as `sessionHistory` - and NO visit, profile or
 * memory is declared to either arm. Anything a scenario needs the guest to
 * have done is in the transcript, where both arms read it.
 *
 * NOT EVERY SCENARIO RUNS. Only `driver: 'inbound'` does; the harness warns
 * which ones it skipped and why, and the page lists them.
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
 *     carries an open/closed line, so a run after close hedges through every
 *     scenario in it. The state is in the run header and on the page.
 *
 * IT WRITES TO PRODUCTION `messages`. The v1 arm materializes each scenario's
 * history and inbound as rows against a per-venue, per-slot
 * `is_test_synthetic` guest and deletes them on the next call - pre-existing
 * by design (v1-arm.ts explains why a hand-built context would be worse), but
 * a full run churns a couple of hundred rows across up to 10 synthetic guests.
 * RUN IT DURING THE VENUE'S OPEN HOURS.
 */

import { execFileSync } from 'node:child_process'
import { createAdminClient } from '@/lib/db/admin'
import {
  draftV1ForSandbox,
  draftV1FollowupForSandbox,
  SANDBOX_SLOTS,
} from '@/app/admin/(authed)/playground/api/run/v1-arm'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { V2_PROMPT_VERSION } from '@/lib/ai/v2/template'
import {
  GOLDEN_QUESTIONS,
  RUNNABLE_DRIVERS,
  runnableGoldenQuestions,
  validateGoldenSet,
} from '@/lib/eval/golden-set'
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
  /** The one clock for this turn - real, or injected by `--at`. */
  now: Date,
): Promise<Unit> {
  // The two arms are independent given the same inbound, so this is
  // max(v1, v2) rather than the sum - the same reasoning the playground route
  // uses. `allSettled`: an arm that throws costs its own column and nothing
  // else, because "v1 errored on this question" is a finding worth keeping
  // next to v2's answer.
  const v1Started = Date.now()
  const v2Started = Date.now()
  // The turn's messages, and the conversation before it. BOTH ARMS GET THE
  // SAME TWO VALUES: v1 materializes the history as `messages` rows so its
  // context is built by production's own queries, v2 gets it as
  // `sessionHistory`. Nothing about the guest is declared to one arm and not
  // the other.
  const inbound = question.messages ?? [question.question]
  const history = (question.history ?? []).map((t) => ({
    role: t.role,
    text: t.text,
  }))
  // TWO THINGS v2 CANNOT BE ASKED, declined by name rather than asked
  // anyway. Running it would answer a DIFFERENT turn from v1's - one with no
  // photo, or one driven by an inbound that does not exist - and the column
  // would read as "v2 handled it".
  //
  // `runTurn` is built around an inbound: there is no proactive entry point,
  // and `question.question` on a proactive scenario is a bracketed display
  // label, so feeding it in would have v2 answering a stage direction.
  const v2SkipReason: { stage: string; error: string } | null =
    question.mediaUrls !== undefined
      ? {
          stage: 'media',
          error:
            'v2 has no media input - run-turn.ts and the v2 composer take text only, so there is no turn to ask it',
        }
      : question.driver === 'proactive'
        ? {
            stage: 'proactive',
            error:
              'v2 has no proactive path - runTurn answers an inbound, and this scenario has none',
          }
        : null
  const v2Skip: GoldenV2 | null =
    v2SkipReason === null
      ? null
      : { ok: false, kind: 'not_run', ...v2SkipReason, durationMs: 0 }

  const [v2Settled, v1Settled] = await Promise.allSettled([
    v2Skip !== null
      ? Promise.resolve(null)
      : runTurn({
          venueId,
          guestId: null,
          inbound,
          sessionHistory: history,
          now,
          // No profile, no memory, and ZERO VISITS even on a scenario whose
          // history implies past ones. That is deliberate parity: the v1 arm's
          // synthetic guest has no `transactions` rows, so declaring visits here
          // would have v2 answering about a regular while v1 answers about a
          // stranger. Anything a scenario needs the guest to have done is in the
          // transcript, where both arms read it.
          //
          // replyCount counts the guest's inbound messages, which is what v1's
          // own count would see for this materialized thread.
          session: {
            profile: EMPTY_PROFILE,
            memory: EMPTY_MEMORY,
            facts: {
              visitCount: 0,
              replyCount:
                history.filter((t) => t.role === 'user').length +
                inbound.length,
              daysSinceLastContact: null,
            },
          },
        }),
    // Two arms, picked by what sets the scenario off. A proactive scenario
    // has no inbound at all - the transcript is the whole input and the
    // trigger says what the venue is reaching out about.
    question.driver === 'proactive' && question.followupTrigger !== undefined
      ? draftV1FollowupForSandbox({
          venueId,
          sessionHistory: history,
          // `triggeredAt` is the run's clock, not a fresh one: with `--at` it
          // is what makes "we are following up the next morning" true rather
          // than something the prompt is told while the trigger says
          // otherwise.
          trigger: { reason: question.followupTrigger, triggeredAt: now },
          channel: question.channel,
          slot,
          now,
        })
      : draftV1ForSandbox({
          venueId,
          sessionHistory: history,
          inbound,
          slot,
          mediaUrls: question.mediaUrls,
          channel: question.channel,
          // Moves the prompt clock AND stamps the materialized rows, so the
          // two halves of v1's turn cannot disagree about when this happened.
          now,
        }),
  ])

  let v1: GoldenV1
  if (v1Settled.status === 'rejected') {
    v1 = {
      ok: false,
      kind: 'error',
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
      kind: 'error',
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
  if (v2Skip !== null) {
    v2 = v2Skip
  } else if (v2Settled.status === 'rejected') {
    v2 = {
      ok: false,
      kind: 'error',
      stage: 'threw',
      error:
        v2Settled.reason instanceof Error
          ? v2Settled.reason.message
          : String(v2Settled.reason),
      durationMs: Date.now() - v2Started,
    }
  } else if (v2Settled.value === null) {
    // Unreachable: `v2Skip !== null` is the only way the thunk resolves null
    // and it is handled above. Named rather than cast, so a future third
    // skip reason fails here instead of rendering as a successful empty v2.
    v2 = {
      ok: false,
      kind: 'error',
      stage: 'harness',
      error: 'v2 resolved null with no recorded skip reason',
      durationMs: 0,
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
          kind: 'error',
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

/** How far `timezone` is from UTC at `at`, in ms. Positive east of Greenwich. */
function timezoneOffsetMs(timezone: string, at: Date): number | null {
  try {
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
    const part = (type: string): number =>
      Number(parts.find((p) => p.type === type)?.value)
    const asIfUtc = Date.UTC(
      part('year'),
      part('month') - 1,
      part('day'),
      // en-US hour12:false renders midnight as "24" in some ICU versions -
      // the same quirk venueLocalNow guards against in lib/schemas.
      part('hour') % 24,
      part('minute'),
      part('second'),
    )
    return Number.isNaN(asIfUtc) ? null : asIfUtc - at.getTime()
  } catch {
    // Invalid timezone. Intl throws rather than returning anything.
    return null
  }
}

/**
 * `--at` as an instant: a venue-local wall clock turned into real time.
 *
 * Accepts `HH:MM` (that time today, on the venue's clock) or
 * `YYYY-MM-DDTHH:MM`. The venue's clock is the only one that makes sense
 * here - the question being asked is "what would the agent say at 10:30 in
 * the morning", and the machine running this is frequently not in the
 * venue's timezone.
 *
 * TWO PASSES over the offset, which is not belt-and-braces. The offset has
 * to be looked up at an instant, but the instant is what we are solving for,
 * so the first pass uses the naive guess and the second corrects it. They
 * differ only across a DST boundary, which is exactly where a single pass
 * would be silently an hour out.
 *
 * Returns null on anything it cannot resolve - never a guess. A harness that
 * quietly ran at the wrong hour would produce a set of replies nobody could
 * tell was wrong.
 */
function resolveInjectedClock(
  value: string,
  timezone: string,
  realNow: Date,
): Date | null {
  const timeOnly = /^(\d{2}):(\d{2})$/.exec(value)
  const full = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!timeOnly && !full) return null

  let wallMs: number
  if (full) {
    wallMs = Date.UTC(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      Number(full[4]),
      Number(full[5]),
    )
  } else {
    // "Today" means today ON THE VENUE'S CLOCK, not the operator's: at 11pm
    // in California a venue in New York is already on the next date, and
    // `--at=10:30` there must mean that venue's morning.
    const offset = timezoneOffsetMs(timezone, realNow)
    if (offset === null) return null
    const venueToday = new Date(realNow.getTime() + offset)
    wallMs = Date.UTC(
      venueToday.getUTCFullYear(),
      venueToday.getUTCMonth(),
      venueToday.getUTCDate(),
      Number(timeOnly![1]),
      Number(timeOnly![2]),
    )
  }
  if (Number.isNaN(wallMs)) return null

  const firstGuess = timezoneOffsetMs(timezone, new Date(wallMs))
  if (firstGuess === null) return null
  const corrected = timezoneOffsetMs(timezone, new Date(wallMs - firstGuess))
  if (corrected === null) return null
  return new Date(wallMs - corrected)
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

  // The non-inbound drivers are reported rather than silently dropped: a run
  // that covered 58 of 66 and said "58 questions" would read as the whole
  // set to anyone who did not go counting.
  const runnable = runnableGoldenQuestions()
  const gaps = GOLDEN_QUESTIONS.length - runnable.length
  if (gaps > 0)
    console.warn(
      `${gaps} of ${GOLDEN_QUESTIONS.length} scenarios are NOT RUN - their path only sends, so there is no v1 answer to read:\n` +
        GOLDEN_QUESTIONS.filter(
          (q) =>
            !RUNNABLE_DRIVERS.includes(q.driver ?? 'inbound') ||
            q.notAutomated !== undefined,
        )
          .map((q) => `  ${q.key} (${q.driver}): ${q.notAutomated ?? ''}`)
          .join('\n'),
    )

  const questions = runnable.filter(
    (q) => filter === undefined || filter.includes(q.key),
  )
  if (questions.length === 0) {
    console.error(
      '--questions matched nothing runnable (a non-inbound scenario cannot be run)',
    )
    process.exit(1)
  }
  // "Full" means every RUNNABLE scenario, which is the most a run can cover.
  const fullRun = questions.length === runnable.length
  if (!fullRun)
    console.warn(
      `FILTERED: ${questions.length} of ${runnable.length} runnable questions. Stored as a partial run.`,
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

  // `--at` needs the venue's timezone, so it resolves here rather than with
  // the other flags. Refuses rather than falling back to the real clock: a
  // run silently taken at 11pm when the operator asked for 10:30 is a set of
  // replies nobody can tell is wrong.
  const atFlag = flags.find((f) => f.startsWith('--at='))?.slice('--at='.length)
  let injectedNow: Date | null = null
  if (atFlag !== undefined) {
    injectedNow = resolveInjectedClock(atFlag, venue.timezone, new Date())
    if (injectedNow === null) {
      console.error(
        `--at=${atFlag} could not be resolved on ${venue.name}'s clock (${venue.timezone}). ` +
          `Use HH:MM for today, or YYYY-MM-DDTHH:MM.`,
      )
      process.exit(1)
    }
  }
  // Every time-derived value in the run reads this one. Both arms get it, and
  // the v1 arm also stamps its materialized rows to match - moving the prompt
  // clock alone would tell the model it is 10:30am about a message stamped
  // 11pm.
  const now = injectedNow ?? new Date()

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
  // Resolved against `now`, so an injected clock's open state is the one the
  // prompt will actually carry rather than the one outside the window.
  const openState =
    parsedHours?.success === true
      ? resolveOpenState(parsedHours.data, venue.timezone, now).state
      : 'unknown'
  if (injectedNow !== null)
    console.warn(
      `\nCLOCK INJECTED: running as ${now.toISOString()} (${venue.timezone}), not the real time.` +
        `\nThe venue reads ${openState.toUpperCase()} at that instant and the sandbox rows are` +
        `\nstamped to match. The run is marked clock_injected, because an injected 'open' is` +
        `\nnot the same evidence as a measured one.\n`,
    )
  if (openState !== 'open')
    console.warn(
      `\nVENUE IS ${openState.toUpperCase()}. The prompt carries that line, so every reply in` +
        `\nthis run will read differently from one taken mid-morning - and this run is not` +
        `\ncomparable with one taken in another state. Run during open hours, or pass` +
        `\n--at=10:30 to ask the questions as if it were mid-service (scripts/CLAUDE.md).\n`,
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
      clockInjected: injectedNow !== null,
      ranAt: now.toISOString(),
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
    const unit = await runQuestion(venue.id, q, slot, now)
    // Checkpoint per unit: the expensive half is the model calls, and losing
    // them to a late throw in the cheap half is the specific failure the
    // run-log convention exists for.
    log.appendUnit(unit)
    // `not run` and `ERROR` are distinct here for the same reason they are on
    // the page: one is a capability the engine lacks, the other is the engine
    // breaking.
    const v1Line = unit.v1.ok
      ? (unit.v1.substitute ?? unit.v1.bubbles.join(' / ')).slice(0, 60)
      : unit.v1.kind === 'not_run'
        ? `not run (${unit.v1.stage})`
        : `ERROR ${unit.v1.stage}`
    const v2Line = unit.v2.ok
      ? unit.v2.messages.join(' / ').slice(0, 60)
      : unit.v2.kind === 'not_run'
        ? `not run (${unit.v2.stage})`
        : `ERROR ${unit.v2.stage}`
    console.log(`${q.key}\n  v1: ${v1Line}\n  v2: ${v2Line}`)
    return unit
  })

  // A SKIP IS NOT A FAILURE. Folding `not_run` into the error count reported
  // "v2 errors: 2" for two scenarios v2 was never asked - the mirror image of
  // the convention's rule 5 (a failed unit is not a result), and just as
  // misleading: it reads as v2 breaking on media it was deliberately not
  // handed.
  const failures = (arm: GoldenV1 | GoldenV2): boolean =>
    !arm.ok && arm.kind === 'error'
  const v1Failures = units.filter((u) => failures(u.v1)).length
  const v2Failures = units.filter((u) => failures(u.v2)).length
  // Counted by their OWN stage rather than a single hardcoded label: the
  // first version said "(no media input)" for four proactive scenarios,
  // which is a sentence that is simply false about them.
  const skippedByStage = new Map<string, number>()
  for (const u of units)
    if (!u.v2.ok && u.v2.kind === 'not_run')
      skippedByStage.set(u.v2.stage, (skippedByStage.get(u.v2.stage) ?? 0) + 1)
  const skipSummary = [...skippedByStage]
    .map(([stage, n]) => `${n} ${stage}`)
    .join(', ')
  console.log(
    `\n${units.length} questions run. v1 errors: ${v1Failures}, v2 errors: ${v2Failures}` +
      (skipSummary.length > 0 ? `, v2 not run: ${skipSummary}` : '') +
      '.',
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
      clock_injected: injectedNow !== null,
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
