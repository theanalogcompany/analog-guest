import type { MessageCategory, RecentMessage } from '@/lib/ai'
import type { AgentTrace } from '@/lib/observability'
import type { KnowledgeCorpusChunk, VoiceCorpusChunk } from '@/lib/rag'
import type {
  EligibleMechanic,
  RelationshipSignals,
  RelationshipStrengthFormula,
  SignalContributions,
} from '@/lib/recognition'
import type { BrandPersona, VenueInfo } from '@/lib/schemas'
import type { AlertContext } from './alerts'
import type { Visit } from './extract-recent-visits'

export type { AlertContext }
export type { RecentMessage }
export type { EligibleMechanic }
export type { Visit }

export type AgentRunId = string

export interface VenueContext {
  id: string
  slug: string
  brandPersona: BrandPersona
  venueInfo: VenueInfo
  timezone: string
  sendblueNumber: string
}

export interface GuestContext {
  id: string
  phoneNumber: string
  firstName: string | null
  createdAt: Date
  createdVia: string
}

export interface InboundMessage {
  id: string
  providerMessageId: string
  body: string
  receivedAt: Date
}

export interface FollowupTrigger {
  reason: 'day_1' | 'day_3' | 'day_7' | 'day_14' | 'event' | 'manual'
  triggeredAt: Date
  metadata?: Record<string, unknown>
}

export interface RecognitionSnapshot {
  score: number
  state: 'new' | 'returning' | 'regular' | 'raving_fan'
  signals: RelationshipSignals
  // Per-signal weights from the venue formula and per-signal score-point
  // contributions (signal × weight). Optional so callers that don't go through
  // the full agent path (e.g. run-test-scenarios) don't have to populate them.
  // Surfaced for trace observability (THE-216).
  weights?: RelationshipStrengthFormula['weights']
  contributions?: SignalContributions
  computedAt: Date
}

// Alias of lib/rag's chunk type. The agent doesn't need a separate DTO —
// reusing keeps field names consistent across module boundaries.
export type CorpusMatch = VoiceCorpusChunk
export type KnowledgeMatch = KnowledgeCorpusChunk

export interface Classification {
  // Aliased to lib/ai's MessageCategory so this can't drift — adding a new
  // classifier category in lib/ai/types.ts widens this without a code change
  // here. THE-228: previously a hand-maintained union that lagged the AI
  // module by 4 categories.
  category: MessageCategory
  classifierConfidence: number
  reasoning: string
}

export interface RuntimeContext {
  agentRunId: AgentRunId
  venue: VenueContext
  guest: GuestContext
  currentMessage: InboundMessage | null
  followupTrigger: FollowupTrigger | null
  recentMessages: RecentMessage[]
  recognition: RecognitionSnapshot
  // Mechanics this guest is currently eligible for. Filtered at load time in
  // build-runtime-context.ts by guest's recognition state and redemption
  // history (THE-170). Empty array means "do not offer perks" — the
  // serializer renders that case explicitly so Sonnet sees the absence.
  mechanics: EligibleMechanic[]
  // Recent transactions within MAX_VISIT_HISTORY_DAYS (90), capped at
  // MAX_VISIT_HISTORY_TRANSACTIONS (20), most-recent-first. Empty array
  // when no qualifying transactions on file. TAC-234 (replaces THE-229's
  // single-visit projection).
  recentVisits: Visit[]
  corpus: CorpusMatch[] | null
  // Retrieved knowledge_corpus chunks. Populated by retrieveKnowledgeStage
  // when shouldRetrieveKnowledge fires (always for inbound; followups
  // gated to event/manual). Otherwise stays []. Distinct from voice
  // `corpus`: voice failure fails closed, knowledge degrades to [].
  knowledgeCorpus: KnowledgeMatch[] | null
  classification: Classification | null
  // Observability handle for the current agent run (THE-200). Always present;
  // a no-op trace (`trace.id === ''`) when Langfuse isn't configured. Stages
  // open sub-spans off it; schedule-and-send writes `trace.id` to the
  // outbound row's langfuse_trace_id column.
  trace: AgentTrace
}

export type AgentResult =
  | { status: 'sent'; outboundMessageId: string }
  // TAC-212: approval-policy gate routed the draft to the operator queue
  // instead of dispatching. outboundMessageId is the row created with
  // review_state='pending'; triggers carries every gate trigger that fired
  // (enumeration order); primaryTrigger is the priority-selected one that
  // also lands on messages.review_reason and shows up first in the
  // operator queue UI.
  | { status: 'queued'; outboundMessageId: string; triggers: string[]; primaryTrigger: string }
  | { status: 'refused'; reason: string; attemptScores?: number[] }
  | { status: 'skipped_duplicate' }
  | { status: 'failed'; stage: AlertContext['stage']; error: string }

export interface TimingPlan {
  totalDelayMs: number
  markAsReadGapMs: number
  preTypingPauseMs: number
  typingDurationMs: number
}
