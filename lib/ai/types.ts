import type { EligibleMechanic } from '@/lib/recognition'
import type { BrandPersona, VenueInfo } from '@/lib/schemas'

// Naming asymmetry: this module returns voiceFidelity (camelCase). It persists
// to messages.confidence_score (snake_case) at the DB write boundary. The
// caller maps between the two names when writing the row.
// TODO: rename messages.confidence_score → messages.voice_fidelity in a future
// migration to align with this module's naming.

// THE-228 added comp_complaint / mechanic_request / recommendation_request /
// casual_chatter to the inbound classifier surface. Migration 011 widens the
// messages.category check constraint to match.
export type MessageCategory =
  | 'welcome'
  | 'follow_up'
  | 'reply'
  | 'new_question'
  | 'opt_out'
  | 'perk_unlock'
  | 'event_invite'
  | 'manual'
  | 'acknowledgment'
  | 'comp_complaint'
  | 'mechanic_request'
  | 'recommendation_request'
  | 'casual_chatter'
  | 'personal_history_question'

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

// Mirror of VoiceCorpusChunk for knowledge_corpus retrieval results. Adds a
// topical `tags` array that the prompt serializer renders alongside each
// chunk so Sonnet can disambiguate which topic was matched (sourcing,
// staff_<name>, mechanic_<slug>, ceremony, etc.). source_type is the open
// string the DB stores — knowledge entries don't share voice's check
// constraint enum.
export type KnowledgeCorpusChunk = {
  id: string
  text: string
  sourceType: string
  tags: string[]
  relevanceScore?: number
}

export type RecentMessage = {
  direction: 'inbound' | 'outbound'
  body: string
  createdAt: Date
}

export type RuntimeContext = {
  guestName?: string
  lastVisitDate?: string
  daysSinceLastVisit?: number
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
  // Most recent transaction within the freshness cutoff. The serializer
  // renders a "## Last visit" block (with relative time + comma-joined
  // item names) when this is set and the category is not welcome / opt_out.
  // THE-229. Shape mirrors lib/agent/types.ts's LastVisit; defined inline
  // here to keep lib/ai self-contained (same convention as RecentMessage).
  lastVisit?: {
    items: string[]
    visitedAt: Date
  }
}

export type GenerateMessageInput = {
  category: MessageCategory
  persona: BrandPersona
  venueInfo: VenueInfo
  ragChunks: VoiceCorpusChunk[]
  // Optional. When the orchestrator's shouldRetrieveKnowledge gate fires for a
  // run, retrieved knowledge_corpus chunks land here and the system prompt
  // gains a `## Venue knowledge` block. Empty array or undefined → block omitted.
  knowledgeChunks?: KnowledgeCorpusChunk[]
  runtime: RuntimeContext
}

export type GenerateMessageAttempt = {
  body: string
  voiceFidelity: number
  reasoning: string
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