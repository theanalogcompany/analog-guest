import type { EligibleMechanic, GuestState } from '@/lib/recognition'
import type {
  ActiveCommitment,
  ArrivalCaptureEmission,
  BrandPersona,
  CommitmentEmission,
  ParsedGuestContext,
  VenueInfo,
} from '@/lib/schemas'

// Naming asymmetry: this module returns voiceFidelity (camelCase). It persists
// to messages.confidence_score (snake_case) at the DB write boundary. The
// caller maps between the two names when writing the row.
// TODO: rename messages.confidence_score → messages.voice_fidelity in a future
// migration to align with this module's naming.

// THE-228 added comp_complaint / mechanic_request / recommendation_request /
// casual_chatter to the inbound classifier surface. Migration 011 widens the
// messages.category check constraint to match. v1.10.0 adds perk_inquiry +
// event_question (inbound counterparts to the outbound perk_unlock /
// event_invite triggers) and unknown (inbound catch-all that replaces the
// old practice of routing ambiguous inbounds to manual). Migration 016
// widens the constraint.
export type MessageCategory =
  | 'welcome'
  | 'follow_up'
  | 'reply'
  | 'new_question'
  | 'opt_out'
  | 'perk_unlock'
  | 'perk_inquiry'
  | 'event_invite'
  | 'event_question'
  | 'manual'
  | 'acknowledgment'
  | 'comp_complaint'
  | 'mechanic_request'
  | 'recommendation_request'
  | 'casual_chatter'
  | 'personal_history_question'
  | 'unknown'

export type VoiceCorpusSourceType =
  | 'sample_text'
  | 'voicenote_transcript'
  | 'brand_doc'
  | 'email_archive'
  | 'text_archive'
  | 'chat_transcript'
  | 'social_post'
  | 'manual_entry'
  | 'training_response'
  | 'past_message'

export type VoiceCorpusChunk = {
  id: string
  text: string
  sourceType: VoiceCorpusSourceType
  relevanceScore?: number
}

// Mirror of VoiceCorpusChunk for knowledge_corpus retrieval results. The
// tag split (TAC-242) carries two arrays: primaryTags is the closed-enum
// routing signal (lib/schemas/knowledge-tags) used to disambiguate which
// topic was matched (sourcing, staff_<name>, mechanic_<slug>, etc.);
// secondaryTags is free-form descriptive context (e.g., 'seasonal',
// 'philly', 'weekend'). Both render in the prompt for grounding; only
// primary is used by retrieval routing. source_type is the open string the
// DB stores — knowledge entries don't share voice's check constraint enum.
export type KnowledgeCorpusChunk = {
  id: string
  text: string
  sourceType: string
  primaryTags: string[]
  secondaryTags: string[]
  relevanceScore?: number
}

export type RecentMessage = {
  direction: 'inbound' | 'outbound'
  body: string
  createdAt: Date
}

// One transaction projected for the agent prompt (TAC-234). Replaces the
// single `lastVisit` shape from THE-229 with a per-row entry; the serializer
// renders these as bullets in the `## Visit history` block. Same fields as
// the prior LastVisit type — only the multiplicity changes.
export type Visit = {
  items: string[]
  visitedAt: Date
}

// TAC-244: closed enum of reasons the agent might be reaching out unprompted.
// Distinct from `FollowupTrigger.reason` on the orchestrator side — that union
// also carries `event` / `manual` which have their own dedicated context
// surfaces (`eventBeingInvited` / `operatorInstruction`). The post-visit
// variants are derived from the trigger's `day_*` reasons inside
// `buildAiRuntime`; `cold_lapsed` is the deep-lapsed re-engagement variant
// (extensible).
export type FollowupReason =
  | 'post_visit_day_1'
  | 'post_visit_day_3'
  | 'post_visit_day_7'
  | 'post_visit_day_14'
  | 'cold_lapsed'

