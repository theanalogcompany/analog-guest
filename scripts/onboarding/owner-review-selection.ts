import { knowledgePassed, routingPassed, type GradedScenario } from './scorecard'
import { GUEST_STATES, type GuestState, type ScenarioSheetRow } from './scenario-schema'

/**
 * TAC-347 Stage 4. Selection logic for the `--owner-review` export: which
 * scenarios are safe to show an owner at all, and — of those — which ~30
 * are worth their limited review time.
 *
 * Two separate concerns, deliberately not conflated:
 *   - isExcludedFromOwnerReview: adversarial / safety-critical / unanswerable
 *     content is QA/robustness material, not "does this sound like us"
 *     material. Excluded before anything else runs.
 *   - classifyOwnerReviewSituation + pickDiverseForOwnerReview: of what's
 *     left, spread across categories and guest states, weighted toward the
 *     situations an owner should actually read for voice.
 */

export const OWNER_REVIEW_CANDIDATE_CAP = 60
export const OWNER_REVIEW_FINAL_CAP = 30

// The fraction of the cap reserved for the five named situations, split
// evenly across them, before any bucket repeats or 'other' is drawn from.
// 0.7 means named situations get first claim on most of the export while
// still leaving room for guest-state variety pulled from 'other'.
const NAMED_SITUATION_SHARE = 0.7

export const OWNER_REVIEW_NAMED_SITUATIONS = [
  'greeting',
  'recommendation',
  'menu_question',
  'complaint',
  'perk_request',
] as const
export type OwnerReviewSituation = (typeof OWNER_REVIEW_NAMED_SITUATIONS)[number] | 'other'

/**
 * category values are generator-source labels (`venue_topic`,
 * `owner_transcript`, `edge_<sub>`, `adversarial_<sub>`, `complaint_<sev>`,
 * `mechanic`, `unanswerable` — see generate-scenarios.ts), not a fixed
 * MessageCategory enum. `adversarial_safety_critical` is the one
 * grade-scenario.ts / grade-voice-deterministic.ts already treat specially
 * (SAFETY_CRITICAL_CATEGORY) — matched here via the `adversarial_` prefix so
 * every adversarial subcategory (not just safety_critical) is excluded, per
 * the ticket's "adversarial, safety-critical, and unanswerable" wording.
 */
export function isExcludedFromOwnerReview(s: { category: string; scenario_source: string }): boolean {
  if (s.scenario_source === 'adversarial') return true
  if (s.scenario_source === 'unanswerable') return true
  if (s.category === 'unanswerable') return true
  if (s.category.startsWith('adversarial_')) return true
  return false
}

const RECOMMENDATION_RE = /recommend|suggest|what should i (get|order|try)|what.?s good|favorite|best (seller|drink|item|pick)/i
const MENU_RE = /menu|price|cost|ingredient|dietary|vegan|gluten|dairy|oat milk|decaf|\bcalor|\bsize\b/i
const GREETING_RE = /greet|welcome|first.?time|\bintro/i

/**
 * `perk_request` and `complaint` are exact-signal — generate-scenarios.ts
 * stamps scenario_source/category directly ('mechanic', 'complaint_<sev>').
 * `greeting` / `recommendation` / `menu_question` are keyword-matched
 * against topic+category since those are venue-specific free text with no
 * fixed taxonomy post-TAC-347-Stage-1 (same pragmatic, documented-tradeoff
 * style as extract-reported-order.ts's word-matching menu prefilter) — a
 * miss here just means the scenario lands in 'other', not lost.
 */
export function classifyOwnerReviewSituation(s: {
  topic: string
  category: string
  scenario_source: string
}): OwnerReviewSituation {
  if (s.scenario_source === 'mechanic' || s.category === 'mechanic') return 'perk_request'
  if (s.scenario_source === 'complaint' || s.category.startsWith('complaint_')) return 'complaint'
  const haystack = `${s.topic} ${s.category}`.toLowerCase()
  if (GREETING_RE.test(haystack)) return 'greeting'
  if (RECOMMENDATION_RE.test(haystack)) return 'recommendation'
  if (MENU_RE.test(haystack)) return 'menu_question'
  return 'other'
}

interface OwnerReviewDescriptor {
  sampleId: string
  situation: OwnerReviewSituation
  guestState: GuestState
}

/** Round-robins a bucket across GUEST_STATES so state variety survives quota truncation. */
function interleaveByGuestState<T>(items: readonly T[], describe: (item: T) => OwnerReviewDescriptor): T[] {
  const byState = new Map<GuestState, T[]>()
  for (const state of GUEST_STATES) byState.set(state, [])
  for (const item of items) byState.get(describe(item).guestState)!.push(item)

  const result: T[] = []
  let round = 0
  let added = true
  while (added) {
    added = false
    for (const state of GUEST_STATES) {
      const bucket = byState.get(state)!
      if (bucket.length > round) {
        result.push(bucket[round])
        added = true
      }
    }
    round += 1
  }
  return result
}

