import { z } from 'zod'

// TAC-380: per-venue gating thresholds for intentions, stored on
// `venue_configs.intention_rules` (jsonb, nullable — migration 040). NULL means
// the code defaults. Parsed fail-OPEN, like parseFollowupRules: a malformed row
// must never take down an agent run.
//
// Deliberately NOT here: the conversation window the unanswered-prompt brake
// measures against. That reuses `followup_rules.recent_conversation_hours`, so
// "still in the same conversation" has ONE definition across followups and
// intentions (TAC-380 ruling 1). Retuning one moves the other, on purpose.
//
// Every default below is a PLACEHOLDER, not a calibration: there is no
// intention traffic yet to derive them from. Labelled as such so a bare 50
// doesn't read as measured — which is how KNOWLEDGE_RELEVANCE_FLOOR = 0.5
// survived until TAC-358.
export const IntentionRulesSchema = z.object({
  // Floor on `recognition.signals.responseRate` (normalized 0-100) for every
  // conversational-gated intention. ONE floor, not a tier per intention:
  // normalizeResponseRate reads 0 until three responses have been sent, then
  // jumps straight to ~100 for a guest who replies to everything, so tiers on
  // the ratio would all open on the same turn. Staggering is min_replies' job.
  response_rate_floor: z.number().min(0).max(100).default(50),
  // How many consecutive unanswered prompts suppress all further raising. What
  // "unanswered" means lives on isIntentionBrakeEngaged
  // (lib/agent/intentions/derive.ts) — and it is not "saw no subsequent inbound".
  unanswered_streak: z.number().int().positive().default(2),
  // Per-intention override of the minimum lifetime reply count before a
  // conversational-gated intention can become eligible. A key with no entry
  // uses the definition's own defaultMinReplies; a key matching no definition
  // is inert. Loose string keys at this LIVE boundary for the same reason
  // approval_policy's perCategory is loose: a retired intention key left in a
  // stored row must not fail the whole parse and drop every other setting.
  min_replies: z.record(z.string(), z.number().int().nonnegative()).default({}),
})

export type IntentionRules = z.infer<typeof IntentionRulesSchema>

/** Canonical default. Pinned in intention-rules.test.ts so moving one is a deliberate change. */
export const INTENTION_RULES_DEFAULT: IntentionRules = {
  response_rate_floor: 50,
  unanswered_streak: 2,
  min_replies: {},
}

/**
 * Parse `venue_configs.intention_rules` (or null/undefined) into rules with
 * defaults filled in. Never throws: a malformed value logs and yields the
 * defaults, the same posture as parseFollowupRules.
 */
export function parseIntentionRules(value: unknown): IntentionRules {
  if (value === null || value === undefined) return INTENTION_RULES_DEFAULT
  const parsed = IntentionRulesSchema.safeParse(value)
  if (!parsed.success) {
    console.warn(
      `[intention-rules] malformed intention_rules JSONB, falling back to defaults: ${parsed.error.message}`,
    )
    return INTENTION_RULES_DEFAULT
  }
  return parsed.data
}
