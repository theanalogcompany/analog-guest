/**
 * template-regression.ts - does the current v2 template still hold every
 * lesson its changelog paid for? Run on every V2_PROMPT_VERSION bump
 * (.claude/rules/v2-template-regression.md); numbers go in the PR body.
 *
 * Scenarios are REGRESSION_SCENARIOS in lib/eval/regression-scenarios.ts and
 * nowhere else - adding a case is an edit to that array, no SQL and no
 * deploy (decision 0011, migration 077). `regression_scenarios` in Postgres
 * is an overlay carrying only `enabled`, so a case can be silenced from
 * /admin/regression; an unreadable overlay runs the code flags with a
 * warning, and an overlay row with no code definition is reported and NOT
 * run. Each scenario's `lesson` records what it guards.
 *
 * Two layers, pre-registered and evaluated in code (scripts/CLAUDE.md #5/#8):
 *
 * LAYER A - deterministic tells. Any hit is a CEILING breach: fails the
 * scenario whatever the rate, printed per unit.
 *   - emoji (countEmoji > 0; lib/ai/emoji-cadence.ts is the one shared
 *     definition) - the template bans emoji outright (v2.7.0)
 *   - em dash or spaced en dash surviving the normalizer
 *   - assistant-register phrasing, patterns with optional slots per
 *     convention #7, never exact phrases
 *   - more than one question in a reply
 *
 * LAYER B - judged qualities, scored not asserted. runTurn's own judge
 * result per reply, reported as per-axis means (tested axes only) and,
 * with --compare=<prior run log>, the delta against a previous version's
 * run. Directional until the phase-4 calibration set lands - never a gate
 * here. A judge failure voids its cell and prints; it does not DQ the
 * sample (the axes are advisory, the ceilings are not).
 *
 * BARS - per scenario, where the source lesson had one: >= 2/3 samples
 * with an assessor moveKey tag in the target set (tags are the
 * instrument, never a '?' heuristic), or the named profile capture.
 * A failed generation or assessor DISQUALIFIES its sample - a failure is
 * never a zero. Verdict order lives in scenarioVerdict
 * (lib/eval/regression-scenarios.ts), shared with the admin surface so the
 * two cannot disagree about what a pass is.
 *
 * BREACH ATTRIBUTION - the voice pack outranks any template wording
 * (turn-one-move confirmation: every round's breach was the verbatim
 * exemplar "just so we know what to call you" + emoji, voice_corpus row
 * 8d090421, kept by owner ruling 2026-10-05). The pack rows are loaded
 * once, passed to runTurn as the voicePackText override (character-
 * identical by construction), and every Layer A breach is matched against
 * them: a shared normalized 14-char window attributes the breach to the
 * row and prints the /admin/voices/{slug} link, so inspect-and-remove is
 * one click from the evidence rather than a forensic read.
 *
 * RESULTS go two places: the timestamped JSONL run log (primary, crash-safe,
 * appended per unit - the run-log convention) and, once at the end,
 * `regression_runs` + `regression_run_units` for /admin/regression. A DB
 * write failure warns and exits nonzero-safe: the JSONL already has the run.
 *
 * argv: [scenarios csv] - optional filter, iteration cost only; a PASS
 * claim requires a run over ALL enabled scenarios (exit code enforces it).
 * --samples=N  per-scenario sample count. Default 3; use 6 for the run a
 *              version bump cites (round 5 was falsified at n=3).
 * --compare=path  a prior run's JSONL; prints per-axis judge deltas.
 * --import=path   backfill a stored JSONL run log into the DB tables (no
 *                 model calls) - for runs recorded before migration 069.
 * --concurrency=N samples in flight at once across ALL scenarios (default
 *                 64 - 80% of what the account's measured rate limits
 *                 support; derivation at DEFAULT_CONCURRENCY). Rate-limit
 *                 errors would read as DISQUALIFIED samples, hence a cap
 *                 at all.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createAdminClient } from '@/lib/db/admin'
import { evaluationRan } from '@/lib/relationship/evaluation-ran'
import { runTurn, type PlaygroundSession } from '@/lib/relationship/run-turn'
import type { HistoryTurn } from '@/lib/ai/v2/compose'
import { EMPTY_MEMORY, EMPTY_PROFILE } from '@/lib/relationship/profile'
import { V2_PROMPT_VERSION } from '@/lib/ai/v2/template'
import {
  ASSESSOR_ENABLED,
  ASSESSOR_PROMPT_VERSION,
} from '@/lib/relationship/assessor'
import { JUDGE_AXES, JUDGE_PROMPT_VERSION } from '@/lib/eval/judge'
import {
  scoreQuestionSubstance,
  SUBSTANTIVE_QUESTION_THRESHOLD,
} from '@/lib/eval/question-substance'
import {
  describeTell,
  type RegressionTell,
  type ResolvedScenarioSet,
  resolveScenarios,
  scenarioVerdict,
  validateScenarioSet,
} from '@/lib/eval/regression-scenarios'
import { countEmoji } from '@/lib/ai/emoji-cadence'
import { EITHER_OR_QUESTION } from '@/lib/ai/v2/normalize-output'
import { loadVoicePack } from '@/lib/rag/voice-pack'
import {
  type RegressionBreach,
  type RegressionSample,
  type RegressionScenario,
  RegressionSampleSchema,
} from '@/lib/schemas/regression'
import { createRunLog, readRunLog } from './run-log'

// 3, owner-ruled 2026-10-09, on the grounds that generation runs at
// temperature 0 (V2_GENERATE_TEMPERATURE) so a single-turn reply barely moves.
//
// KNOWN LIMIT, measured the same day: two n=6 runs over a BYTE-IDENTICAL
// prompt still disagreed on two scenarios - `bare-hey` and `hi-then-good`,
// both crossing the pursuit bar in opposite directions. Generation is not
// where that variance enters; the assessor is (temperature 0.2), and it
// compounds across a multi-turn scenario because each turn's brief is built
// from the last turn's assessment. `now` moves too. So a MULTI-TURN scenario
// at n=3 is noisier than the generation temperature suggests, and a pursuit
// bar of 2-of-N sits close enough to that noise to flip. Pass `--samples=6`
// when a verdict has to hold.
const DEFAULT_SAMPLES = 3
// 80% of what the account's Anthropic rate limits support. Measured off the
// anthropic-ratelimit-* response headers for claude-sonnet-4-6 (2026-10-05):
// 10,000 req/min, 10M input tok/min, 2M output tok/min. One in-flight sample
// chains ~3 calls per turn (generation, judge, assessor) at ~10k input
// tokens each over a ~15s turn, so input tokens bind first at ~80 concurrent
// samples; the other two dimensions allow hundreds. Re-derive if the model,
// tier, or prompt size changes - the headers are the source of truth.
const DEFAULT_CONCURRENCY = 64
const BAR_MIN = 2

/**
 * The owner reads the answers; the harness asserts nothing about them
 * (owner-ruled 2026-10-09).
 *
 * WHAT IT SUPPRESSES: the per-scenario PASS/FAIL verdict and the
 * "N/M scenarios passed" claim. Bars are NOT deleted from
 * `REGRESSION_SCENARIOS` - flipping this back restores every one, which is
 * the whole reason it is a switch rather than an edit. The scenarios and
 * their recorded lessons are months of measurement and must survive a change
 * of who does the judging.
 *
 * WHAT STILL RUNS, because none of it is a judgment about answer quality:
 * every reply is generated and printed, text tells are counted and printed
 * with their voice-pack attribution, gate verdicts and matched policy keys
 * are printed, and a DISQUALIFIED sample still fails the run - "the harness
 * did not work" is not the owner's call to make (scripts/CLAUDE.md #5, #6).
 *
 * WHAT IT COSTS, stated plainly: nothing automated now catches a regression.
 * The emoji arm that produced 83 breaches across 11 of 13 scenarios was
 * caught by these bars in one run. While this is true, that class of defect
 * reaches a human only if a human reads every body.
 */
