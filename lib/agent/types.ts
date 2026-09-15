import type { SlotDropReason } from './pending-slots'
import type {
  FollowupReason,
  MessageCategory,
  PendingQuestion,
  RecentMessage,
} from '@/lib/ai'
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
import type { ApprovalPolicy } from '@/lib/schemas/approval-policy'
import type { AlertContext } from './alerts'
import type { Visit } from './extract-recent-visits'
import type { NewlyEligibleIntention, OpenIntention } from './intentions/derive'

export type { AlertContext }
export type { RecentMessage }
export type { EligibleMechanic }
export type { Visit }
export type { OpenIntention }

/** TAC-380: the parts of one turn's intention derivation that aren't the open set. */
export interface IntentionDerivation {
  /** Seen eligible for the first time this turn, or re-armed by a newer event. handle-inbound persists these. */
  newlyEligible: NewlyEligibleIntention[]
  /** True when the unanswered-prompt brake suppressed every intention this turn. */
  brakeEngaged: boolean
}

export type AgentRunId = string

export interface VenueContext {
  id: string
  slug: string
  brandPersona: BrandPersona
  venueInfo: VenueInfo
  timezone: string
  sendblueNumber: string
  // TAC-XXX: per-venue "hold all outbound" flag. When true, every
  // guest-facing content message is held for operator review (the
  // hold_all_outbound trigger in applyApprovalPolicyStage queues it instead
  // of auto-sending) — EXCEPT compliance replies (opt_out confirmations),
  // which always auto-send. Populated from venues.hold_all_outbound by
  // build-runtime-context.ts; the column is NOT NULL DEFAULT false so this is
  // always a real boolean for a normally-built context.
  holdAllOutbound: boolean
  // v1.24.0: per-category approval routing, parsed from
  // venue_configs.approval_policy (a column seeded fleet-wide since
  // 2026-04-27 that had no reader until now). Consumed by
  // applyApprovalPolicyStage's CATEGORY_REQUIRES_APPROVAL trigger, by
  // buildAiRuntime to decide whether the generation prompt may be
  // comp-forward, and — less obviously, TAC-307 — by handleHoldingMessage,
  // which suppresses the knowledge-gap holding message entirely when policy
  // holds its category. parseApprovalPolicy fails OPEN to defaults, and the
  // defaults route comp_complaint to review — so a malformed policy produces
  // MORE operator oversight, never less.
  approvalPolicy: ApprovalPolicy
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
  // TAC-348: independent of category — see lib/ai/types.ts's
  // ClassifyMessageResult.crisisSafety for the full contract.
  crisisSafety: boolean
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
  // TAC-324 / TAC-380: intentions open for this guest on this inbound turn, in
  // priority order, rendered as the `## What you're hoping to get to` block.
  // Derived by build-runtime-context.ts (lib/agent/intentions/derive.ts). Empty
  // on every followup run, because recording only happens from
  // handle-inbound.ts and rendering on a followup would raise an intention
  // nothing ever closes. Empty while the unanswered-prompt brake is engaged.
  //
  // This is the PRE-classification set. renderableIntentions(...) narrows it
  // once the turn is classified, and both the prompt mapper (buildAiRuntime)
  // and the recording gate read that narrowed set, never this one directly.
  openIntentions: OpenIntention[]
  // TAC-380: the rest of this turn's derivation. Empty/false on followup runs.
  intentionDerivation: IntentionDerivation
  // TAC-308: the question this guest is still owed an answer to, when a
  // knowledge-gap card is sitting in the operator queue. Loaded by
  // build-runtime-context.ts via findPendingQuestion; mapped onto the AI
  // runtime by buildAiRuntime and rendered as `## Unanswered question`.
  // null = nothing outstanding, block omitted.
  //
  // The timer path (handle-holding-message.ts) overwrites `mode` to
  // 'writing_holding' on the context it builds, which is what turns this
  // block from "don't promise anything" into the holding message's brief.
  pendingQuestion: PendingQuestion | null
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
  // A card in this draft's pending slot won, so the draft was discarded:
  // nothing sent, nothing persisted. Distinct from 'refused' (the generation
  // itself wasn't good enough) because the draft here was fine; it had nowhere
  // to go. Reasons (see ApprovalDecision in stages.ts):
  //   knowledge_gap_card_protected (TAC-308) a knowledge-gap card holds the slot
  //   obligation_slot_taken (TAC-394)        a different obligation holds it
  //   slot_occupied (TAC-394)                a manual followup, which never
  //                                          overwrites a card, was refused
  | {
      status: 'dropped'
      reason: SlotDropReason
      protectedDraftId: string
      triggers: string[]
    }
  | { status: 'failed'; stage: AlertContext['stage']; error: string }

export interface TimingPlan {
  totalDelayMs: number
  markAsReadGapMs: number
  preTypingPauseMs: number
  typingDurationMs: number
}
