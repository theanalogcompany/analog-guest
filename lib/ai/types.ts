import type { EligibleMechanic, GuestState } from '@/lib/recognition'
import type { BrandPersona, ParsedGuestContext, VenueInfo } from '@/lib/schemas'

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