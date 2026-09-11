import { anthropic } from '@ai-sdk/anthropic'
import { generateObject } from 'ai'
import { z } from 'zod'
// Relative import: @/* doesn't resolve when vitest loads this module via the
// test file. lib/recognition/types is leaf code (no DB deps); safe to import
// directly. Per the module-split-for-testability convention in CLAUDE.md.
import { GUEST_STATES, type GuestState } from '../../lib/recognition/types'
import type { Scenario } from './scenario-schema'

const EXTRACTION_MODEL = 'claude-sonnet-4-6'
const TEMPERATURE = 0.7

const SYSTEM_PROMPT = 'You generate test scenarios for a hospitality messaging agent.'

export { GUEST_STATES, type GuestState }

// TAC-347: this module now generates ONLY the behavior-category slice
// (the 17-category fixture) — mechanics-derived generation ("Pass 2") moved
// to generate-db-scenarios-pure.ts's generateMechanicScenarios, which reads
// mechanics.min_state / requires_operator_approval directly from the DB
// instead of asking Sonnet to infer them from spec-markdown prose. So the
// LLM output shape no longer carries is_mechanic_derived — every scenario
// this module produces is scenario_source: 'behavior' by construction.
const ScenarioSchema = z.object({
  category: z.string().min(1),
  guest_state: z.enum(GUEST_STATES),
  scenario: z.string().min(1),
  inbound_message: z.string().min(1),
  expected_failure: z.string().nullable(),
})
export type RawScenario = z.infer<typeof ScenarioSchema>

const ScenariosOutputSchema = z.object({
  scenarios: z.array(ScenarioSchema).min(1),
})

/**
 * Normalize a category or mechanic name to snake_case ascii: lowercase, strip
 * apostrophes (so possessives like "Friend's" stitch into "friends" instead
 * of "friend_s"), then replace runs of non-alphanumerics with `_`, then trim
 * leading/trailing `_`.
 *
 * The apostrophe-strip pass comes BEFORE the run-to-underscore pass so a
 * possessive doesn't introduce an orphan letter. Both ASCII (U+0027) and
 * curly (U+2018, U+2019) apostrophes are handled.
 *
 * Contract for future maintainers (round-trip examples):
 *   'Couch Hold for Regulars'                 → 'couch_hold_for_regulars'
 *   'menu fact'                               → 'menu_fact'
 *   'busy / wait times'                       → 'busy_wait_times'
 *   'out of scope'                            → 'out_of_scope'
 *   'event / mechanic-specific'               → 'event_mechanic_specific'
 *   "Friend's First Drink on the House"       → 'friends_first_drink_on_the_house'
 *   'Phoebe’s Open Mic — Regular Slot'   → 'phoebes_open_mic_regular_slot'
 *   'Complimentary Herbal Tea (Welcome Back)' → 'complimentary_herbal_tea_welcome_back'
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Pull universal-category names from the fixture in declared order. Used to
 * drive deterministic sample-ID assignment and to validate Sonnet's category
 * field against the closed set.
 */
export function parseFixtureCategoryOrder(fixtureMarkdown: string): string[] {
  const re = /^###\s+Category\s+\d+:\s*(.+?)\s*$/gm
  const order: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(fixtureMarkdown)) !== null) {
    const raw = m[1].trim()
    if (!raw) continue
    order.push(normalizeName(raw))
  }
  return order
}

export interface ExtractInput {
  slug: string
  fixtureMarkdown: string
  specMarkdown: string
}

/**
 * Single Sonnet call producing a venue-tailored scenario list. Returns the
 * raw scenarios array; sample IDs are assigned downstream by assignSampleIds.
 *
 * Per THE-157: avoid `.min`/`.max` on number fields in the LLM-output schema
 * (Anthropic structured-output rejects them). This schema has none.
 */
export async function extractTestScenarios(input: ExtractInput): Promise<RawScenario[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing env var: ANTHROPIC_API_KEY')
  }

  const userPrompt = buildUserPrompt(input.fixtureMarkdown, input.specMarkdown)

  const { object } = await generateObject({
    model: anthropic(EXTRACTION_MODEL),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    schema: ScenariosOutputSchema,
    temperature: TEMPERATURE,
  })

  return object.scenarios
}

