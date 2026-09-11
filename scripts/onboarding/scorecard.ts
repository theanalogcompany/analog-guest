import type { DeterministicVoiceResult } from './grade-voice-deterministic'
import type { GradeScenarioResult } from './grade-scenario'
import type { RoutingGrade } from './grade-routing'
import type { ScenarioResult } from './run-test-scenarios'
import type { ScenarioSheetRow } from './scenario-schema'

/**
 * TAC-347 Stage 3. Pure aggregation over one run's graded scenarios: per-
 * topic pass rates, a severity-sorted review list, a voice-read sample, and
 * a grader spot-check sample. No imports beyond types — vitest-safe.
 */

export interface GradedScenario {
  scenario: ScenarioSheetRow
  result: ScenarioResult
  deterministicVoice: DeterministicVoiceResult
  llmGrade: GradeScenarioResult
  routing: RoutingGrade
}

const KNOWLEDGE_PASS: ReadonlySet<string> = new Set(['correct', 'correctly_declined'])
const KNOWLEDGE_NA: ReadonlySet<string> = new Set(['not_applicable'])

export function knowledgePassed(g: GradedScenario): boolean | null {
  if (KNOWLEDGE_NA.has(g.llmGrade.knowledgeVerdict)) return null
  return KNOWLEDGE_PASS.has(g.llmGrade.knowledgeVerdict)
}

export function voicePassed(g: GradedScenario): boolean {
  return g.deterministicVoice.pass && g.llmGrade.voiceVerdict === 'pass'
}

export function routingPassed(g: GradedScenario): boolean | null {
  if (g.routing.verdict === 'not_applicable') return null
  return g.routing.verdict === 'pass'
}

export interface TopicPassRate {
  topic: string
  total: number
  knowledgePassRate: number | null // null when every scenario in the topic was not_applicable
  voicePassRate: number
  routingPassRate: number | null
}

export function computeTopicPassRates(graded: readonly GradedScenario[]): TopicPassRate[] {
  const byTopic = new Map<string, GradedScenario[]>()
  for (const g of graded) {
    const list = byTopic.get(g.scenario.topic) ?? []
    list.push(g)
    byTopic.set(g.scenario.topic, list)
  }

  const rates: TopicPassRate[] = []
  for (const [topic, items] of byTopic) {
    const knowledgeApplicable = items.map(knowledgePassed).filter((v): v is boolean => v !== null)
    const routingApplicable = items.map(routingPassed).filter((v): v is boolean => v !== null)
    const voiceResults = items.map(voicePassed)

    rates.push({
      topic,
      total: items.length,
      knowledgePassRate: knowledgeApplicable.length > 0 ? rate(knowledgeApplicable) : null,
      voicePassRate: rate(voiceResults),
      routingPassRate: routingApplicable.length > 0 ? rate(routingApplicable) : null,
    })
  }
  return rates.sort((a, b) => a.topic.localeCompare(b.topic))
}

function rate(bools: readonly boolean[]): number {
  if (bools.length === 0) return 1
  return bools.filter(Boolean).length / bools.length
}

// ---------------------------------------------------------------------------
// Review list — severity-sorted, one row per scenario needing a look.
// ---------------------------------------------------------------------------

export type ReviewSeverity =
  | 'unapproved_commitment'
  | 'expected_behavior_fail'
  | 'invented'
  | 'wrong_knowledge'
  | 'routing_fail'
  | 'voice_fail'
  | 'incomplete_knowledge'

export interface ReviewItem {
  sampleId: string
  severity: ReviewSeverity
  reason: string
}

const SEVERITY_ORDER: readonly ReviewSeverity[] = [
  'unapproved_commitment',
  'expected_behavior_fail',
  'invented',
  'wrong_knowledge',
  'routing_fail',
  'voice_fail',
  'incomplete_knowledge',
]

/**
 * Everything that deserves a human look, most severe first.
 *
 * unapproved_commitment ranks highest — a real finding recorded 2026-09-11:
 * a mechanic scenario with expected_route='queue' (meaning production's own
 * mechanics data says this commitment requires operator approval) but the
 * model didn't self-flag it and it actually SENT. That's a commitment
 * reaching a guest with zero human review, worse than any other single
 * finding this harness surfaces, per explicit owner instruction to list
 * every such case at top severity.
 *
 * expected_behavior_fail ranks next — per the 2026-09-11 safety-critical
 * grading rule, a reply that misses a required 911/988 reference is graded
 * via expected_behavior_verdict (not a separate flag mechanism, which this
 * repo deliberately doesn't have), so a miss on that axis needs to surface
 * above everything else besides an actual unapproved commitment.
 */