const OWNER_JUDGES_ANSWERS = true

/** Written to `regression_runs.verdicts` instead of a verdict nobody computed. */
const NOT_JUDGED = 'NOT JUDGED (owner reads the bodies)'

// Patterns with an optional slot (scripts/CLAUDE.md #7): an exact-phrase
// list under-counts whichever arm is not echoing a script. `tell` is typed
// RegressionTell so a new pattern cannot ship without a human-readable
// description in REGRESSION_TELL_DESCRIPTIONS.
// The service-desk pair (how-can-i-help, what-can-i-do) is RETIRED
// (owner-ruled 2026-10-05: okay to ask) - the keys stay in RegressionTell
// so stored breaches from older runs still render.
// `off-channel-redirect` is deliberately narrow (template v2.12.0). v2 is
// Instagram-only, so steering a guest to Instagram is steering them to where
// they already are - but only the preposition-led and imperative forms are
// redirects. Bare "on Instagram" is excluded: it is how the legitimate
// announcement reads ("the date is posted on our Instagram"), and a tell that
// fails a correct reply is worse here than one that misses a wrong one,
// because every scenario's bubbles run through this list.
const REGISTER_PATTERNS: Array<{ tell: RegressionTell; pattern: RegExp }> = [
  { tell: 'call-you', pattern: /what\s+(should|do|can)\s+i\s+call\s+you/i },
  {
    tell: 'off-channel-redirect',
    pattern:
      /\b(?:through|via|over)\s+(?:our\s+)?instagram\b|\bdm\s+(?:us|me)\b/i,
  },
  // Word-boundaried, so "a full stopover" and the British name for a period
  // ("ends with a full stop") do not trip it. The tic is the standalone
  // emphatic tag, and in guest-facing copy there is no other use.
  { tell: 'full-stop', pattern: /\bfull\s+stop\b/i },
]
// Spaced en dash only: "3–5pm" must survive (normalize-output.ts).
const DASH_PATTERN = /—|\s–\s/

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Attribution by shared normalized window: cheap, direction-safe (a miss
 * leaves a breach unattributed, never un-breached). 14 chars is long enough
 * that "the cascara" alone cannot link every row, short enough to survive
 * the model paraphrasing around an echoed core.
 */
const ATTRIBUTION_WINDOW = 14

function attributeToPack(
  bubble: string,
  pack: Array<{ id: string; norm: string }>,
): string[] {
  const normBubble = normalize(bubble)
  const ids: string[] = []
  for (const row of pack) {
    if (row.norm.length < ATTRIBUTION_WINDOW) continue
    for (let i = 0; i + ATTRIBUTION_WINDOW <= row.norm.length; i += 1) {
      if (normBubble.includes(row.norm.slice(i, i + ATTRIBUTION_WINDOW))) {
        ids.push(row.id)
        break
      }
    }
  }
  return ids
}

