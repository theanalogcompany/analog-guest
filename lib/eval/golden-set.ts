// The golden set: the questions a guest actually asks, run through v1 and v2
// side by side so a human can read the two answers next to each other.
//
// GOLDEN_QUESTIONS below IS the set. A question's definition lives here and
// nowhere else, so adding or rewording one is an edit to this array, reviewed
// in the PR that changes it, with no SQL and no apply - the direction decision
// 0011 established for regression scenarios, applied here from the start. No
// table carries a question, so there is no overlay to merge and no way for a
// question added in code to be silently inert.
//
// NO EXPECTATIONS, DELIBERATELY. There is no expected answer, no grader and no
// pass/fail: the output is `question | v1 | v2` for a human to judge
// (owner-ruled 2026-10-08). That is why a question carries no `enabled` flag
// either - skipping some for a cheap iteration is `--questions=` on the
// harness, and the run row records whether the run covered the whole set.
//
// EVERY QUESTION IS A COLD OPEN - the guest's first ever message, no history.
// Both arms therefore see a stranger with zero visits, which is exact parity
// and also the condition under which the two engines differ most: v2 resolves
// to first_contact and will often spend part of the reply on a welcome. That
// is real engine behaviour, not a harness artifact, and reading it 31 times is
// part of the point.
//
// Pure module: no SDK init and no DB client, importable from scripts and app
// code alike. The one value import is the Zod schema, which pulls in nothing
// but zod.

import { GoldenQuestionSchema, type GoldenQuestion } from '@/lib/schemas/golden'

/**
 * The set, in display order. Grouped for reading, not for behaviour.
 *
 * Venue-scoped to Le Mil's Coffee by content - the Almost Latte, the gulab
 * jamun cake, the farm - which is also the default measurement venue every
 * prior v2 harness ran on, so these replies sit beside those runs.
 */
export const GOLDEN_QUESTIONS: GoldenQuestion[] = [
  { key: 'hours', group: 'logistics', question: 'What are your hours?' },
  {
    key: 'location-parking',
    group: 'logistics',
    question: 'Where are you, and is there parking?',
  },
  {
    key: 'work-wifi',
    group: 'logistics',
    question: 'Can I work from there? Is there wifi?',
  },
  { key: 'dog', group: 'logistics', question: 'Can I bring my dog?' },
  {
    key: 'baby-changing-table',
    group: 'logistics',
    question: 'Is it okay to bring a baby? Is there a changing table?',
  },
  {
    key: 'group-of-eight',
    group: 'logistics',
    question: 'Coming with 8 people, will we fit?',
  },
  { key: 'bathroom', group: 'logistics', question: "Where's the bathroom?" },
  {
    key: 'upstairs-seating',
    group: 'logistics',
    question: 'Is there seating upstairs?',
  },
  { key: 'see-menu', group: 'logistics', question: 'Can I see the menu?' },

  { key: 'oat-milk', group: 'menu', question: 'Do you have oat milk?' },
  { key: 'decaf', group: 'menu', question: 'Do you have decaf?' },
  {
    key: 'flat-white-price',
    group: 'menu',
    question: 'How much is a flat white?',
  },
  {
    key: 'almost-latte',
    group: 'menu',
    question: "What's in the Almost Latte?",
  },

  {
    key: 'gluten-free',
    group: 'dietary',
    question: 'Is anything gluten-free?',
  },
  {
    key: 'vegan',
    group: 'dietary',
    question: "I'm vegan, what can I get?",
  },
  {
    key: 'brownie-gluten-free',
    group: 'dietary',
    question: 'Is the toffee and sea salt brownie gluten-free?',
  },
  {
    key: 'gulab-jamun-vegan',
    group: 'dietary',
    question: 'Is the gulab jamun cake vegan?',
  },
  {
    key: 'nut-allergy',
    group: 'dietary',
    question: "I have a nut allergy, what's safe?",
  },

  {
    key: 'first-time',
    group: 'recommend',
    question: 'First time coming, what should I get?',
  },
  {
    key: 'pour-over-beans-today',
    group: 'recommend',
    question: 'Which beans are on pour over today?',
  },
  {
    key: 'pastry-pairing',
    group: 'recommend',
    question: 'What pastry goes with my pour over?',
  },

  {
    key: 'farm-coffee',
    group: 'origin',
    question: 'Is this coffee from your farm?',
  },
  {
    key: 'farm-photos',
    group: 'origin',
    question: 'Can I see photos of the farm?',
  },
  {
    key: 'buy-a-bag',
    group: 'origin',
    question: "Can I buy a bag of what I'm drinking?",
  },

  {
    key: 'order-ahead',
    group: 'boundary',
    question: 'Can I order ahead for pickup?',
  },
  {
    key: 'order-and-pay',
    group: 'boundary',
    question: 'Can I order and pay through here?',
  },
  {
    key: 'wifi-password',
    group: 'boundary',
    question: "What's the wifi password?",
  },
  {
    key: 'events-this-week',
    group: 'boundary',
    question: 'Anything happening at the shop this week?',
  },
  {
    key: 'catering',
    group: 'boundary',
    question: 'Do you do catering or private events?',
  },

  {
    key: 'order-slow',
    group: 'complaint',
    question: "My order's taken 15 minutes",
  },
  { key: 'latte-cold', group: 'complaint', question: 'My latte came out cold' },
]

/**
 * Does the set satisfy its own schema? The array is a hand-edited literal, so
 * `tsc` checks its shape but not a key with a capital letter, an empty
 * question or a duplicate key - and a duplicate key would silently collapse
 * two questions into one row, because `golden_run_units` is unique on
 * (run_id, question_key).
 *
 * Offline boundary, so this fails CLOSED and loudly at the caller, before any
 * model call: an hour of generations lost to a typo in the array is the
 * failure being prevented. Returns one message per bad question, empty when
 * clean. (Same shape and same reasoning as validateScenarioSet.)
 */
export function validateGoldenSet(
  questions: readonly GoldenQuestion[] = GOLDEN_QUESTIONS,
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const question of questions) {
    const parsed = GoldenQuestionSchema.strict().safeParse(question)
    if (!parsed.success) {
      problems.push(
        `${question.key}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      )
    }
    if (seen.has(question.key)) problems.push(`${question.key}: duplicate key`)
    seen.add(question.key)
  }
  return problems
}