export function buildReviewList(graded: readonly GradedScenario[], maxItems = 60): ReviewItem[] {
  const items: ReviewItem[] = []

  for (const g of graded) {
    if (g.scenario.scenario_source === 'mechanic' && g.routing.expectedRoute === 'queue' && g.routing.actualRoute === 'send') {
      items.push({
        sampleId: g.scenario.sample_id,
        severity: 'unapproved_commitment',
        reason: `a mechanic requiring operator approval (expected_route=queue) SENT without approval — the model did not self-flag requiresOperatorApproval on this generation`,
      })
      continue
    }
    if (g.llmGrade.expectedBehaviorVerdict === 'fail') {
      items.push({
        sampleId: g.scenario.sample_id,
        severity: 'expected_behavior_fail',
        reason: `expected_behavior not met: ${g.llmGrade.expectedBehaviorReason}`,
      })
      continue
    }
    if (g.llmGrade.knowledgeVerdict === 'invented' || g.llmGrade.knowledgeVerdict === 'should_have_declined') {
      items.push({
        sampleId: g.scenario.sample_id,
        severity: 'invented',
        reason: `${g.llmGrade.knowledgeVerdict}: ${g.llmGrade.knowledgeReason}${g.llmGrade.knowledgeQuote ? ` — "${g.llmGrade.knowledgeQuote}"` : ''}`,
      })
      continue
    }
    if (g.llmGrade.knowledgeVerdict === 'wrong') {
      items.push({
        sampleId: g.scenario.sample_id,
        severity: 'wrong_knowledge',
        reason: `wrong: ${g.llmGrade.knowledgeReason}${g.llmGrade.knowledgeQuote ? ` — "${g.llmGrade.knowledgeQuote}"` : ''}`,
      })
      continue
    }
    if (g.routing.verdict === 'fail') {
      items.push({
        sampleId: g.scenario.sample_id,
        severity: 'routing_fail',
        reason: `expected route "${g.routing.expectedRoute}", got "${g.routing.actualRoute}"`,
      })
      continue
    }
    if (!voicePassed(g)) {
      const detParts = g.deterministicVoice.findings.map((f) => f.detail)
      const reason = [...detParts, g.llmGrade.voiceVerdict === 'fail' ? g.llmGrade.voiceReason : null]
        .filter((x): x is string => Boolean(x))
        .join('; ')
      items.push({ sampleId: g.scenario.sample_id, severity: 'voice_fail', reason })
      continue
    }
    if (g.llmGrade.knowledgeVerdict === 'incomplete') {
      items.push({
        sampleId: g.scenario.sample_id,
        severity: 'incomplete_knowledge',
        reason: `incomplete: ${g.llmGrade.knowledgeReason}`,
      })
    }
  }

  items.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
  return items.slice(0, maxItems)
}

// ---------------------------------------------------------------------------
// Sampling for owner review — voice read + grader spot check.
// ---------------------------------------------------------------------------

/** Deterministic shuffle (mulberry32) so a run's sample is reproducible given the same seed. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let s = seed
  const rng = (): number => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** Spread sample for an owner voice read — prefers one per topic before repeating. */
export function sampleForVoiceRead(graded: readonly GradedScenario[], count = 20, seed = 1): GradedScenario[] {
  const withReply = graded.filter((g) => g.result.replyBody !== null)
  const byTopic = new Map<string, GradedScenario[]>()
  for (const g of withReply) {
    const list = byTopic.get(g.scenario.topic) ?? []
    list.push(g)
    byTopic.set(g.scenario.topic, list)
  }
  const topics = seededShuffle([...byTopic.keys()], seed)
  const picked: GradedScenario[] = []
  let round = 0
  while (picked.length < count) {
    let addedThisRound = false
    for (const topic of topics) {
      const bucket = byTopic.get(topic) ?? []
      if (bucket.length > round) {
        picked.push(bucket[round])
        addedThisRound = true
        if (picked.length >= count) break
      }
    }
    if (!addedThisRound) break
    round += 1
  }
  return picked
}

export function sampleForGraderSpotCheck(graded: readonly GradedScenario[], count = 10, seed = 2): GradedScenario[] {
  const graded_ = graded.filter((g) => g.result.replyBody !== null)
  return seededShuffle(graded_, seed).slice(0, count)
}
