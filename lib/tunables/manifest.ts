// Hand-maintained manifest of operational tunables (TAC-183).
//
// Each entry imports the live constant from its source so values can
// never drift; only the display metadata (name, description, category)
// is local to this file. Phase 1 is read-only — the Command Center
// viewer at /admin/tunables consumes this array directly. Editable
// overrides are Phase 2.
//
// Invariant: STRONG_MATCH_SIMILARITY (agent gate) >= SIMILARITY_FLOOR
// (rag layer filter). The agent's gate counts chunks the rag layer has
// already admitted; if the agent gate were lower, the count would be
// capped by what rag returned anyway. Asserted in manifest.test.ts.

import {
  LAST_VISIT_CUTOFF_DAYS,
  MAX_HISTORY_DAYS,
  MAX_HISTORY_MESSAGES,
} from '@/lib/agent/build-runtime-context'
import {
  CORPUS_RETRIEVE_LIMIT,
  KNOWLEDGE_RETRIEVE_LIMIT,
  MIN_STRONG_MATCHES,
  SEND_FIDELITY_FLOOR,
  STRONG_MATCH_SIMILARITY,
} from '@/lib/agent/stages'
import {
  MARK_AS_READ_GAP_MAX_MS,
  MARK_AS_READ_GAP_MIN_MS,
  TOTAL_DELAY_MAX_MS,
  TOTAL_DELAY_MIN_MS,
} from '@/lib/agent/timing'
import { MAX_CLASSIFIER_INPUT_CHARS } from '@/lib/ai/classify-message'
import { MAX_ATTEMPTS, MIN_VOICE_FIDELITY } from '@/lib/ai/generate-message'
import {
  AGENT_LATENCY_HIGH_THRESHOLD_MS,
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD,
  CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD,
  CORPUS_TOP_SIMILARITY_LOW_THRESHOLD,
  VOICE_FIDELITY_LOW_THRESHOLD,
  WEBHOOK_SILENCE_THRESHOLD_HOURS,
} from '@/lib/analytics/posthog'
import {
  DEFAULT_LIMIT,
  KNOWLEDGE_CONFIDENCE_FLOOR_DEFAULT,
  SIMILARITY_FLOOR,
} from '@/lib/rag/retrieve'
import { VISIT_LOOKBACK_DAYS } from '@/lib/recognition/load-signals'
import {
  MONEY_MAX_DOLLARS,
  RECENCY_BANDS,
  RESPONSE_MIN_SAMPLE,
  VISIT_FREQ_MAX_VISITS,
} from '@/lib/recognition/normalize-signals'
import {
  DEFAULT_FORMULA,
  DEFAULT_STATE_THRESHOLDS,
  ENGAGEMENT_EVENT_WEIGHTS,
} from '@/lib/recognition/types'
import { MATCH_LIMIT, SIMILARITY_THRESHOLD } from '@/lib/voices/find-pattern-cluster'
import { MIN_PRIOR_MATCHES_FOR_CLUSTER } from '@/lib/voices/find-pattern-cluster-pure'

export type TunableCategory =
  | 'agent_runtime'
  | 'classification'
  | 'timing'
  | 'recognition'
  | 'retrieval'
  | 'mechanics'

export type TunableType = 'number' | 'boolean' | 'string-enum' | 'range' | 'object'

export interface Tunable {
  readonly name: string
  readonly value: unknown
  readonly type: TunableType
  readonly category: TunableCategory
  readonly source: string
  readonly description: string
  readonly relatedTickets?: readonly string[]
}

