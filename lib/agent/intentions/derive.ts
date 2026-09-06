import { bodyMentionsMenuItem } from '@/lib/agent/extract-reported-order'
import type { MenuItem } from '@/lib/schemas'
import {
  type IntentionDefinition,
  type IntentionKey,
  type IntentionSatisfactionFacts,
  INTENTION_DEFINITIONS,
} from './definitions'

export interface OpenIntention {
  key: IntentionKey
  promptLine: string
}

export interface DeriveOpenIntentionsInput {
  /** Only 'qr_scan' guests get a non-empty set in v1 — every other origin returns []. */
  createdVia: string
  guestCreatedAt: Date
  now: Date
  hasQualifyingTransaction: boolean
  /**
   * Keys with an existing guest_intention_prompts row for this guest. Pass
   * the FULL set of INTENTION_DEFINITIONS keys (not just what's in the DB)
   * when the read itself failed — see build-runtime-context.ts, which fails
   * CLOSED rather than open: a broken read must not re-raise something
   * already asked, so "unknown" is treated as "everything prompted," not
   * "nothing prompted."
   */
  promptedKeys: ReadonlySet<IntentionKey>
}

/**
 * Pure. No DB access — build-runtime-context.ts loads everything this needs
 * (the guest_intention_prompts read, and hasQualifyingTransaction reused from
 * the visit-history query already running in the same Promise.all) and passes
 * it in. Mirrors filterEligibleMechanics: a pure filter fed by data the
 * caller already loaded, which is also what makes every open/closed/expired
 * combination a plain unit test with no Supabase mock required.
 *
 * Uniform rule, no per-key branching here: an intention is open until it's
 * satisfied, prompted, or expired. All intention-specific logic (what
 * "satisfied" means, how long "expired" takes) lives on the definition in
 * definitions.ts, which is what keeps that file "the extension point for
 * every future intent set" — this loop never needs to change to add one.
 */
export function deriveOpenIntentions(input: DeriveOpenIntentionsInput): OpenIntention[] {
  if (input.createdVia !== 'qr_scan') return []

  const facts: IntentionSatisfactionFacts = {
    hasQualifyingTransaction: input.hasQualifyingTransaction,
  }
  const ageMs = input.now.getTime() - input.guestCreatedAt.getTime()

  const open: OpenIntention[] = []
  for (const def of INTENTION_DEFINITIONS as readonly IntentionDefinition[]) {
    if (ageMs > def.expiresAfterMs) continue // expired -> closed, regardless of prompt state
    if (input.promptedKeys.has(def.key)) continue // prompted -> closed
    if (def.isSatisfied(facts)) continue // satisfied -> closed
    open.push({ key: def.key, promptLine: def.promptLine })
  }
  return open
}

/**
 * Current-turn-only suppression of `learn_first_order`. TAC-323's extractor
 * runs post-send under waitUntil, so on the exact turn where the guest
 * answers the order question, no guest_reported transaction exists yet and
 * `learn_first_order` would still derive open — asserting "you haven't heard
 * what this guest ordered yet" into the prompt for the very message replying
 * to their order. That contradiction is the most likely path to a re-ask,
 * which is the failure this ticket exists to prevent.
 *
 * Uses the prefilter, not the LLM extractor: pure string work, answers "does
 * this message name a menu item," which is sufficient to avoid contradicting
 * a message visible in the thread. It does not decide whether the message IS
 * an order report — Haiku still does that post-send, independently.
 *
 * Deliberately takes and returns `OpenIntention[]` rather than mutating in
 * place or living inside deriveOpenIntentions: this keeps the "open until
 * satisfied/prompted/expired" derivation pure and DB-state-only, testable in
 * total isolation from anything about the CURRENT turn's inbound body.
 *
 * The result of this function is what build-runtime-context.ts threads onto
 * ctx.openIntentions — i.e. this IS the post-suppression set used for both
 * rendering and (later) recording eligibility. A suppressed key was never in
 * the set shown to the model this turn, so it can't be recorded as "raised"
 * this turn either — no separate plumbing needed to satisfy "suppression
 * writes no prompt row." And because nothing here persists anything,
 * "suppression has no effect on derivation on subsequent turns" falls out
 * for free: the next turn's deriveOpenIntentions call recomputes fresh from
 * DB state alone.
 */
export function applyCurrentTurnSuppression(
  open: readonly OpenIntention[],
  currentInboundBody: string | null,
  menuItems: readonly Pick<MenuItem, 'name'>[],
): OpenIntention[] {
  if (currentInboundBody === null) return [...open]
  if (!bodyMentionsMenuItem(currentInboundBody, menuItems)) return [...open]
  return open.filter((o) => o.key !== 'learn_first_order')
}