// Anchor visit for the `## Follow-up context` block. For `post_visit_*` reasons
// this is `recentVisits[0]` and carries `items` so the prompt can name what
// the guest had. For `cold_lapsed`, the guest's last visit can fall outside
// the recentVisits window (90d / 20 txn), so the date-only anchor is loaded
// from `guests.last_visit_at` and `items` is omitted.
export type FollowupAnchorVisit = {
  visitedAt: Date
  items?: string[]
}

// TAC-244: outbound-flow context for `## Follow-up context` block rendering.
// Set only by `buildAiRuntime` when `RuntimeContext.followupTrigger` is
// present and the trigger reason maps to a renderable FollowupReason. Never
// set on the inbound flow — the entry-point assertion in `handleInbound`
// guarantees `followupTrigger === null` there. The `reasons[]` shape is
// multi-reason ready from day one (v1 engine fires one trigger at a time,
// so reasons.length === 1 in practice; multi-reason composition is a
// TAC-123 future extension).
export type FollowupContext = {
  reasons: FollowupReason[]
  daysSinceLastVisit: number
  anchorVisit?: FollowupAnchorVisit
}

export type RuntimeContext = {
  guestName?: string
  inboundMessage?: string
  perkBeingUnlocked?: {
    name: string
    qualification: string
    rewardDescription: string
  }
  eventBeingInvited?: {
    name: string
    description: string
    date: string
  }
  additionalContext?: string
  // The operator's free-text critique of a flagged outbound, threaded
  // through the Voices regen path. Rendered as a top-level
  // `## Critique to incorporate` block at the head of the user prompt so
  // Sonnet treats it as the dominant signal. Only populated by the regen
  // endpoint — production agent runs (handle-inbound, handle-followup)
  // never pass this.
  critiqueToIncorporate?: string
  // THE-232: the operator's note from the Command Center Follow Up button.
  // Surfaced as a top-level "## Operator instruction" block in the prompt
  // — distinct from additionalContext, which carries system-level framing
  // (cron trigger reasons, etc.). Only populated on the manual followup
  // path when the operator typed a note; absent for note-less manual sends
  // and for cron triggers.
  operatorInstruction?: string
  today?: {
    isoDate: string
    dayOfWeek: string
    venueLocalTime: string
    venueTimezone: string
  }
  recentMessages?: RecentMessage[]
  // Mechanics this guest is currently eligible for. The serializer renders
  // a "What this guest can access" block when this is provided. An empty
  // array is meaningful — it tells Sonnet not to offer any perks (THE-170).
  mechanics?: EligibleMechanic[]
  // Recent transactions within the freshness window, most-recent-first.
  // Serializer renders a "## Visit history" block (one bullet per visit)
  // when this is set non-empty and the category is not welcome / opt_out.
  // TAC-234 (replaces THE-229's single-transaction lastVisit). Empty array
  // means "no qualifying visits"; undefined means "not loaded on this path."
  recentVisits?: Visit[]
  // Guest's recognition band, surfaced as a `Guest relationship: <state>`
  // line near the inbound framing (TAC-234). Mirrors what TAC-240 added on
  // the classifier side — same single source of truth.
  recognition?: { state: GuestState }
  // TAC-296: per-guest accumulating context. The serializer renders a
  // `## Guest context` block (between Visit history and Recent conversation)
  // when this is set and isEmptyGuestContext returns false. Loaded by
  // build-runtime-context.ts via toParsedGuestContext (expired life_context
  // entries dropped, observations truncated to OBSERVATION_RENDER_LIMIT).
  // undefined / empty = block omitted entirely.
  guestContext?: ParsedGuestContext
  // TAC-297: open + pending_ack commitments for this guest at this venue.
  // The serializer renders a `## Active commitments` block between Guest
  // context and Recent conversation when this is non-empty. Loaded by
  // build-runtime-context.ts via findActiveCommitmentsForGuest +
  // toActiveCommitment projection. Surfacing tells the model what's already
  // been promised so it can ask for arrival timing if natural — soft, woven
  // (TAC-297 plan-review call #5), not a standing directive. undefined or
  // empty array = block omitted entirely (zero tokens).
  activeCommitments?: ActiveCommitment[]
  // TAC-244: outbound-flow follow-up context. Set only by `buildAiRuntime`
  // when `RuntimeContext.followupTrigger` is present and maps to a renderable
  // FollowupReason (post_visit_day_* or cold_lapsed). The serializer renders
  // a `## Follow-up context` block immediately BEFORE `## Visit history`
  // (intent-then-evidence: this block states *why* we're reaching out; visit
  // history is the supporting detail it draws on). Never set on inbound runs
  // by construction — the entry-point assertion in `handleInbound`
  // guarantees followupTrigger=null there. Absent on event/manual trigger
  // reasons (those have their own dedicated context surfaces).
  followup?: FollowupContext
}