/**
 * Shared picker used both pre-run (over ScenarioSheetRow candidates) and
 * post-grade (over GradedScenario survivors). Deterministic — sorts by
 * sampleId before bucketing, no RNG — so the same graded input always
 * produces the same export (important for the sheet round-trip test and
 * for a human comparing two runs).
 *
 * Two phases: (1) quota-limited round robin across the five named
 * situations only, so each gets up to its fair share before any bucket
 * repeats; (2) backfill round robin across every bucket (named overflow +
 * 'other') until `cap` is reached or every candidate is exhausted.
 */
export function pickDiverseForOwnerReview<T>(
  items: readonly T[],
  describe: (item: T) => OwnerReviewDescriptor,
  cap: number,
): T[] {
  if (cap <= 0) return []

  const sorted = [...items].sort((a, b) => describe(a).sampleId.localeCompare(describe(b).sampleId))

  const order: OwnerReviewSituation[] = [...OWNER_REVIEW_NAMED_SITUATIONS, 'other']
  const buckets = new Map<OwnerReviewSituation, T[]>()
  for (const situation of order) buckets.set(situation, [])
  for (const item of sorted) buckets.get(describe(item).situation)!.push(item)
  for (const situation of order) buckets.set(situation, interleaveByGuestState(buckets.get(situation)!, describe))

  const perNamedQuota = Math.max(1, Math.floor((cap * NAMED_SITUATION_SHARE) / OWNER_REVIEW_NAMED_SITUATIONS.length))

  const picked: T[] = []
  const cursor = new Map<OwnerReviewSituation, number>()
  for (const situation of order) cursor.set(situation, 0)

  // Phase 1: quota-limited round robin, named situations only.
  let progressed = true
  while (picked.length < cap && progressed) {
    progressed = false
    for (const situation of OWNER_REVIEW_NAMED_SITUATIONS) {
      if (picked.length >= cap) break
      const bucket = buckets.get(situation)!
      const pos = cursor.get(situation)!
      if (pos < bucket.length && pos < perNamedQuota) {
        picked.push(bucket[pos])
        cursor.set(situation, pos + 1)
        progressed = true
      }
    }
  }

  // Phase 2: backfill round robin across every bucket until cap or exhaustion.
  progressed = true
  while (picked.length < cap && progressed) {
    progressed = false
    for (const situation of order) {
      if (picked.length >= cap) break
      const bucket = buckets.get(situation)!
      const pos = cursor.get(situation)!
      if (pos < bucket.length) {
        picked.push(bucket[pos])
        cursor.set(situation, pos + 1)
        progressed = true
      }
    }
  }

  return picked
}

function describeScenario(row: ScenarioSheetRow): OwnerReviewDescriptor {
  return { sampleId: row.sample_id, situation: classifyOwnerReviewSituation(row), guestState: row.guest_state }
}

/** Pre-run selection: exclude unsafe/QA-only content, then pick a diverse, weighted candidate pool to actually run. */
export function selectOwnerReviewCandidates(
  rows: readonly ScenarioSheetRow[],
  cap: number = OWNER_REVIEW_CANDIDATE_CAP,
): ScenarioSheetRow[] {
  const eligible = rows.filter((r) => !isExcludedFromOwnerReview(r))
  return pickDiverseForOwnerReview(eligible, describeScenario, cap)
}

/**
 * A graded scenario is eligible for the owner-review export when it
 * produced real, deliverable text and passed knowledge + routing (a `null`
 * verdict — not_applicable — is not a failure and passes through).
 *   - replyBody === null: refused/failed, nothing to read.
 *   - route === 'drop': TAC-308 knowledge-gap card protection — the guest
 *     never received this text.
 *   - wouldBlankBody: TAC-309 — production blanks this before persisting,
 *     so it isn't real deliverable text either.
 */
function isOwnerReviewEligible(g: GradedScenario): boolean {
  if (g.result.replyBody === null) return false
  if (g.result.route === 'drop') return false
  if (g.result.wouldBlankBody) return false
  if (knowledgePassed(g) === false) return false
  if (routingPassed(g) === false) return false
  return true
}

function describeGraded(g: GradedScenario): OwnerReviewDescriptor {
  return { sampleId: g.scenario.sample_id, situation: classifyOwnerReviewSituation(g.scenario), guestState: g.scenario.guest_state }
}

/** Post-grade selection: filter to eligible survivors, then pick the final diverse, weighted export set. */
export function selectOwnerReviewFinal(
  graded: readonly GradedScenario[],
  cap: number = OWNER_REVIEW_FINAL_CAP,
): GradedScenario[] {
  const eligible = graded.filter(isOwnerReviewEligible)
  return pickDiverseForOwnerReview(eligible, describeGraded, cap)
}
