/**
 * Pure serializer for the 07-sheet's 'Run' tab: one row per scenario from a
 * completed run, not an aggregate or a sample like 'Report'. Sibling to
 * report-sheet.ts, same writeTabValues consumer, different shape —
 * report-sheet.ts's sections answer "how did the run go overall," this
 * answers "what exactly happened on every single scenario," which is what
 * a row-per-scenario run-to-run diff (by sample_id) needs to work from.
 *
 * `RunRow` is deliberately its own plain shape, not GradedScenario —
 * callers construct it from whatever they have (the live in-process
 * GradedScenario[] from a fresh run, or a parsed historical log for a
 * backfill) without this module needing to know which.
 */

export interface RunRow {
  sampleId: string
  topic: string
  category: string
  scenarioSource: string
  mode: string
  guestState: string
  inboundMessage: string
  outcome: string
  route: string
  primaryTrigger: string
  allTriggers: string
  voiceFidelity: string
  replyBody: string
  knowledgeVerdict: string
  knowledgeReason: string
  voiceVerdict: string
  voiceReason: string
  routingVerdict: string
  expectedRoute: string
  actualRoute: string
  expectedBehaviorVerdict: string
  expectedBehaviorReason: string
}

export const RUN_ROW_HEADER = [
  'sample_id',
  'topic',
  'category',
  'scenario_source',
  'mode',
  'guest_state',
  'inbound_message',
  'outcome',
  'route',
  'primary_trigger',
  'all_triggers',
  'voice_fidelity',
  'reply',
  'knowledge_verdict',
  'knowledge_reason',
  'voice_verdict',
  'voice_reason',
  'routing_verdict',
  'expected_route',
  'actual_route',
  'expected_behavior_verdict',
  'expected_behavior_reason',
] as const

export function buildRunRows(rows: readonly RunRow[]): string[][] {
  return [
    [...RUN_ROW_HEADER],
    ...rows.map((r) => [
      r.sampleId,
      r.topic,
      r.category,
      r.scenarioSource,
      r.mode,
      r.guestState,
      r.inboundMessage,
      r.outcome,
      r.route,
      r.primaryTrigger,
      r.allTriggers,
      r.voiceFidelity,
      r.replyBody,
      r.knowledgeVerdict,
      r.knowledgeReason,
      r.voiceVerdict,
      r.voiceReason,
      r.routingVerdict,
      r.expectedRoute,
      r.actualRoute,
      r.expectedBehaviorVerdict,
      r.expectedBehaviorReason,
    ]),
  ]
}