function buildUserPrompt(fixture: string, spec: string): string {
  return `You are generating test scenarios for a hospitality messaging agent during venue onboarding. The agent texts back guests on behalf of a specific venue. Your job is to produce a list of inbound test messages that exercise the agent's voice, judgment, and venue knowledge.

You will receive two inputs:

1. **Test categories fixture**: A list of 17 universal test categories with their descriptions, target_count, guest_states, optional expected_failure markers, and example_phrasings.
2. **Venue spec**: A markdown file describing the specific venue including brand persona, menu, mechanics, and operational facts.

Generate scenarios for the universal categories only — mechanics-derived scenarios are generated separately, directly from the database, and are not part of your job here.

## Universal categories

For each of the 17 categories in the fixture, generate scenarios according to its rules:

- For each \`guest_state\` in the category's \`guest_states\` list, generate exactly \`target_count\` distinct inbound messages.
- If \`guest_states\` is \`['any']\`, generate scenarios at \`guest_state: "new"\` only.
- Each generated \`inbound_message\` must:
  - Be tailored to THIS venue's voice and offerings (not generic café boilerplate)
  - Reflect the category's intent (e.g., yes/no questions test enumeration discipline)
  - Read like a real text from a real person. Lowercase is fine, contractions are fine, brevity is fine.
  - Match the register and phrasing patterns implied by \`example_phrasings\` without copying them verbatim
- The \`scenario\` field is a one-line plain-English description of what the test situation is (e.g., "First-time guest asks for a recommendation").
- Set \`expected_failure\` from the category's marker if present, otherwise null.
- For the \`category\` field, use the category's name from the fixture, lowercased and snake-cased. E.g., "menu fact" becomes "menu_fact"; "out of scope" becomes "out_of_scope".

## Output rules

- Sample IDs are assigned downstream. Leave them out of your output.
- Do not use em dashes anywhere. This is a hard rule across the entire system.
- Do not invent categories or expected_failure values. Use only what the fixture and these instructions specify.
- Generate the exact target_count per category per state. No more, no fewer.

Below is the test categories fixture, followed by the venue-spec.

---

# TEST CATEGORIES FIXTURE

${fixture}

---

# VENUE SPEC

${spec}`
}

/**
 * Fail-closed validation that every scenario uses a category name that
 * exists in the fixture. An unknown category from Sonnet is a real bug
 * (hallucination, or fixture/prompt drift) and must not propagate
 * downstream.
 */
export function validateUniversalCategories(args: {
  scenarios: RawScenario[]
  validCategories: Set<string>
}): void {
  const { scenarios, validCategories } = args
  for (const s of scenarios) {
    if (!validCategories.has(s.category)) {
      const valid = Array.from(validCategories).sort().join(', ')
      throw new Error(
        `extract-test-scenarios: unknown universal category "${s.category}" emitted by Sonnet. Valid categories: ${valid}`,
      )
    }
  }
}

/**
 * Sort scenarios deterministically, assign sample IDs, and stamp the fixed
 * fields every behavior-category scenario carries in the unified Scenario
 * shape (scenario-schema.ts): scenario_source is always 'behavior' here —
 * mechanics-derived scenarios no longer come through this module (see
 * generate-db-scenarios-pure.ts's generateMechanicScenarios) — and the
 * fact/route/source-row fields are empty/'unknown' since an LLM-authored
 * behavior scenario has no single grounding row and no statically knowable
 * route.
 *
 * Order: fixture-category index (Category 1 first, Category 17 last), then
 * guest_state in GUEST_STATES order, then inbound_message lexicographically.
 *
 * NOTE on idempotency: re-runs of this script can produce different
 * sample_id → inbound_message mappings, because Sonnet phrasings vary across
 * calls (even at temperature 0.7). This is intentional and harmless.
 * Downstream THE-178 ingestion keys off the 08-file's sample IDs (the
 * runner's output), not the 07-file's. The 07-file's sample IDs are only
 * meaningful within a single run-and-review cycle — unlike the DB-driven
 * sources' content-stable ids (knowledge:{id}, mechanic:{id}:{state}, ...),
 * which are meant to stay stable across regenerations.
 */
export function assignSampleIds(
  scenarios: RawScenario[],
  slug: string,
  fixtureCategoryOrder: string[],
): Scenario[] {
  const fixtureIdx = new Map<string, number>()
  fixtureCategoryOrder.forEach((c, i) => fixtureIdx.set(c, i))

  const stateOrder = new Map<GuestState, number>(GUEST_STATES.map((s, i) => [s, i]))

  const cmp = (a: RawScenario, b: RawScenario): number => {
    const ai = fixtureIdx.get(a.category) ?? Number.MAX_SAFE_INTEGER
    const bi = fixtureIdx.get(b.category) ?? Number.MAX_SAFE_INTEGER
    if (ai !== bi) return ai - bi

    const as = stateOrder.get(a.guest_state) ?? Number.MAX_SAFE_INTEGER
    const bs = stateOrder.get(b.guest_state) ?? Number.MAX_SAFE_INTEGER
    if (as !== bs) return as - bs

    return a.inbound_message.localeCompare(b.inbound_message)
  }

  const sorted = scenarios.slice().sort(cmp)
  return sorted.map((s, i) => ({
    sample_id: `${slug}-${String(i + 1).padStart(3, '0')}`,
    ...s,
    topic: 'behavior',
    category: `behavior_${s.category}`,
    mode: 'graded' as const,
    scenario_source: 'behavior' as const,
    expected_facts: [],
    forbidden_claims: [],
    source_row_ids: [],
    expected_route: 'unknown' as const,
    expected_behavior: '',
  }))
}