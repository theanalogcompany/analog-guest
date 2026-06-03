import type { FollowupReason, MessageCategory, RecentMessage } from '@/lib/ai'
import type { AgentTrace } from '@/lib/observability'
import type { KnowledgeCorpusChunk, VoiceCorpusChunk } from '@/lib/rag'
import type {
  EligibleMechanic,
  RelationshipSignals,
  RelationshipStrengthFormula,
  SignalContributions,
} from '@/lib/recognition'
import type {
  ActiveCommitment,
  BrandPersona,
  ParsedGuestContext,
  VenueInfo,
} from '@/lib/schemas'
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
  // TAC-284: per-guest demo flag. When true, the agent runtime bypasses the
  // TAC-212 approval policy gate (applyApprovalPolicyStage short-circuits to
  // send) and skips the human-feel delay. Populated from guests.is_demo by
  // build-runtime-context.ts; the column is NOT NULL DEFAULT false so this
  // is always a real boolean for a normally-built context.
  isDemo: boolean
  // TAC-296: per-guest accumulating context (dietary, home base, life events,
  // observations). Loaded from guests.context JSONB, run through
  // toParsedGuestContext (filters expired life_context entries + truncates
  // observations) so the runtime-ready shape is already prompt-safe. The
  // persisted shape lives in lib/schemas/guest-context.ts; this nested field
  // sidesteps the name collision between the orchestrator's GuestContext
  // interface (this one — "everything we know about the guest") and the
  // schema's GuestContext type (just the JSONB payload).
  context: ParsedGuestContext
  // TAC-244: guest's last visit timestamp (from guests.last_visit_at). The
  // `cold_lapsed` follow-up reason needs an anchor that survives a guest
  // whose last visit fell outside the recentVisits window (90d / 20 txn),
  // and that's this column. `null` for guests who have never visited. Used
  // by `buildAiRuntime` to derive `FollowupContext.anchorVisit` for cold
  // reasons; the post_visit_* reasons default to `recentVisits[0]` and
  // ignore this field.
  lastVisitAt: Date | null
}

export interface InboundMessage {
  id: string
  providerMessageId: string
  body: string
  receivedAt: Date
}

export interface FollowupTrigger {
  // TAC-244 added `cold_lapsed` as forward-scaffold for the TAC-123 trigger
  // engine — that engine now fires both `cold_lapsed` and `perk_unlock`. The
  // single primary `reason` carries the highest-priority detector hit; when
  // multiple reasons applied on one engine pass, the rest ride in
  // `additionalReasons` and the render seam in `deriveFollowupContext`
  // combines them into `FollowupContext.reasons[]`. We do NOT widen `reason`
  // into an array — keeping it scalar means every existing call site that
  // constructs a FollowupTrigger compiles unchanged.
  reason:
    | 'day_1'
    | 'day_3'
    | 'day_7'
    | 'day_14'
    | 'cold_lapsed'
    | 'perk_unlock'
    | 'event'
    | 'manual'
  // TAC-123: engine-aggregated secondary reasons for this run. The primary
  // already lives on `reason` above; this array carries the OTHER reasons that
  // also applied on this guest's tick, already mapped to the AI-side
  // `FollowupReason` shape (the render-time enum). `deriveFollowupContext`
  // concatenates `[primaryMapped, ...additionalReasons]` (dedup-aware) into
  // the rendered block. Legacy callers omit this; they get the length-one
  // identity path through the seam.
  additionalReasons?: readonly FollowupReason[]
  // TAC-123: when `reason === 'perk_unlock'` or `additionalReasons` includes
  // `'perk_unlock'`, the engine threads the chosen mechanic here. The mapping
  // seam in `buildAiRuntime` reads this and populates the AI runtime's
  // `perkBeingUnlocked`. Typed channel (not metadata) so the schema is
  // structural.
  perkMechanic?: EligibleMechanic
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
  // TAC-297: open + pending_ack commitments for this guest at this venue.
  // Loaded by build-runtime-context.ts via findActiveCommitmentsForGuest and
  // projected through toActiveCommitment. Surfaced as the ## Active commitments
  // user-prompt block by the serializer. Empty array = no active commitments,
  // block is omitted. Used by the agent to know what's already been promised
  // (so it can ask for arrival timing if natural — soft, woven, not a standing
  // directive).
  activeCommitments: ActiveCommitment[]
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
