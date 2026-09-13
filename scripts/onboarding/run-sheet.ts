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
  /**
   * TAC-358. Two columns rather than one `id@score` column on purpose: ids
   * are stable across runs and are what a run-to-run diff by `sample_id`
   * compares, while scores move on every embed and would make that diff
   * noisy. Kept index-aligned — the nth id is the nth score.
   */
  retrievedChunkIds: string
  retrievedChunkScores: string
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
  'retrieved_chunk_ids',
  'retrieved_chunk_scores',
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
      r.retrievedChunkIds,
      r.retrievedChunkScores,
    ]),
  ]
}

/**
 * TAC-358. Serialize the knowledge chunks one scenario actually retrieved,
 * into the two index-aligned columns described on `RunRow`. Returns both
 * strings from ONE call over ONE array so misalignment between them is
 * unrepresentable rather than merely documented.
 *
 * **These are post-floor SURVIVORS ONLY, and that bounds what the columns can
 * tell you.** `retrieveKnowledgeStage` returns `filterByRelevance(...)`, so
 * nothing below `KNOWLEDGE_RELEVANCE_FLOOR` ever reaches this serializer —
 * the smallest score that can appear here is the floor itself. A near miss
 * (a chunk at 0.4971 against a 0.5 floor) is therefore INVISIBLE here, which
 * matters because that is exactly the number a recalibration of the floor
 * needs. Capturing pre-filter scores would mean changing `retrieveKnowledgeStage`,
 * which is agent-runtime code and deliberately out of scope for this change;
 * calibration evidence comes from a direct probe against the corpus instead.
 *
 * **An empty pair of cells has several causes, and they are not all equal.**
 * Distinguishable from other columns: the crisis-safety short circuit and any
 * throw predating retrieval both leave it empty, and `outcome` / `primary_trigger`
 * identify those. NOT distinguishable from each other: every chunk falling below
 * the relevance floor, zero rows clearing the confidence floor or lib/rag's own
 * similarity floor, and — the trap — a knowledge-retrieval DEGRADE, which logs a
 * `console.warn` and returns `[]` on an RPC or query-embed failure. A degraded
 * row renders identically to a genuinely starved one on an otherwise-normal
 * `sent` row. Do not read an empty pair as proof the floor is too high.
 */
export function formatRetrievedChunks(
  chunks: readonly { corpusId: string; similarity: number }[],
): { ids: string; scores: string } {
  return {
    ids: chunks.map((c) => c.corpusId).join(', '),
    scores: chunks.map((c) => c.similarity.toFixed(4)).join(', '),
  }
}