/**
 * A '?' whose clause is nothing but a rhetorical tag is not a question
 * (owner-ruled 2026-10-05: '"right?" is not really a question'). The clause
 * is whatever follows the last sentence break; a tag hanging off a comma
 * ("good, right?") counts as a tag too.
 */
const RHETORICAL_TAGS = new Set(['right', 'yeah', 'no', 'huh', 'eh'])

/**
 * The question clauses in a bubble, verbatim, each ending in its "?".
 *
 * The DETERMINISTIC half of the two-questions ceiling: finding where the
 * questions are, and dropping bare rhetorical tags, needs no judgment.
 * Whether a clause is SUBSTANTIVE is the semantic half and lives in
 * lib/eval/question-substance.ts (owner-ruled 2026-10-06).
 */
function questionClauses(bubble: string): string[] {
  const parts = bubble.split('?')
  const out: string[] = []
  for (let i = 0; i < parts.length - 1; i += 1) {
    const clause = (parts[i].split(/[.!]/).pop() ?? '').trim()
    const tail = clause.split(',').pop() ?? ''
    const norm = tail
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .trim()
    if (RHETORICAL_TAGS.has(norm)) continue
    out.push(`${clause}?`)
  }
  return out
}

/**
 * `unavailable` non-null means the substantive-question judgment did not
 * complete, and the CALLER DISQUALIFIES the sample. Neither direction is
 * honest here: scoring the clauses as phatic would pass a stacked reply
 * vacuously, and scoring them all substantive would invent a breach. A
 * failure is never a zero (convention #5).
 */
async function checkBubbles(
  sample: number,
  turn: number,
  reply: string[],
  pack: Array<{ id: string; norm: string }>,
): Promise<{ breaches: RegressionBreach[]; unavailable: string | null }> {
  const breaches: RegressionBreach[] = []
  const add = (tell: RegressionTell, bubble: string) =>
    breaches.push({
      tell,
      sample,
      turn,
      bubble,
      attributedTo: attributeToPack(bubble, pack),
    })
  for (const bubble of reply) {
    if (countEmoji(bubble) > 0) add('emoji', bubble)
    if (DASH_PATTERN.test(bubble)) add('dash', bubble)
    // Same pattern the generation-seam strip uses (one definition): a hit
    // here means a shape stripEitherOrQuestion did not catch.
    if (EITHER_OR_QUESTION.test(bubble)) add('either-or', bubble)
    for (const { tell, pattern } of REGISTER_PATTERNS) {
      if (pattern.test(bubble)) add(tell, bubble)
    }
  }
  // Per-bubble, not per-reply: the trailing getting-to-know-you question in
  // its OWN bubble is the decision-0007 shape and allowed alongside one real
  // question in the body (owner-ruled 2026-10-05: "the answer was fine").
  // The reply-total backstop still catches question stacking across bubbles.
  //
  // Only SUBSTANTIVE questions count (owner-ruled 2026-10-06). Extraction is
  // exact; the substantive call is one Jev request with a Noul per clause,
  // evaluated in parallel so latency is flat in question count.
  const clausesPerBubble = reply.map(questionClauses)
  const allClauses = clausesPerBubble.flat()
  let substantive: boolean[] = []
  if (allClauses.length > 0) {
    const scored = await scoreQuestionSubstance(allClauses, reply)
    if (!scored.ok)
      return {
        breaches,
        unavailable: `question substance check failed: ${scored.error}`,
      }
    substantive = scored.probabilities.map(
      (p) => p >= SUBSTANTIVE_QUESTION_THRESHOLD,
    )
  }
  let cursor = 0
  const perBubble = clausesPerBubble.map((clauses) => {
    let n = 0
    for (let i = 0; i < clauses.length; i += 1) {
      // Past the module's candidate cap the probability is absent; a reply
      // with that many questions is stacking whatever the judgments say, so
      // the default counts rather than excuses.
      if (substantive[cursor] ?? true) n += 1
      cursor += 1
    }
    return n
  })
  const totalQuestions = perBubble.reduce((a, b) => a + b, 0)
  if (perBubble.some((n) => n > 1)) {
    add('two-questions', reply[perBubble.findIndex((n) => n > 1)] ?? '')
  } else if (totalQuestions > 2) {
    add('two-questions', reply.join(' | '))
  }
  return { breaches, unavailable: null }
}

