import { z } from 'zod'
// Relative import, not `@/*` — mirrors the existing convention in
// extract-test-scenarios.ts. lib/recognition/types is leaf code (no DB/SDK
// deps), safe for both scripts to import directly per the module-split-for-
// testability convention in CLAUDE.md.
import { GUEST_STATES, type GuestState } from '../../lib/recognition/types'

export { GUEST_STATES, type GuestState }

/**
 * TAC-347 Stage 1 (redesigned per 2026-09-11 plan review). Single source of
 * truth for the scenario shape, shared by every generator and by
 * merge-scenario-sheet.ts. `category` is now a broad bucket (see
 * SCENARIO_SOURCES below); `topic` is the venue-specific taxonomy entry a
 * scenario belongs to (from the Topics tab) — the two axes the redesigned
 * Scenarios sheet reviews by.
 */
export const SCENARIO_SOURCES = [
  'venue_topic',
  'owner_transcript',
  'edge_case',
  'adversarial',
  'complaint',
  'mechanic',
  'unanswerable',
  'behavior',
] as const
export type ScenarioSource = (typeof SCENARIO_SOURCES)[number]

/**
 * The routing outcome a scenario is expected to produce. 'unknown' means the
 * outcome genuinely can't be predicted from static generation-time data
 * alone — the routing grader (Stage 3, not built) skips grading against
 * 'unknown' rather than treating it as a prediction that can fail.
 */
export const EXPECTED_ROUTES = ['send', 'queue', 'unknown'] as const
export type ExpectedRoute = (typeof EXPECTED_ROUTES)[number]

/**
 * Graded scenarios have a knowable expected outcome and get pass/fail
 * grades. Exploratory scenarios (most of the stress/adversarial set) have
 * no pass/fail — deterministic voice checks still run, but the owner's
 * reviewer verdict is what becomes that scenario's expected behavior on the
 * next run (per the ticket's Grading modes section — a Stage 3 concern,
 * this field is what threads the distinction through from generation).
 */
export const SCENARIO_MODES = ['graded', 'exploratory'] as const
export type ScenarioMode = (typeof SCENARIO_MODES)[number]

export const ScenarioSchema = z.object({
  sample_id: z.string().min(1),
  topic: z.string().min(1),
  category: z.string().min(1),
  mode: z.enum(SCENARIO_MODES),
  guest_state: z.enum(GUEST_STATES),
  scenario: z.string().min(1),
  inbound_message: z.string().min(1),
  expected_failure: z.string().nullable(),
  scenario_source: z.enum(SCENARIO_SOURCES),
  // Facts a correct reply must contain — 1-3 short items, not paragraphs.
  // Free text; Stage 3's LLM knowledge grader compares against these
  // directly.
  expected_facts: z.array(z.string()).default([]),
  // Claims a reply must NOT make (e.g. a mechanic the guest isn't eligible
  // for, a fact contradicted by this scenario's premise).
  forbidden_claims: z.array(z.string()).default([]),
  // DB row ids (knowledge_corpus.id, mechanics.id, etc.) this scenario was
  // generated from. Empty for sources with no single grounding row
  // (behavior, edge_case, adversarial, owner_transcript).
  source_row_ids: z.array(z.string()).default([]),
  expected_route: z.enum(EXPECTED_ROUTES),
  // One-line description of the correct handling for a scenario that isn't
  // about recalling a fact (edge cases, and adversarial scenarios with a
  // defined correct outcome) — e.g. "Says gift cards aren't something it
  // knows about; doesn't invent one." Empty for venue_topic/owner_transcript
  // scenarios, where expected_facts already carries this role, and for
  // adversarial scenarios with no single correct outcome (per plan review:
  // "every adversarial scenario WITH a defined correct outcome").
  expected_behavior: z.string().default(''),
})
export type Scenario = z.infer<typeof ScenarioSchema>

/**
 * The persisted shape of one Scenarios-tab row — a Scenario plus the
 * sheet-merge provenance fields merge-scenario-sheet.ts owns. Generators
 * never construct these directly; the merge layer stamps them at write
 * time. `notes` is owner-authored free text, never generator-written.
 */
export const ScenarioSheetRowSchema = ScenarioSchema.extend({
  origin: z.enum(['generated', 'owner']),
  // Hash of this row's own visible content at write time. On the next
  // regeneration, an unchanged hash means untouched (safe to replace); a
  // changed hash means the owner edited it (never overwrite).
  generated_hash: z.string(),
  // Owner-settable alternative to deleting a row: kept in the sheet, but
  // Stage 2's runner skips it.
  exclude: z.boolean().default(false),
  notes: z.string().default(''),
})
export type ScenarioSheetRow = z.infer<typeof ScenarioSheetRowSchema>
