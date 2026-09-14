import { describe, expect, it } from 'vitest'
import {
  INTENTION_DEFINITIONS,
  INTENTION_KEYS,
  type IntentionKey,
  type IntentionSatisfactionFacts,
} from './definitions'

// TAC-379. The Command Center viewer renders these definitions directly, and
// `satisfactionLabel` is prose describing what `isSatisfied` does. `satisfies
// Record<IntentionKey, ...>` on the truth table below is what makes a third
// intention fail `tsc` here until someone states its satisfaction behaviour.
//
// What each guard actually buys, stated plainly because this repo has a
// history of tests whose rationale was never true:
//   - the truth table catches a CHANGED predicate
//   - the required field on IntentionDefinition catches a MISSING label
//   - neither catches a label that is simply WRONG about a predicate nobody
//     touched. A reviewer is still the only guard there.

const SATISFACTION_TRUTH_TABLE = {
  learn_first_order: { withTransaction: true, withoutTransaction: false },
  invite_contact_save: { withTransaction: false, withoutTransaction: false },
} satisfies Record<IntentionKey, { withTransaction: boolean; withoutTransaction: boolean }>

const facts = (hasQualifyingTransaction: boolean): IntentionSatisfactionFacts => ({
  hasQualifyingTransaction,
})

describe('INTENTION_DEFINITIONS', () => {
  it('covers exactly INTENTION_KEYS, with no duplicates', () => {
    const keys = INTENTION_DEFINITIONS.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual([...INTENTION_KEYS].sort())
  })

  it('every definition carries non-empty prose in all three text fields', () => {
    for (const def of INTENTION_DEFINITIONS) {
      expect(def.promptLine.trim().length, `${def.key} promptLine`).toBeGreaterThan(0)
      expect(
        def.classifierDescription.trim().length,
        `${def.key} classifierDescription`,
      ).toBeGreaterThan(0)
      expect(def.satisfactionLabel.trim().length, `${def.key} satisfactionLabel`).toBeGreaterThan(0)
    }
  })

  // Copy-paste guard for whoever adds the third intention: the label answers
  // "how does this close", the prompt line is what the model reads, and the
  // classifier description is what the post-send classifier reads. Three
  // different questions, so three different strings.
  it('satisfactionLabel is distinct from the other two text fields', () => {
    for (const def of INTENTION_DEFINITIONS) {
      expect(def.satisfactionLabel, `${def.key}`).not.toBe(def.promptLine)
      expect(def.satisfactionLabel, `${def.key}`).not.toBe(def.classifierDescription)
    }
  })

  it('every definition has a positive expiry window', () => {
    for (const def of INTENTION_DEFINITIONS) {
      expect(def.expiresAfterMs, `${def.key}`).toBeGreaterThan(0)
    }
  })
})

describe('isSatisfied truth table', () => {
  // Deliberately a literal table rather than anything derived from the
  // predicates themselves — a derived expectation would be tautological and
  // would pass against any predicate at all.
  it.each(INTENTION_DEFINITIONS.map((d) => [d.key, d] as const))(
    '%s matches its recorded satisfaction behaviour',
    (key, def) => {
      const expected = SATISFACTION_TRUTH_TABLE[key]
      expect(def.isSatisfied(facts(true)), `${key} with a transaction`).toBe(
        expected.withTransaction,
      )
      expect(def.isSatisfied(facts(false)), `${key} with no transaction`).toBe(
        expected.withoutTransaction,
      )
    },
  )

  it('covers every definition (no key silently missing from the table)', () => {
    expect(Object.keys(SATISFACTION_TRUTH_TABLE).sort()).toEqual(
      INTENTION_DEFINITIONS.map((d) => d.key).sort(),
    )
  })
})
