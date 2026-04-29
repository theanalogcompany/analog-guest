import type { RecentMessage } from '@/lib/ai'
import type { VoiceCorpusChunk } from '@/lib/rag'
import type { EligibleMechanic, RelationshipSignals } from '@/lib/recognition'
import type { BrandPersona, VenueInfo } from '@/lib/schemas'
import type { AlertContext } from './alerts'

export type { AlertContext }
export type { RecentMessage }
export type { EligibleMechanic }

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
  computedAt: Date
}

// Alias of lib/rag's chunk type. The agent doesn't need a separate DTO —
// reusing keeps field names consistent across module boundaries.
export type CorpusMatch = VoiceCorpusChunk

export interface Classification {
  // Keep in sync with lib/ai's MessageCategory enum and messages.category DB constraint.
  category:
    | 'welcome'
    | 'follow_up'
    | 'reply'
    | 'new_question'
    | 'opt_out'
    | 'perk_unlock'
    | 'event_invite'
    | 'acknowledgment'
    | 'manual'
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
  corpus: CorpusMatch[] | null
  classification: Classification | null
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