export const TUNABLES = [
  // ---------------------------------------------------------------------------
  // agent_runtime (10)
  // ---------------------------------------------------------------------------
  {
    name: 'agent_latency_high_threshold_ms',
    value: AGENT_LATENCY_HIGH_THRESHOLD_MS,
    type: 'number',
    category: 'agent_runtime',
    source: 'lib/analytics/posthog.ts',
    description: 'Latency above which a slow-agent-run alert fires.',
  },
  {
    name: 'corpus_top_similarity_low_threshold',
    value: CORPUS_TOP_SIMILARITY_LOW_THRESHOLD,
    type: 'number',
    category: 'agent_runtime',
    source: 'lib/analytics/posthog.ts',
    description: 'Top-match cosine score below which a thin-retrieval alert fires.',
  },
  {
    name: 'last_visit_cutoff_days',
    value: LAST_VISIT_CUTOFF_DAYS,
    type: 'number',
    category: 'agent_runtime',
    source: 'lib/agent/build-runtime-context.ts',
    description: 'Maximum age of a transaction allowed to surface as the guest’s lastVisit context.',
    relatedTickets: ['THE-229'],
  },
  {
    name: 'max_attempts',
    value: MAX_ATTEMPTS,
    type: 'number',
    category: 'agent_runtime',
    source: 'lib/ai/generate-message.ts',
    description: 'Maximum regeneration attempts before settling on the highest-fidelity result.',
  },
  {
    name: 'max_history_days',
    value: MAX_HISTORY_DAYS,
    type: 'number',
    category: 'agent_runtime',
    source: 'lib/agent/build-runtime-context.ts',
    description: 'Lookback window for recent message history loaded into runtime context.',
  },
  {
    name: 'max_history_messages',
    value: MAX_HISTORY_MESSAGES,
    type: 'number',
    category: 'agent_runtime',
    source: 'lib/agent/build-runtime-context.ts',
    description: 'Cap on recent message rows loaded into runtime context.',
  },
  {
    name: 'min_voice_fidelity',
    value: MIN_VOICE_FIDELITY,
    type: 'number',
    category: 'agent_runtime',
    source: 'lib/ai/generate-message.ts',
    description: 'Voice fidelity target for the regeneration loop; below, regenerate; above, ship.',
  },
  {
    name: 'send_fidelity_floor',
    value: SEND_FIDELITY_FLOOR,
    type: 'number',
    category: 'agent_runtime',
    source: 'lib/agent/stages.ts',
    description: 'Voice fidelity below this refuses to send and fires a red alert.',
  },
  {
    name: 'voice_fidelity_low_threshold',
    value: VOICE_FIDELITY_LOW_THRESHOLD,
    type: 'number',
    category: 'agent_runtime',
    source: 'lib/analytics/posthog.ts',
    description: 'Voice fidelity below this fires a low-fidelity alert (sits between send floor and regen target).',
  },
  {
    name: 'webhook_silence_threshold_hours',
    value: WEBHOOK_SILENCE_THRESHOLD_HOURS,
    type: 'number',
    category: 'agent_runtime',
    source: 'lib/analytics/posthog.ts',
    description: 'Inbound-webhook silence above this duration fires a webhook-silence alert.',
  },

  // ---------------------------------------------------------------------------
  // classification (3)
  // ---------------------------------------------------------------------------
  {
    name: 'classification_confidence_low_threshold',
    value: CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD,
    type: 'number',
    category: 'classification',
    source: 'lib/analytics/posthog.ts',
    description: 'Classifier confidence below this fires a low-confidence alert.',
  },
  {
    name: 'classification_confidence_reroute_threshold',
    value: CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD,
    type: 'number',
    category: 'classification',
    source: 'lib/analytics/posthog.ts',
    description: 'Classifier confidence below this auto-routes the returned category to `unknown`; the agent ships a holding response instead of proceeding with the low-confidence pick. Original category preserved on the PostHog event.',
    relatedTickets: ['TAC-240'],
  },
  {
    name: 'max_classifier_input_chars',
    value: MAX_CLASSIFIER_INPUT_CHARS,
    type: 'number',
    category: 'classification',
    source: 'lib/ai/classify-message.ts',
    description: 'Inbound length cap sent to the classifier; longer messages are truncated with a `[...truncated]` suffix. Generation still receives the full body.',
    relatedTickets: ['TAC-240'],
  },

  // ---------------------------------------------------------------------------
  // timing (4)
  // ---------------------------------------------------------------------------
  {
    name: 'mark_as_read_gap_max_ms',
    value: MARK_AS_READ_GAP_MAX_MS,
    type: 'number',
    category: 'timing',
    source: 'lib/agent/timing.ts',
    description: 'Maximum delay before the agent marks an inbound message as read.',
  },
  {
    name: 'mark_as_read_gap_min_ms',
    value: MARK_AS_READ_GAP_MIN_MS,
    type: 'number',
    category: 'timing',
    source: 'lib/agent/timing.ts',
    description: 'Minimum delay before the agent marks an inbound message as read.',
  },
  {
    name: 'total_delay_max_ms',
    value: TOTAL_DELAY_MAX_MS,
    type: 'number',
    category: 'timing',
    source: 'lib/agent/timing.ts',
    description: 'Maximum total human-feel delay from inbound to send.',
  },
  {
    name: 'total_delay_min_ms',
    value: TOTAL_DELAY_MIN_MS,
    type: 'number',
    category: 'timing',
    source: 'lib/agent/timing.ts',
    description: 'Minimum total human-feel delay from inbound to send.',
  },

  // ---------------------------------------------------------------------------
  // recognition (8)
  // ---------------------------------------------------------------------------
  {
    name: 'default_formula',
    value: DEFAULT_FORMULA,
    type: 'object',
    category: 'recognition',
    source: 'lib/recognition/types.ts',
    description: 'Default relationship-strength formula: signal weights, multiplier bands, stacking cap. Per-venue overridable in venue_configs.',
  },
  {
    name: 'default_state_thresholds',
    value: DEFAULT_STATE_THRESHOLDS,
    type: 'object',
    category: 'recognition',
    source: 'lib/recognition/types.ts',
    description: 'Default score bands for the four guest states (new, returning, regular, raving_fan). Per-venue overridable in venue_configs.',
  },
  {
    name: 'engagement_event_weights',
    value: ENGAGEMENT_EVENT_WEIGHTS,
    type: 'object',
    category: 'recognition',
    source: 'lib/recognition/types.ts',
    description: 'Per-event-type weight applied to the engagement signal.',
  },
  {
    name: 'money_max_dollars',
    value: MONEY_MAX_DOLLARS,
    type: 'number',
    category: 'recognition',
    source: 'lib/recognition/normalize-signals.ts',
    description: 'Spend in the lookback window that scores 100 on the money signal.',
  },
  {
    name: 'recency_bands',
    value: RECENCY_BANDS,
    type: 'object',
    category: 'recognition',
    source: 'lib/recognition/normalize-signals.ts',
    description: 'Days-since-last-visit bands mapped to a recency score (0–100).',
  },
  {
    name: 'response_min_sample',
    value: RESPONSE_MIN_SAMPLE,
    type: 'number',
    category: 'recognition',
    source: 'lib/recognition/normalize-signals.ts',
    description: 'Minimum outbound message count before the response-rate signal contributes (below, scores 0).',
  },
  {
    name: 'visit_freq_max_visits',
    value: VISIT_FREQ_MAX_VISITS,
    type: 'number',
    category: 'recognition',
    source: 'lib/recognition/normalize-signals.ts',
    description: 'Visit count in the lookback window that scores 100 on the visit-frequency signal.',
  },
  {
    name: 'visit_lookback_days',
    value: VISIT_LOOKBACK_DAYS,
    type: 'number',
    category: 'recognition',
    source: 'lib/recognition/load-signals.ts',
    description: 'Time window over which visit and spend signals are computed.',
  },

  // ---------------------------------------------------------------------------
  // retrieval (10)
  // ---------------------------------------------------------------------------
  {
    name: 'corpus_retrieve_limit',
    value: CORPUS_RETRIEVE_LIMIT,
    type: 'number',
    category: 'retrieval',
    source: 'lib/agent/stages.ts',
    description: 'Top-K voice corpus chunks the agent requests per run.',
  },
  {
    name: 'default_limit',
    value: DEFAULT_LIMIT,
    type: 'number',
    category: 'retrieval',
    source: 'lib/rag/retrieve.ts',
    description: 'Fallback voice corpus retrieval limit when the caller passes none.',
  },
  {
    name: 'knowledge_confidence_floor_default',
    value: KNOWLEDGE_CONFIDENCE_FLOOR_DEFAULT,
    type: 'number',
    category: 'retrieval',
    source: 'lib/rag/retrieve.ts',
    description: 'Default min_confidence applied to match_knowledge_corpus when the caller does not override. Excludes low-confidence chunks from the prompt; matches the classifier low-confidence threshold for symmetry.',
    relatedTickets: ['TAC-242'],
  },
  {
    name: 'knowledge_retrieve_limit',
    value: KNOWLEDGE_RETRIEVE_LIMIT,
    type: 'number',
    category: 'retrieval',
    source: 'lib/agent/stages.ts',
    description: 'Top-K knowledge corpus chunks the agent requests per run.',
  },
  {
    name: 'match_limit',
    value: MATCH_LIMIT,
    type: 'number',
    category: 'retrieval',
    source: 'lib/voices/find-pattern-cluster.ts',
    description: 'Maximum prior critiques returned per cosine search in the voices clustering pipeline.',
    relatedTickets: ['THE-238'],
  },
  {
    name: 'min_prior_matches_for_cluster',
    value: MIN_PRIOR_MATCHES_FOR_CLUSTER,
    type: 'number',
    category: 'retrieval',
    source: 'lib/voices/find-pattern-cluster-pure.ts',
    description: 'Minimum prior critique matches required before a cluster verification call fires.',
    relatedTickets: ['THE-238'],
  },
  {
    name: 'min_strong_matches',
    value: MIN_STRONG_MATCHES,
    type: 'number',
    category: 'retrieval',
    source: 'lib/agent/stages.ts',
    description: 'Minimum chunks at or above STRONG_MATCH_SIMILARITY required on the inbound path; below, the agent bails to a fallback acknowledgment. Followup path skips this gate.',
  },
  {
    name: 'similarity_floor',
    value: SIMILARITY_FLOOR,
    type: 'number',
    category: 'retrieval',
    source: 'lib/rag/retrieve.ts',
    description: 'Cosine score below which retrieval results are dropped at the rag layer (filters before chunks reach the agent).',
  },
  {
    name: 'similarity_threshold',
    value: SIMILARITY_THRESHOLD,
    type: 'number',
    category: 'retrieval',
    source: 'lib/voices/find-pattern-cluster.ts',
    description: 'Cosine threshold for two voice critiques to count as cluster members.',
    relatedTickets: ['THE-238'],
  },
  {
    name: 'strong_match_similarity',
    value: STRONG_MATCH_SIMILARITY,
    type: 'number',
    category: 'retrieval',
    source: 'lib/agent/stages.ts',
    description: 'Cosine threshold a voice corpus chunk must meet to count as a strong match for the inbound retrieval gate.',
  },
] as const satisfies readonly Tunable[]