async function runSample(
  venueId: string,
  sampleIndex: number,
  scenario: RegressionScenario,
  voicePackText: string,
  pack: Array<{ id: string; norm: string }>,
): Promise<RegressionSample> {
  let session: PlaygroundSession = {
    profile: EMPTY_PROFILE,
    memory: EMPTY_MEMORY,
    facts: { visitCount: 0, replyCount: 0, daysSinceLastContact: null },
  }
  let history: HistoryTurn[] = []
  const target = new Set(scenario.target)
  const outcome: RegressionSample = {
    disqualified: null,
    pursued: false,
    firstName: null,
    turnOneNameAsk: false,
    breaches: [],
    judgeScores: [],
    judgeFailures: 0,
    turns: [],
  }

  for (const [turnIndex, inbound] of scenario.script.entries()) {
    const trace = await runTurn({
      venueId,
      guestId: null,
      inbound: [inbound],
      sessionHistory: history,
      session,
      overrides: { voicePackText },
    })
    if (!trace.generation.ok) {
      outcome.disqualified = `generation failed: ${trace.generation.error}`
      return outcome
    }
    // Carry the reason. "assessor failed" alone cannot distinguish "the
    // assessor never ran" from "it errored", and every sample in a run
    // disqualifying on a bare label is how a wholly unrunnable gate looks
    // identical to a model being flaky - which is exactly what a suspended
    // provider account looked like until this line printed the 429.
    // A DELIBERATELY disabled assessor is not a disqualification. The guard
    // in main() has already refused any scenario whose bars need one, so a
    // sample reaching here with ASSESSOR_ENABLED false is measuring only
    // text-based ceilings and gate assertions, all of which still work.
    // Disqualifying it would report a switch we threw as a failure, and a
    // run of nothing but disqualifications is indistinguishable from a
    // broken provider - which is what the next branch exists to tell apart.
    if (!evaluationRan(trace.assessor)) {
      if (ASSESSOR_ENABLED) {
        outcome.disqualified = 'assessor did not run'
        return outcome
      }
    } else if (!trace.assessor.ok) {
      outcome.disqualified = `assessor failed: ${trace.assessor.error}`
      return outcome
    }
    // null ONLY when the assessor is switched off; the branches above have
    // already returned on every failure mode. Move tags and `nextSession`
    // both come from here, so with it null the sample pursues nothing and
    // chains nothing - which is why main() refuses any scenario that bars on
    // either.
    const assessor = evaluationRan(trace.assessor) ? trace.assessor : null
    // A gate assertion needs a live semantic check behind it: with Jev down
    // the gate's fail-closed path can match the forbidden policy without a
    // judgment, and the fail-open path passes it vacuously - either way the
    // sample measured an outage, not the policy (convention #5: a failed
    // unit is not a result).
    if (
      scenario.forbidPolicyKeys.length > 0 &&
      (trace.semantic === null || !trace.semantic.ok)
    ) {
      outcome.disqualified = `semantic check failed: ${
        trace.semantic !== null && !trace.semantic.ok
          ? trace.semantic.error
          : 'did not run'
      }`
      return outcome
    }
    // A stored venue_info key that reached no renderer means the model
    // answered without a fact the venue has on file. v2.10.0 exists because a
    // silent drop of exactly that kind sent two fabricated addresses, so this
    // DISQUALIFIES the sample rather than scoring it: a run measured against
    // an incomplete venue profile is not a result (convention #5).
    const unrendered = trace.venueProfileRender?.unrendered ?? []
    if (unrendered.length > 0) {
      outcome.disqualified = `venue_info keys reached no renderer: ${unrendered.join(', ')}`
      return outcome
    }

    const reply = trace.generation.output.messages
    const tagged = (assessor?.ok ? assessor.result.output.memoryEntries : [])
      .map((e) => e.moveKey.trim())
      .filter((k) => k.length > 0)
    const gateMatched =
      trace.gate === null ? [] : trace.gate.matched.map((m) => m.policyKey)
    outcome.turns.push({ inbound, reply, tagged, gateMatched })
    const bubbleCheck = await checkBubbles(
      sampleIndex,
      turnIndex + 1,
      reply,
      pack,
    )
    if (bubbleCheck.unavailable !== null) {
      outcome.disqualified = bubbleCheck.unavailable
      return outcome
    }
    outcome.breaches.push(...bubbleCheck.breaches)
    if (turnIndex === 0 && tagged.includes('learn_name'))
      outcome.turnOneNameAsk = true
    if (tagged.some((k) => target.has(k))) outcome.pursued = true

    if (evaluationRan(trace.judge) && trace.judge.ok) {
      const scores: Record<string, number> = {}
      for (const axis of JUDGE_AXES) {
        const judgment = trace.judge.result.axes[axis]
        if (judgment.tested) scores[axis] = judgment.score
      }
      outcome.judgeScores.push(scores)
    } else if (evaluationRan(trace.judge)) {
      outcome.judgeFailures += 1
    }

    history = [
      ...history,
      { role: 'user' as const, text: inbound },
      ...reply.map((text) => ({ role: 'assistant' as const, text })),
    ]
    // Unchanged when the assessor is off: the next turn is handed the same
    // empty profile and memory this one got.
    if (assessor?.ok) session = assessor.nextSession
  }
  outcome.firstName = session.profile.fields.first_name ?? null
  return outcome
}

/**
 * The live scenario set: REGRESSION_SCENARIOS, with `enabled` overlaid from
 * `regression_scenarios` (migration 077, decision 0011). Definitions are
 * never read from the database, so a scenario added to the array runs on the
 * next invocation with no migration and no deploy.
 *
 * The code set is validated first and a bad entry EXITS - an offline
 * boundary fails closed and loudly, before an hour of model calls.
 *
 * An unreadable overlay fails OPEN: the code flags stand, with a warning. A
 * case someone disabled then runs and may print a failure, which is visible;
 * the other direction drops a guard silently, which is the defect this whole
 * inversion removes.
 */
