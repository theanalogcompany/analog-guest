import type { MessageCategory, RecentMessage } from '@/lib/ai'
import type { AgentTrace } from '@/lib/observability'
import type { VoiceCorpusChunk } from '@/lib/rag'
import type {
  EligibleMechanic,
  RelationshipSignals,
  RelationshipStrengthFormula,
  SignalContributions,
} from '@/lib/recognition'
import type { BrandPersona, VenueInfo } from '@/lib/schemas'
import type { AlertContext } from './alerts'
import type { LastVisit } from './extract-last-visit'

export type { AlertContext }
export type { RecentMessage }
export type { EligibleMechanic }
export type { LastVisit }

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
  // Most recent transaction within the freshness cutoff (default 60 days),
  // projected to { items, visitedAt }. Null when guest has no transactions
  // on file, the most recent is too old, or items couldn't be parsed from
  // raw_data. THE-229.
  lastVisit: LastVisit | null
  corpus: CorpusMatch[] | null
  classification: Classification | null
  // Observability handle for the current agent run (THE-200). Always present;
  // a no-op trace (`trace.id === ''`) when Langfuse isn't configured. Stages
  // open sub-spans off it; schedule-and-send writes `trace.id` to the
  // outbound row's langfuse_trace_id column.
  trace: AgentTrace
}

export type AgentResult =
  | { status: 'sent'; outboundMessageId: string }
  | { status: 'refused'; reason: string; attemptScores?: number[] }
  | { status: 'skipped_duplicate' }
  | { status: 'failed'; stage: AlertContext['stage']; error: string }

export interface TimingPlan {
  totalDelayMs: number
  markAsReadGapMs: number
  preTypingPauseMs: number
  typingDurationMs: number
}
