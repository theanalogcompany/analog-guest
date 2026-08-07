// FIXTURES WRITTEN BEFORE THE MODULE (v1.24.0).
//
// venue_configs.approval_policy has been seeded fleet-wide since 2026-04-27
// (commit 6828918) as {"default":"auto_send","perCategory":{}} with ZERO
// readers and no Zod schema. This is the ticket that wires it.
//
// The load-bearing behavior is the MERGE: every venue in production carries
// an EMPTY perCategory, so if the stored value simply replaced the code
// default, wiring the column would silently route nothing and the whole fix
// would no-op in prod while passing in tests. Defaults must survive an empty
// stored object; only an explicit per-category entry may override.

import { describe, expect, it, vi } from 'vitest'

import {
  APPROVAL_POLICY_DEFAULT,
  parseApprovalPolicy,
  resolveCategoryPolicy,
} from './approval-policy'

/** The literal value on every venue in production today. */
const PRODUCTION_SEEDED_VALUE = { default: 'auto_send', perCategory: {} }

describe('APPROVAL_POLICY_DEFAULT', () => {
  it('routes comp_complaint to operator approval', () => {
    expect(APPROVAL_POLICY_DEFAULT.perCategory.comp_complaint).toBe('operator_approval')
  })

  it('leaves the global default at auto_send', () => {
    // Routing every category to approval would queue the entire product.
    expect(APPROVAL_POLICY_DEFAULT.default).toBe('auto_send')
  })
})

describe('parseApprovalPolicy — the production value', () => {
  // THE test. Every venue has perCategory:{} right now.
  it('keeps the code-level comp_complaint route when the stored perCategory is empty', () => {
    const policy = parseApprovalPolicy(PRODUCTION_SEEDED_VALUE)
    expect(resolveCategoryPolicy(policy, 'comp_complaint')).toBe('operator_approval')
  })

  it('still auto-sends unrouted categories under the production value', () => {
    const policy = parseApprovalPolicy(PRODUCTION_SEEDED_VALUE)
    expect(resolveCategoryPolicy(policy, 'mechanic_request')).toBe('auto_send')
    expect(resolveCategoryPolicy(policy, 'reply')).toBe('auto_send')
  })
})

describe('parseApprovalPolicy — fail OPEN to defaults', () => {
  // Mirrors parseFollowupRules: a malformed jsonb must not break the agent
  // loop. But note the asymmetry with followup-rules — falling back here
  // means falling back to MORE review, not less, so failing open is safe.
  it('returns defaults on null / undefined', () => {
    expect(resolveCategoryPolicy(parseApprovalPolicy(null), 'comp_complaint')).toBe(
      'operator_approval',
    )
    expect(resolveCategoryPolicy(parseApprovalPolicy(undefined), 'comp_complaint')).toBe(
      'operator_approval',
    )
  })

  it('warns and returns defaults on a malformed payload', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const policy = parseApprovalPolicy({ default: 'nonsense', perCategory: 'not-an-object' })
      expect(resolveCategoryPolicy(policy, 'comp_complaint')).toBe('operator_approval')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('returns defaults on a non-object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(resolveCategoryPolicy(parseApprovalPolicy('hello'), 'comp_complaint')).toBe(
        'operator_approval',
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('drops unknown category keys rather than rejecting the whole policy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const policy = parseApprovalPolicy({
        default: 'auto_send',
        perCategory: { not_a_real_category: 'operator_approval' },
      })
      // The valid parts survive; the code default still governs.
      expect(resolveCategoryPolicy(policy, 'comp_complaint')).toBe('operator_approval')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('resolveCategoryPolicy — explicit per-venue override', () => {
  it('lets a venue opt comp_complaint back to auto_send', () => {
    const policy = parseApprovalPolicy({
      default: 'auto_send',
      perCategory: { comp_complaint: 'auto_send' },
    })
    expect(resolveCategoryPolicy(policy, 'comp_complaint')).toBe('auto_send')
  })

  it('lets a venue route an additional category to approval', () => {
    const policy = parseApprovalPolicy({
      default: 'auto_send',
      perCategory: { mechanic_request: 'operator_approval' },
    })
    expect(resolveCategoryPolicy(policy, 'mechanic_request')).toBe('operator_approval')
    // ...without disturbing the code-level route.
    expect(resolveCategoryPolicy(policy, 'comp_complaint')).toBe('operator_approval')
  })

  it('honours a venue-wide default of operator_approval for unrouted categories', () => {
    const policy = parseApprovalPolicy({ default: 'operator_approval', perCategory: {} })
    expect(resolveCategoryPolicy(policy, 'reply')).toBe('operator_approval')
  })

  it('lets an explicit per-category entry beat a venue-wide default', () => {
    const policy = parseApprovalPolicy({
      default: 'operator_approval',
      perCategory: { reply: 'auto_send' },
    })
    expect(resolveCategoryPolicy(policy, 'reply')).toBe('auto_send')
  })

  // Runtime robustness, not test convenience: resolveCategoryPolicy runs
  // inside applyApprovalPolicyStage, so throwing on a missing policy would
  // fail the entire agent run and the guest would get nothing.
  it('degrades to code defaults when the policy itself is missing', () => {
    expect(resolveCategoryPolicy(undefined, 'comp_complaint')).toBe('operator_approval')
    expect(resolveCategoryPolicy(null, 'comp_complaint')).toBe('operator_approval')
    expect(resolveCategoryPolicy(undefined, 'reply')).toBe('auto_send')
  })

  it('treats a null category (followup path, no inbound) as unrouted', () => {
    const policy = parseApprovalPolicy(PRODUCTION_SEEDED_VALUE)
    expect(resolveCategoryPolicy(policy, undefined)).toBe('auto_send')
  })
})