export type GenerateMessageInput = {
  category: MessageCategory
  persona: BrandPersona
  venueInfo: VenueInfo
  ragChunks: VoiceCorpusChunk[]
  // Optional. When the orchestrator's shouldRetrieveKnowledge gate fires for a
  // run, retrieved knowledge_corpus chunks land here and the system prompt
  // gains a `## Venue knowledge` block. undefined → retrieval was gated off,
  // block omitted. [] → retrieval ran but matched nothing, block renders the
  // explicit no-match framing (TAC-242).
  knowledgeChunks?: KnowledgeCorpusChunk[]
  runtime: RuntimeContext
}

// TAC-296: agent-emitted patch for guests.context, threaded onto every
// GenerateMessageResult and stamped on per-attempt history. Field is required
// at the schema level (Anthropic structured-output validator is more reliable
// with explicit presence, per the TAC-212 precedent); the inner fields are
// both optional so the agent can emit `contextUpdate: {}` for the no-op case.
// The orchestrator's write step short-circuits on isEmptyContextUpdate before
// any DB hit.
export type GenerateMessageContextUpdate = {
  structured?: import('@/lib/schemas').GuestContextPatch
  observation?: string
}

// TAC-297: agent-emitted commitment (a promise made in conversation — comp,
// hold, recommendation, discount). Threaded onto every attempt and the final
// result; the orchestrator dispatches commitment intent through the approval
// queue via messages.pending_commitment for gated paths, or materializes
// inline for recommendation auto-sends. Same rigid-presence / optional-inner
// posture as contextUpdate. isEmptyCommitmentEmission short-circuits the
// no-op case before any DB hit.
export type GenerateMessageCommitment = CommitmentEmission

// TAC-297: agent-emitted arrival capture (response to an active commitment
// where the guest signals when they're arriving). Independent of the
// approval-gate outcome — fires regardless of whether the draft ships,
// queues, or refuses (TAC-296 precedent — what the agent UNDERSTOOD is
// independent of what we SAID back). isEmptyArrivalCapture short-circuits
// the no-op case.
export type GenerateMessageArrivalCapture = ArrivalCaptureEmission

export type GenerateMessageAttempt = {
  body: string
  voiceFidelity: number
  reasoning: string
  // TAC-212: model self-flag from the structured output. Surfaced per-attempt
  // for trace observability so trace viewers can see whether different attempts
  // produced different flag values.
  requiresOperatorApproval: boolean
  approvalReason: string
  // TAC-296: per-attempt context update emission. The final attempt's value
  // becomes the GenerateMessageResult.contextUpdate consumed by the
  // orchestrator's context-write step.
  contextUpdate: GenerateMessageContextUpdate
  // TAC-297: per-attempt commitment emission. Final attempt's value becomes
  // GenerateMessageResult.commitment.
  commitment: GenerateMessageCommitment
  // TAC-297: per-attempt arrival capture. Final attempt's value becomes
  // GenerateMessageResult.arrivalCapture.
  arrivalCapture: GenerateMessageArrivalCapture
  // Populated only when the user prompt for this attempt differed from the
  // top-level userPrompt — i.e., a regeneration with explicit feedback (e.g.
  // a dash-violation rewrite request). First-attempt prompts equal the parent
  // userPrompt and leave this undefined to keep the trace lean. THE-225.
  userPromptOverride?: string
}

