import type { EligibleMechanic } from '@/lib/recognition'
import type { BrandPersona, VenueInfo } from '@/lib/schemas'

// Naming asymmetry: this module returns voiceFidelity (camelCase). It persists
// to messages.confidence_score (snake_case) at the DB write boundary. The
// caller maps between the two names when writing the row.
// TODO: rename messages.confidence_score → messages.voice_fidelity in a future
// migration to align with this module's naming.

// TODO: 'acknowledgment' category requires DB migration to extend messages.category check constraint — currently in deferred batch.
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
}

export type GenerateMessageInput = {
  category: MessageCategory
  persona: BrandPersona
  venueInfo: VenueInfo
  ragChunks: VoiceCorpusChunk[]
  runtime: RuntimeContext
}

export type GenerateMessageAttempt = {
  body: string
  voiceFidelity: number
  reasoning: string
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
  // The full system + user prompt sent to the model (THE-216). The same prompt
  // is sent on every attempt — there's no per-attempt prompt mutation today —
  // so capturing once is sufficient. If the regen loop later mutates the
  // prompt between attempts, this field becomes the parent prompt and per-
  // attempt prompts would need to live on attemptHistory.
  systemPrompt: string
  userPrompt: string
  promptVersion: string
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