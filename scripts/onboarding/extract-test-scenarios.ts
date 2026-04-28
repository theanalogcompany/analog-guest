import { anthropic } from '@ai-sdk/anthropic'
import { generateObject } from 'ai'
import { z } from 'zod'

const EXTRACTION_MODEL = 'claude-sonnet-4-6'
const TEMPERATURE = 0.7

const SYSTEM_PROMPT = 'You generate test scenarios for a hospitality messaging agent.'

export const GUEST_STATES = ['new', 'returning', 'regular', 'raving_fan'] as const
export type GuestState = (typeof GUEST_STATES)[number]

const ScenarioSchema = z.object({
  category: z.string().min(1),
  guest_state: z.enum(GUEST_STATES),
  scenario: z.string().min(1),
  inbound_message: z.string().min(1),
  expected_failure: z.string().nullable(),
  is_mechanic_derived: z.boolean(),
})
export type RawScenario = z.infer<typeof ScenarioSchema>

const ScenariosOutputSchema = z.object({
  scenarios: z.array(ScenarioSchema).min(1),
})

export interface Scenario extends RawScenario {
  sample_id: string
}

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
 * Pull mechanic NAMES from the spec markdown's section 5. Regex-only —
 * full Zod parsing lives in scripts/onboarding/parse-venue-spec.ts and isn't
 * needed here. Names are normalized so they match the `category` strings
 * Sonnet emits (after stripping the `mechanic_` prefix).
 */
export function extractMechanicNames(specMarkdown: string): Set<string> {
  const re = /^###\s+Mechanic\s+\d+:\s*(.+?)\s*$/gm
  const names = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(specMarkdown)) !== null) {
    const raw = m[1].trim()
    if (!raw) continue
    names.add(normalizeName(raw))
  }
  return names
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

Generate scenarios in two passes:

## Pass 1: Universal categories

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
- Set \`is_mechanic_derived: false\`.
- For the \`category\` field, use the category's name from the fixture, lowercased and snake-cased. E.g., "menu fact" becomes "menu_fact"; "out of scope" becomes "out_of_scope".

## Pass 2: Mechanics-derived scenarios

For each mechanic, infer the minimum guest state required to access it from the mechanic's qualification or description text. Use one of: 'new', 'returning', 'regular', 'raving_fan'. Apply common-sense mapping: text like 'regulars only', 'for our regulars', or 'after a few visits' becomes 'regular'. Text like 'for our most loyal' or 'VIP' becomes 'raving_fan'. If the mechanic appears available to anyone (no qualification mentioned), use 'new' and skip the second scenario per the rules above.

For each mechanic in the venue-spec's "mechanics" section, generate two scenarios:

1. One scenario at the mechanic's inferred minimum state. The \`inbound_message\` should be a natural-sounding request for the mechanic in this venue's voice. Set \`expected_failure: null\` (the agent should honor the mechanic at this state).
2. One scenario at \`guest_state: "new"\`, only if the mechanic's inferred minimum state is NOT already "new". The \`inbound_message\` should be the same kind of natural request, but at the new-guest state the agent should decline. Set \`expected_failure: "THE-170"\` because this tests min_state filtering which doesn't ship until that ticket lands.

For each mechanic-derived scenario:
- Set \`category\` to \`mechanic_{normalized_mechanic_name}\` (snake_case). Use the mechanic's full name, snake-cased. E.g., a mechanic named "Couch Hold for Regulars" becomes category "mechanic_couch_hold_for_regulars".
- When converting a mechanic name to snake_case for the category field: drop apostrophes entirely (so "Friend's" becomes "friends"), and collapse all other punctuation including em-dashes, parens, hyphens, and periods into a single underscore. Trim edge underscores.
- Set \`is_mechanic_derived: true\`.
- The \`scenario\` field describes the situation including which mechanic is being requested.

## Output rules

- Sample IDs are assigned downstream. Leave them out of your output.
- Do not use em dashes anywhere. This is a hard rule across the entire system.
- Do not invent categories or expected_failure values. Use only what the fixture and these instructions specify.
- Generate the exact target_count per category per state. No more, no fewer.
- Mechanic-derived scenarios are in addition to, not replacing, the 17 universal categories.

Below is the test categories fixture, followed by the venue-spec.

---

# TEST CATEGORIES FIXTURE

${fixture}

---

# VENUE SPEC

${spec}`
}

/**
 * Defensive check against Sonnet truncation or oversight: every mechanic
 * named in the spec must appear in at least one mechanic-derived scenario.
 *
 * Empty `expectedMechanics` is a valid case — a venue with zero mechanics
 * passes trivially (no-op). Uncommon but not a failure.
 */
