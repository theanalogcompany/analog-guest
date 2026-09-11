import type { GradedScenario, ReviewItem, TopicPassRate } from './scorecard'

/**
 * TAC-347 Stage 3. Pure serializer: turns a graded run's aggregated data
 * into row-major string[][] for the sheet's 'Report' tab (writeTabValues
 * writes the first row as a header — here that's just used loosely as a
 * section-title convention, not one strict table).
 */

const fmtPct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`)

export function buildReportRows(input: {
  runDateIso: string
  scenarioCount: number
  runTimeSeconds: number
  estimatedCostUsd: number
  measuredCostUsd: number
  gradedCount: number
  ungraded: number // scenarios skipped by --max-cost
  topicPassRates: TopicPassRate[]
  reviewList: ReviewItem[]
  voiceReadSample: GradedScenario[]
  graderSpotCheckSample: GradedScenario[]
}): string[][] {
  const rows: string[][] = []

  rows.push(['Run summary'])
  rows.push(['run_date', input.runDateIso])
  rows.push(['scenarios_run', String(input.scenarioCount)])
  rows.push(['scenarios_graded', String(input.gradedCount)])
  rows.push(['scenarios_ungraded_cost_cap', String(input.ungraded)])
  rows.push(['run_time_seconds', input.runTimeSeconds.toFixed(1)])
  rows.push(['estimated_cost_usd_classify_generate', input.estimatedCostUsd.toFixed(4)])
  rows.push(['measured_cost_usd_grading', input.measuredCostUsd.toFixed(4)])
  rows.push(['total_cost_usd', (input.estimatedCostUsd + input.measuredCostUsd).toFixed(4)])
  rows.push([])

  rows.push(['Per-topic pass rates'])
  rows.push(['topic', 'total', 'knowledge_pass_rate', 'voice_pass_rate', 'routing_pass_rate'])
  for (const t of input.topicPassRates) {
    rows.push([t.topic, String(t.total), fmtPct(t.knowledgePassRate), fmtPct(t.voicePassRate), fmtPct(t.routingPassRate)])
  }
  rows.push([])

  rows.push(['Review list (severity-sorted)'])
  rows.push(['sample_id', 'severity', 'reason'])
  for (const item of input.reviewList) {
    rows.push([item.sampleId, item.severity, item.reason])
  }
  rows.push([])

  rows.push(['Voice read sample'])
  rows.push(['sample_id', 'topic', 'guest_state', 'inbound_message', 'reply'])
  for (const g of input.voiceReadSample) {
    rows.push([g.scenario.sample_id, g.scenario.topic, g.scenario.guest_state, g.scenario.inbound_message, g.result.replyBody ?? ''])
  }
  rows.push([])

  rows.push(['Grader spot-check sample (owner: confirm these grades by hand)'])
  rows.push(['sample_id', 'knowledge_verdict', 'voice_verdict', 'reply', 'grader_reasoning'])
  for (const g of input.graderSpotCheckSample) {
    rows.push([
      g.scenario.sample_id,
      g.llmGrade.knowledgeVerdict,
      g.llmGrade.voiceVerdict,
      g.result.replyBody ?? '',
      `knowledge: ${g.llmGrade.knowledgeReason} | voice: ${g.llmGrade.voiceReason}`,
    ])
  }

  return rows
}