export type GenerateMessageResult = {
  body: string
  voiceFidelity: number
  reasoning: string
  // TAC-212: final-attempt model self-flag. Consumed by
  // applyApprovalPolicyStage to decide whether the model_flagged trigger
  // fires. approvalReason carries a one-clause rationale; empty string when
  // requiresOperatorApproval=false. Recorded on the draft_queued PostHog
  // event when the gate queues.
  requiresOperatorApproval: boolean
  approvalReason: string
  // TAC-296: final-attempt guest-context patch. Consumed by the orchestrator
  // between generateStage success and applyApprovalPolicyStage. May be empty
  // (structured undefined, observation undefined) when the agent has nothing
  // new to record this turn; the orchestrator's isEmptyContextUpdate check
  // short-circuits before any DB hit in that case.
  contextUpdate: GenerateMessageContextUpdate
  // TAC-297: final-attempt commitment emission. Threaded onto
  // messages.pending_commitment by the orchestrator for gated paths (intent
  // carrier through the approval queue); materialized inline by
  // scheduleAndSend for recommendation auto-sends. Empty `{}` is the no-op
  // shape; isEmptyCommitmentEmission short-circuits before any DB hit.
  commitment: GenerateMessageCommitment
  // TAC-297: final-attempt arrival capture. Dispatched independently of the
  // approval-gate outcome (TAC-296 precedent). Empty `{}` is the no-op shape;
  // isEmptyArrivalCapture short-circuits before any DB hit.
  arrivalCapture: GenerateMessageArrivalCapture
  attempts: number
  // Each attempt's voiceFidelity score, in attempt order. Length === attempts.
  // Loop exits early on the first attempt that crosses MIN_VOICE_FIDELITY, so
  // a length-1 array means the first attempt was good enough.
  attemptScores: number[]
  // Per-attempt body + voiceFidelity + reasoning, in attempt order. Surfaced
  // for trace observability (THE-216) so each `generate.attempt_N` span can
  // carry the actual text Sonnet returned, not just the score. Length matches
  // attemptScores. The final entry's body equals the top-level `body` field.
  attemptHistory: GenerateMessageAttempt[]
  // The full system + user prompt sent to the model (THE-216). The system
  // prompt is invariant across attempts. The userPrompt here is the *parent*
  // (initial) one; regen attempts that append feedback (e.g. dash-rewrite
  // request, THE-225) record their varied prompt on
  // attemptHistory[i].userPromptOverride. Span content surfaces the override
  // when present and falls back to this parent.
  systemPrompt: string
  userPrompt: string
  promptVersion: string
  // True when the final shipped body still contains an em dash (—) or en dash
  // (–) after MAX_ATTEMPTS regenerations — the dash regex check (THE-225) was
  // unable to coax a clean reply but we ship anyway rather than refuse. The
  // orchestrator (lib/agent/stages.ts) emits dash_violation_persisted to
  // PostHog when this is true so the failure is visible without blocking the
  // send path.
  dashViolationPersisted: boolean
}

export type ClassifyMessageInput = {
  inboundBody: string
  persona?: BrandPersona
  venueInfo?: VenueInfo
  // Recent conversation history (excluding the current inbound). Rendered as
  // a `Recent conversation` block in the user prompt so one-word inbounds
  // ("yes", "iced", "sounds good") can be classified in context. Same shape
  // generation consumes; orchestrator passes ctx.recentMessages directly.
  // Mirrors the hybrid 30-message-or-14-day cap that buildRuntimeContext
  // already applies — no separate cap here.
  recentMessages?: RecentMessage[]
  // Guest's current relationship band. Disambiguates category pairs that
  // depend on relationship (a regular asking "anything new" reads as
  // recommendation_request; a new guest's same phrasing is more ambiguous).
  guestState?: GuestState
}

export type ClassifyMessageResult = {
  category: MessageCategory
  classifierConfidence: number
  reasoning: string
  promptVersion: string
}

export type AIResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; errorCode?: string }