async function loadScenarios(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<ResolvedScenarioSet & { overlayRead: 'ok' | 'failed' }> {
  const problems = validateScenarioSet()
  if (problems.length > 0) {
    console.error(
      `REGRESSION_SCENARIOS is invalid - refusing to run:\n  ${problems.join('\n  ')}`,
    )
    process.exit(1)
  }

  const { data, error } = await supabase
    .from('regression_scenarios')
    .select('key, enabled')
  if (error) {
    console.warn(
      `regression_scenarios overlay unreadable (${error.message}) - running the code set with its own enabled flags (migration 077 applied?)`,
    )
    return { ...resolveScenarios([]), overlayRead: 'failed' }
  }

  const resolved = resolveScenarios(data ?? [])
  if (resolved.orphanKeys.length > 0) {
    console.warn(
      `overlay rows with no code definition, NOT running: ${resolved.orphanKeys.join(', ')} - a scenario exists in lib/eval/regression-scenarios.ts or it does not exist (clear the row at /admin/regression)`,
    )
  }
  const overridden = resolved.scenarios.filter((s) => s.enabledOverridden)
  if (overridden.length > 0) {
    console.warn(
      `enabled overridden from the overlay: ${overridden.map((s) => `${s.key}=${s.enabled}`).join(', ')}`,
    )
  }
  return { ...resolved, overlayRead: 'ok' }
}

interface AxisMeans {
  means: Partial<Record<string, number>>
  counts: Partial<Record<string, number>>
}

function axisMeans(scoreSets: Array<Record<string, number>>): AxisMeans {
  const means: Partial<Record<string, number>> = {}
  const counts: Partial<Record<string, number>> = {}
  for (const axis of JUDGE_AXES) {
    const values = scoreSets
      .map((s) => s[axis])
      .filter((v): v is number => v !== undefined)
    if (values.length > 0) {
      means[axis] = values.reduce((a, b) => a + b, 0) / values.length
      counts[axis] = values.length
    }
  }
  return { means, counts }
}

/** Pull judge score sets out of a prior run's JSONL for --compare. */
function loadPriorScores(path: string): {
  promptVersion: string | null
  scores: Array<Record<string, number>>
} {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
  let promptVersion: string | null = null
  const scores: Array<Record<string, number>> = []
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as Record<string, unknown>
    const meta = record.meta
    if (typeof meta === 'object' && meta !== null) {
      const pv = (meta as Record<string, unknown>).promptVersion
      if (typeof pv === 'string') promptVersion = pv
    }
    const judgeScores = record.judgeScores
    if (Array.isArray(judgeScores)) {
      for (const set of judgeScores) {
        if (typeof set === 'object' && set !== null) {
          scores.push(set as Record<string, number>)
        }
      }
    }
  }
  return { promptVersion, scores }
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

/**
 * --import=<jsonl>: backfill a stored run log into regression_runs/_units
 * so it shows on /admin/regression. No model calls - the JSONL already has
 * everything; verdicts are recomputed through the same scenarioVerdict the
 * live path uses. Exists for runs recorded before migration 069 (or any
 * run whose DB write failed). finished_at stays null: the log's header is
 * stamped at START and the true finish time was never recorded.
 */
async function importRunLog(
  supabase: ReturnType<typeof createAdminClient>,
  path: string,
): Promise<void> {
  const contents = readRunLog(path)
  const header = contents.header

  const venueName = typeof header.venue === 'string' ? header.venue : null
  if (venueName === null) {
    console.error('run log header has no venue name - cannot import')
    process.exit(1)
  }
  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .select('id, name')
    .ilike('name', venueName)
    .maybeSingle()
  if (venueError || !venue) {
    console.error(
      `venue "${venueName}" not found: ${venueError?.message ?? ''}`,
    )
    process.exit(1)
  }

  const loaded = await loadScenarios(supabase)
  const byKey = new Map(loaded.scenarios.map((s) => [s.key, s]))

  const samplesByScenario = new Map<string, RegressionSample[]>()
  const unitRows: Array<{
    scenario_key: string
    sample: number
    unit: RegressionSample
  }> = []
  for (const raw of contents.units) {
    const scenarioKey =
      typeof raw.scenario === 'string' ? raw.scenario : '(unknown)'
    const sample = typeof raw.sample === 'number' ? raw.sample : 0
    const parsed = RegressionSampleSchema.safeParse({
      disqualified: raw.disqualified,
      pursued: raw.pursued,
      firstName: raw.firstName,
      turnOneNameAsk: raw.turnOneNameAsk,
      breaches: raw.breaches,
      judgeScores: raw.judgeScores,
      judgeFailures: raw.judgeFailures,
      turns: raw.turns,
    })
    if (!parsed.success) {
      console.error(
        `unit ${scenarioKey}/s${sample} fails schema parse - refusing a partial import (${parsed.error.message})`,
      )
      process.exit(1)
    }
    unitRows.push({ scenario_key: scenarioKey, sample, unit: parsed.data })
    const list = samplesByScenario.get(scenarioKey) ?? []
    list.push(parsed.data)
    samplesByScenario.set(scenarioKey, list)
  }

  const verdicts: Record<string, string> = {}
  let passed = 0
  for (const [key, samples] of samplesByScenario) {
    const def = byKey.get(key)
    if (!def)
      console.warn(
        `scenario "${key}" is not in the current set - importing with no bar (ceilings still apply)`,
      )
    const verdict = scenarioVerdict(
      def ?? {
        target: [],
        expectFirstName: null,
        noTurnOneNameAsk: false,
        expectReplyContains: null,
        forbidPolicyKeys: [],
        expectPolicyKeys: [],
      },
      samples,
      BAR_MIN,
    )
    verdicts[key] = verdict
    if (verdict === 'PASS') passed += 1
    console.log(`${key}: ${verdict}`)
  }

  const importedKeys = new Set(samplesByScenario.keys())
  const fullRun = loaded.scenarios
    .filter((s) => s.enabled)
    .every((s) => importedKeys.has(s.key))

  const str = (v: unknown, fallback: string) =>
    typeof v === 'string' ? v : fallback
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' ? v : fallback
  const runInsert = await supabase
    .from('regression_runs')
    .insert({
      venue_id: venue.id,
      prompt_version: str(header.promptVersion, '(unknown)'),
      assessor_version: str(header.assessorVersion, '(unknown)'),
      judge_version: str(header.judgeVersion, '(unknown)'),
      samples: num(header.samples, 0),
      git_sha: header.gitSha ?? null,
      pack_rows: num(header.packRows, 0),
      verdicts,
      scenarios_passed: passed,
      scenarios_total: samplesByScenario.size,
      full_run: fullRun,
      started_at: str(header.generatedAt, new Date().toISOString()),
      finished_at: null,
    })
    .select('id')
    .single()
  if (runInsert.error) {
    console.error(`regression_runs insert failed: ${runInsert.error.message}`)
    process.exit(1)
  }
  const unitsInsert = await supabase.from('regression_run_units').insert(
    unitRows.map((u) => ({
      run_id: runInsert.data.id,
      scenario_key: u.scenario_key,
      sample: u.sample,
      unit: u.unit,
    })),
  )
  if (unitsInsert.error) {
    console.error(
      `regression_run_units insert failed: ${unitsInsert.error.message}`,
    )
    process.exit(1)
  }
  console.log(
    `\nimported ${unitRows.length} units across ${samplesByScenario.size} scenarios as run ${runInsert.data.id} (${passed}/${samplesByScenario.size} passed)`,
  )
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2)
  const importPath = flags.find((f) => f.startsWith('--import='))?.split('=')[1]
  if (importPath !== undefined) {
    await importRunLog(createAdminClient(), importPath)
    return
  }
  const samplesFlag = flags.find((f) => f.startsWith('--samples='))
  const samples = samplesFlag
    ? Number.parseInt(samplesFlag.split('=')[1], 10)
    : DEFAULT_SAMPLES
  if (!Number.isInteger(samples) || samples < 1) {
    console.error('--samples must be a positive integer')
    process.exit(1)
  }
  const concurrencyFlag = flags.find((f) => f.startsWith('--concurrency='))
  const concurrency = concurrencyFlag
    ? Number.parseInt(concurrencyFlag.split('=')[1], 10)
    : DEFAULT_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error('--concurrency must be a positive integer')
    process.exit(1)
  }
  const comparePath = flags
    .find((f) => f.startsWith('--compare='))
    ?.split('=')[1]
  const scenarioFilter = flags
    .filter((f) => !f.startsWith('--'))[0]
    ?.split(',')
    .filter((s) => s.length > 0)

  // TEST_VENUE_ID when it names a real venue; otherwise the venue every
  // prior v2 measurement ran on (turn-one-move), so numbers stay comparable.
  const supabase = createAdminClient()
  const envVenueId = process.env.TEST_VENUE_ID
  let venue: { id: string; name: string; slug: string } | null = null
  if (envVenueId) {
    const { data } = await supabase
      .from('venues')
      .select('id, name, slug')
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
      .select('id, name, slug')
      .ilike('name', "Le Mil's Coffee")
      .maybeSingle()
    if (error || !data) {
      console.error(`no usable venue: ${error?.message ?? 'not found'}`)
      process.exit(1)
    }
    venue = data
  }

  const loaded = await loadScenarios(supabase)
  const enabled = loaded.scenarios.filter((s) => s.enabled)

  // Two of the bars are the ASSESSOR's output, not the reply's: `target`
  // reads its moveKey tags and `expectFirstName` reads its profile write.
  // With the assessor off they cannot be judged at all - and a harness that
  // reported them as DISQUALIFIED would be calling a switch we threw a
  // failure. Refuse, name the scenarios, and let the operator choose
  // (scripts/CLAUDE.md #6: a skipped run is not a result).
  const scenarios = enabled.filter(
    (s) => scenarioFilter === undefined || scenarioFilter.includes(s.key),
  )
  if (scenarios.length === 0) {
    console.error('scenario filter matched nothing')
    process.exit(1)
  }
  // A requested key that is disabled or misspelled used to vanish without a
  // word: a 9-key filter printed "8/8 scenarios passed" and nothing said
  // which key went or why. That is the silent cap the run-log convention
  // exists to prevent - a dropped scenario reads as a covered one. Says it
  // out loud and distinguishes the two causes, because they have different
  // fixes (flip `enabled`, vs. fix the typo).
  if (scenarioFilter !== undefined) {
    const known = new Set(loaded.scenarios.map((s) => s.key))
    const ran = new Set(scenarios.map((s) => s.key))
    for (const key of scenarioFilter) {
      if (ran.has(key)) continue
      console.warn(
        known.has(key)
          ? `requested scenario "${key}" is DISABLED and was not run`
          : `requested scenario "${key}" does not exist and was not run`,
      )
    }
  }
  const filtered = scenarios.length !== enabled.length

  // Checked against the FILTERED set, not the enabled set: the bars that need
  // the assessor are per scenario, so a run over scenarios that carry none of
  // them is perfectly measurable with the assessor off. Checking `enabled`
  // here refused `-- bare-domain-link`, which needs no assessor at all.
  if (!ASSESSOR_ENABLED) {
    const assessorBound = scenarios.filter(
      (s) => s.target.length > 0 || s.expectFirstName !== null,
    )
    if (assessorBound.length > 0) {
      console.error(
        `ASSESSOR_ENABLED is false (lib/relationship/assessor.ts), so pursuit and first_name bars cannot be measured.\n` +
          `${assessorBound.length} of ${enabled.length} enabled scenarios depend on them:\n` +
          assessorBound
            .map(
              (s) =>
                `  ${s.key} (${[
                  s.target.length > 0 ? `target: ${s.target.join(', ')}` : null,
                  s.expectFirstName !== null
                    ? `expectFirstName: ${s.expectFirstName}`
                    : null,
                ]
                  .filter(Boolean)
                  .join('; ')})`,
            )
            .join('\n') +
          `\n\nTurn the assessor back on, disable those scenarios in lib/eval/regression-scenarios.ts, or filter to the ones that do not need it.`,
      )
      process.exit(1)
    }
  }

  // One pack load, passed as the override - the attribution set and the
  // model's prompt cannot diverge mid-run or from each other.
  const packResult = await loadVoicePack({ venueId: venue.id })
  if (!packResult.ok) {
    console.error(`voice pack load failed: ${packResult.error}`)
    process.exit(1)
  }
  const voicePackText = packResult.data.map((c) => `- ${c.text}`).join('\n')
  const pack = packResult.data.map((c) => ({
    id: c.voiceCorpusId,
    norm: normalize(c.text),
  }))
  const adminLink = `/admin/voices/${venue.slug}`

  const log = createRunLog({
    name: 'template-regression',
    meta: {
      arm: 'baseline',
      venue: venue.name,
      samples,
      barMin: BAR_MIN,
      scenarios: scenarios.map((s) => s.key),
      // The set is always the code array; the overlay only flips `enabled`.
      scenarioSource: 'code',
      overlayRead: loaded.overlayRead,
      enabledOverrides: loaded.scenarios
        .filter((s) => s.enabledOverridden)
        .map((s) => `${s.key}=${s.enabled}`),
      orphanOverlayRows: loaded.orphanKeys,
      packRows: pack.length,
      promptVersion: V2_PROMPT_VERSION,
      assessorVersion: ASSESSOR_PROMPT_VERSION,
      judgeVersion: JUDGE_PROMPT_VERSION,
    },
  })
  console.log(`run log: ${log.path}\n`)

  const startedAt = new Date()
  const allScores: Array<Record<string, number>> = []
  const verdicts: Record<string, string> = {}
  const unitRows: Array<{
    scenario_key: string
    sample: number
    unit: RegressionSample
  }> = []

  // All scenario x sample pairs through one bounded pool: scenarios are
  // independent, so serializing them only added their latencies. The cap
  // bounds concurrent Anthropic pressure - full width (scenarios x samples)
  // risks rate-limit errors that would read as DISQUALIFIED samples, which
  // is a worse failure than a slower run. Turns within a sample stay
  // serial by nature (turn N+1 needs turn N's reply in history).
  const jobs = scenarios.flatMap((scenario) =>
    Array.from({ length: samples }, (_, i) => ({ scenario, sampleIndex: i })),
  )
  const results = new Map<string, RegressionSample[]>(
    scenarios.map((s) => [s.key, new Array<RegressionSample>(samples)]),
  )
  // Re-capture as const: the closure below cannot keep `let venue`'s
  // null-narrowing.
  const venueId = venue.id
  let nextJob = 0
  let done = 0
  async function worker(): Promise<void> {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob]
      nextJob += 1
      const outcome = await runSample(
        venueId,
        job.sampleIndex + 1,
        job.scenario,
        voicePackText,
        pack,
      )
      const list = results.get(job.scenario.key)
      if (list) list[job.sampleIndex] = outcome
      done += 1
      console.log(
        `  ${done}/${jobs.length} samples done (${job.scenario.key} s${job.sampleIndex + 1})`,
      )
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  )
  console.log('')

  let scenariosPassed = 0
  for (const scenario of scenarios) {
    console.log(`=== ${scenario.key} ===`)
    const outcomes = results.get(scenario.key) ?? []
    for (const [i, s] of outcomes.entries()) {
      for (const t of s.turns) {
        console.log(`  [s${i + 1}] GUEST: ${t.inbound}`)
        for (const m of t.reply) console.log(`       VENUE: ${m}`)
        console.log(`       tagged: ${t.tagged.join(', ') || '(none)'}`)
        if (t.gateMatched.length > 0)
          console.log(`       gate matched: ${t.gateMatched.join(', ')}`)
      }
      if (s.disqualified) console.log(`  [s${i + 1}] FAILED: ${s.disqualified}`)
      for (const b of s.breaches) {
        const attribution =
          b.attributedTo.length > 0
            ? ` <- voice_corpus ${b.attributedTo.join(', ')} (${adminLink})`
            : ''
        console.log(
          `  [s${b.sample}] BREACH ${b.tell} (turn ${b.turn}): "${b.bubble}"${attribution}`,
        )
        console.log(`       ^ ${describeTell(b.tell)}`)
      }
      if (s.judgeFailures > 0)
        console.log(`  [s${i + 1}] judge failed on ${s.judgeFailures} turn(s)`)
      allScores.push(...s.judgeScores)
      unitRows.push({ scenario_key: scenario.key, sample: i + 1, unit: s })
      log.appendUnit({
        scenario: scenario.key,
        sample: i + 1,
        disqualified: s.disqualified,
        pursued: s.pursued,
        firstName: s.firstName,
        turnOneNameAsk: s.turnOneNameAsk,
        breaches: s.breaches,
        judgeScores: s.judgeScores,
        judgeFailures: s.judgeFailures,
        turns: s.turns,
      })
    }

    // OWNER_JUDGES_ANSWERS: compute nothing, claim nothing. The bars stay in
    // the scenario definitions, so flipping the constant back restores every
    // one of them - what is suppressed is the VERDICT, not the knowledge.
    //
    // NOT_JUDGED rather than PASS, and `scenariosPassed` deliberately left at
    // 0: `regression_runs.verdicts` is what /admin/regression renders, and
    // writing PASS for a scenario nothing evaluated would put a green row on
    // that page for a run that judged nothing. A false green is worse than a
    // blank.
    if (OWNER_JUDGES_ANSWERS) {
      verdicts[scenario.key] = NOT_JUDGED
      console.log(`  -> ${NOT_JUDGED}\n`)
      continue
    }
    const verdict = scenarioVerdict(scenario, outcomes, BAR_MIN)
    verdicts[scenario.key] = verdict
    if (verdict === 'PASS') scenariosPassed += 1
    console.log(`  -> ${verdict}\n`)
  }

  const { means, counts } = axisMeans(allScores)
  console.log('=== judge axes (tested only, directional - never a gate) ===')
  for (const axis of JUDGE_AXES) {
    const mean = means[axis]
    if (mean === undefined) {
      console.log(`  ${axis}: (never tested)`)
      continue
    }
    let line = `  ${axis}: ${mean.toFixed(2)} (n=${counts[axis]})`
    if (comparePath !== undefined) {
      const prior = loadPriorScores(comparePath)
      const priorMean = axisMeans(prior.scores).means[axis]
      if (priorMean !== undefined)
        line += ` | ${prior.promptVersion ?? 'prior'}: ${priorMean.toFixed(2)} (Δ ${(mean - priorMean).toFixed(2)})`
    }
    console.log(line)
  }

  // The viewing copy for /admin/regression. The JSONL above is the record;
  // a failure here is a warning, never a lost run.
  const runInsert = await supabase
    .from('regression_runs')
    .insert({
      venue_id: venue.id,
      prompt_version: V2_PROMPT_VERSION,
      assessor_version: ASSESSOR_PROMPT_VERSION,
      judge_version: JUDGE_PROMPT_VERSION,
      samples,
      git_sha: gitSha(),
      pack_rows: pack.length,
      verdicts,
      scenarios_passed: scenariosPassed,
      scenarios_total: scenarios.length,
      full_run: !filtered,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (runInsert.error) {
    console.warn(
      `regression_runs write failed (migration 069 applied?): ${runInsert.error.message} - the JSONL run log is the record`,
    )
  } else {
    const unitsInsert = await supabase.from('regression_run_units').insert(
      unitRows.map((u) => ({
        run_id: runInsert.data.id,
        scenario_key: u.scenario_key,
        sample: u.sample,
        unit: u.unit,
      })),
    )
    if (unitsInsert.error) {
      console.warn(
        `regression_run_units write failed: ${unitsInsert.error.message} - the JSONL run log is the record`,
      )
    }
  }

  if (OWNER_JUDGES_ANSWERS) {
    // Count what actually happened rather than claiming a verdict. A
    // disqualification still decides the exit code: a run where the harness
    // itself failed must not look like a clean one just because nobody was
    // scoring (scripts/CLAUDE.md #5/#6).
    const disqualified = unitRows.filter((u) => u.unit.disqualified !== null)
    const breaches = unitRows.reduce((n, u) => n + u.unit.breaches.length, 0)
    console.log(
      `\n${scenarios.length} scenarios run on ${V2_PROMPT_VERSION}, ${unitRows.length} samples. NOTHING WAS JUDGED - read the bodies above.` +
        `\n  disqualified samples: ${disqualified.length}` +
        `\n  text-tell breaches (printed above, not a verdict): ${breaches}` +
        (filtered ? '\n  FILTERED RUN - not every scenario ran.' : ''),
    )
    for (const u of disqualified)
      console.log(
        `  DISQUALIFIED ${u.scenario_key} s${u.sample}: ${String(u.unit.disqualified)}`,
      )
    process.exit(disqualified.length === 0 ? 0 : 1)
  }

  const allPassed = scenariosPassed === scenarios.length
  console.log(
    `\n${scenariosPassed}/${scenarios.length} scenarios passed on ${V2_PROMPT_VERSION}` +
      (filtered ? ' (FILTERED RUN - cannot certify the template)' : ''),
  )
  // A filtered run can never exit 0: certification requires all scenarios.
  process.exit(allPassed && !filtered ? 0 : 1)
}

void main()
