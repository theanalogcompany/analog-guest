// Drift guard for the draft-flagged push fire-set.
//
// THIS FILE IS THE POINT. The regression it guards against shipped twice
// (ff653be TAC-297, 0c1515c #95) past a suite of 121 passing tests, because
// nothing asserted that the push fire-set and APPROVAL_TRIGGERS agreed.
//
// The `satisfies Record<ApprovalTrigger, PushDecision>` clause in
// push-policy.ts is the PRIMARY guard — a 7th trigger fails tsc before it
// reaches vitest. These runtime assertions are belt-and-braces for the case
// where someone widens the map with a cast, or where ApprovalTrigger is ever
// refactored from derived to hand-written (see the exhaustiveness test).

import { describe, expect, it, vi } from 'vitest'

// Importing @/lib/agent/stages transitively loads the Voyage SDK, whose ESM
// build trips vitest's directory-import resolver at module load. Same dodge
// as lib/tunables/manifest.test.ts — test scaffolding only; nothing here
// instantiates a Voyage client. See CLAUDE.md → "Module split for testability".
vi.mock('voyageai', () => ({
  VoyageAIClient: class {},
}))

import { APPROVAL_TRIGGERS } from '@/lib/agent/stages'

import { _PUSH_POLICY_FOR_TESTS, shouldSendDraftFlaggedPush } from './push-policy'

describe('push-policy — exhaustiveness over APPROVAL_TRIGGERS', () => {
  it('decides push-or-skip for EVERY approval trigger, with no extras', () => {
    // fire-set ∪ skip-set === APPROVAL_TRIGGERS, exactly.
    const decided = Object.keys(_PUSH_POLICY_FOR_TESTS).sort()
    const all = Object.values(APPROVAL_TRIGGERS).sort()
    expect(decided).toEqual(all)
  })

  it('assigns only valid decisions', () => {
    for (const [trigger, decision] of Object.entries(_PUSH_POLICY_FOR_TESTS)) {
      expect(['push', 'skip'], `${trigger} has an invalid decision`).toContain(decision)
    }
  })

  // Guards the assumption the `satisfies` clause rests on. If ApprovalTrigger
  // is ever changed from `(typeof APPROVAL_TRIGGERS)[keyof typeof ...]` to a
  // hand-written union, a trigger could be added to the const object without
  // widening the type — tsc would stay green and the runtime test above
  // becomes the only guard. This asserts the const object is the source of
  // truth by checking it is non-empty and every value is a distinct string.
  it('APPROVAL_TRIGGERS is a non-empty set of unique string codes', () => {
    const values = Object.values(APPROVAL_TRIGGERS)
    expect(values.length).toBeGreaterThan(0)
    expect(new Set(values).size).toBe(values.length)
    for (const v of values) expect(typeof v).toBe('string')
  })
})

describe('shouldSendDraftFlaggedPush', () => {
  // The two triggers that silently dropped between 2026-06-01 and this fix.
  // Named explicitly so a future edit that flips either back to 'skip' has to
  // delete a test that says why it must not.
  it('pushes commitment_type_gated (TAC-297 / ff653be regression)', () => {
    expect(shouldSendDraftFlaggedPush(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)).toBe(true)
  })

  it('pushes hold_all_outbound (#95 / 0c1515c regression)', () => {
    expect(shouldSendDraftFlaggedPush(APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND)).toBe(true)
  })

  it('pushes the three original TAC-207 triggers', () => {
    expect(shouldSendDraftFlaggedPush(APPROVAL_TRIGGERS.MODEL_FLAGGED)).toBe(true)
    expect(shouldSendDraftFlaggedPush(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)).toBe(true)
    expect(
      shouldSendDraftFlaggedPush(APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR),
    ).toBe(true)
  })

  it('skips previous_pending_held — regen UPDATEs the already-pushed row in place', () => {
    expect(shouldSendDraftFlaggedPush(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)).toBe(false)
  })

  // Fail-OPEN. This is the inversion: pre-fix, an unknown trigger was dropped.
  it('pushes an unrecognized trigger rather than dropping it (fail-open)', () => {
    expect(shouldSendDraftFlaggedPush('some_trigger_shipped_next_quarter')).toBe(true)
    expect(shouldSendDraftFlaggedPush('')).toBe(true)
  })
})

describe('push-policy — knowledge_gap (TAC-308)', () => {
  // This is the push that makes the good path reachable at all: if the
  // operator doesn't see the card before the timer elapses, the guest gets a
  // holding message instead of an answer.
  it('pushes on a knowledge gap', () => {
    expect(shouldSendDraftFlaggedPush(APPROVAL_TRIGGERS.KNOWLEDGE_GAP)).toBe(true)
    expect(_PUSH_POLICY_FOR_TESTS[APPROVAL_TRIGGERS.KNOWLEDGE_GAP]).toBe('push')
  })
})