export function validateMechanicsCoverage(args: {
  scenarios: RawScenario[]
  expectedMechanics: Set<string>
}): void {
  const { scenarios, expectedMechanics } = args
  if (expectedMechanics.size === 0) return

  const covered = new Set<string>()
  for (const s of scenarios) {
    if (!s.is_mechanic_derived) continue
    if (!s.category.startsWith('mechanic_')) continue
    covered.add(s.category.slice('mechanic_'.length))
  }
  const missing: string[] = []
  for (const expected of expectedMechanics) {
    if (!covered.has(expected)) missing.push(expected)
  }
  if (missing.length > 0) {
    throw new Error(
      `extract-test-scenarios: mechanics coverage validation failed. Missing mechanics-derived scenarios for: ${missing.join(', ')}`,
    )
  }
}

/**
 * Fail-closed validation that every mechanic-derived scenario references a
 * mechanic that actually exists in the spec. Symmetric with
 * `validateUniversalCategories` — Sonnet emitting a hallucinated
 * `mechanic_xyz` category for a venue whose mechanics don't include xyz is a
 * real bug and must not propagate downstream.
 *
 * Trivially passes when there are zero `is_mechanic_derived` scenarios in
 * the input (loop never enters), regardless of expectedMechanics size.
 */
export function validateMechanicsCategoriesAreReal(args: {
  scenarios: RawScenario[]
  expectedMechanics: Set<string>
}): void {
  const { scenarios, expectedMechanics } = args
  for (const s of scenarios) {
    if (!s.is_mechanic_derived) continue
    const valid = Array.from(expectedMechanics).sort().join(', ') || '(none)'
    if (!s.category.startsWith('mechanic_')) {
      throw new Error(
        `extract-test-scenarios: unknown mechanic category "${s.category}" emitted by Sonnet. Valid mechanic names: ${valid}`,
      )
    }
    const name = s.category.slice('mechanic_'.length)
    if (!expectedMechanics.has(name)) {
      throw new Error(
        `extract-test-scenarios: unknown mechanic category "${s.category}" emitted by Sonnet. Valid mechanic names: ${valid}`,
      )
    }
  }
}

/**
 * Fail-closed validation that every universal-category scenario uses a
 * category name that exists in the fixture. An unknown category from Sonnet
 * is a real bug (hallucination, or fixture/prompt drift) and must not
 * propagate downstream.
 */
export function validateUniversalCategories(args: {
  scenarios: RawScenario[]
  validCategories: Set<string>
}): void {
  const { scenarios, validCategories } = args
  for (const s of scenarios) {
    if (s.is_mechanic_derived) continue
    if (!validCategories.has(s.category)) {
      const valid = Array.from(validCategories).sort().join(', ')
      throw new Error(
        `extract-test-scenarios: unknown universal category "${s.category}" emitted by Sonnet. Valid categories: ${valid}`,
      )
    }
  }
}

/**
 * Sort scenarios deterministically and assign sample IDs.
 *
 * Universal scenarios first, ordered by:
 *   1. fixture-category index (Category 1 first, Category 17 last)
 *   2. guest_state in GUEST_STATES order ('new' < 'returning' < 'regular' < 'raving_fan')
 *   3. inbound_message lexicographically
 *
 * Mechanic-derived scenarios last, ordered by:
 *   1. category name alphabetically
 *   2. guest_state in GUEST_STATES order
 *   3. inbound_message lexicographically
 *
 * NOTE on idempotency: re-runs of this script can produce different
 * sample_id → inbound_message mappings, because Sonnet phrasings vary across
 * calls (even at temperature 0.7). This is intentional and harmless.
 * Downstream THE-178 ingestion keys off the 08-file's sample IDs (the
 * runner's output), not the 07-file's. The 07-file's sample IDs are only
 * meaningful within a single run-and-review cycle.
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
    const aMech = a.is_mechanic_derived ? 1 : 0
    const bMech = b.is_mechanic_derived ? 1 : 0
    if (aMech !== bMech) return aMech - bMech

    if (!a.is_mechanic_derived) {
      const ai = fixtureIdx.get(a.category) ?? Number.MAX_SAFE_INTEGER
      const bi = fixtureIdx.get(b.category) ?? Number.MAX_SAFE_INTEGER
      if (ai !== bi) return ai - bi
    } else {
      const cat = a.category.localeCompare(b.category)
      if (cat !== 0) return cat
    }

    const as = stateOrder.get(a.guest_state) ?? Number.MAX_SAFE_INTEGER
    const bs = stateOrder.get(b.guest_state) ?? Number.MAX_SAFE_INTEGER
    if (as !== bs) return as - bs

    return a.inbound_message.localeCompare(b.inbound_message)
  }

  const sorted = scenarios.slice().sort(cmp)
  return sorted.map((s, i) => ({
    sample_id: `${slug}-${String(i + 1).padStart(3, '0')}`,
    ...s,
  }))
}