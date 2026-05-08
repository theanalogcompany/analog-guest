import { describe, expect, it } from 'vitest'
import {
  buildVerificationPrompt,
  ClusterVerificationOutputSchema,
  hasEnoughCandidates,
  projectCluster,
  type SimilarCritiqueMatch,
} from './find-pattern-cluster-pure'

const ID_NEW = '00000000-0000-4000-8000-000000000000'
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'
const MSG_NEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function match(id: string, text: string, similarity = 0.9): SimilarCritiqueMatch {
  return { id, messageId: id, critiqueText: text, similarity }
}

describe('hasEnoughCandidates', () => {
  it('returns false on 0 or 1 prior matches', () => {
    expect(hasEnoughCandidates([])).toBe(false)
    expect(hasEnoughCandidates([match(ID_A, 'x')])).toBe(false)
  })

  it('returns true on 2+ prior matches (third-member gate)', () => {
    expect(hasEnoughCandidates([match(ID_A, 'x'), match(ID_B, 'y')])).toBe(true)
    expect(
      hasEnoughCandidates([match(ID_A, 'x'), match(ID_B, 'y'), match(ID_C, 'z')]),
    ).toBe(true)
  })
})

describe('buildVerificationPrompt', () => {
  it('numbers each candidate critique', () => {
    const out = buildVerificationPrompt({
      newCritique: 'too eager',
      candidates: [
        { id: ID_A, text: 'sounds like marketing copy' },
        { id: ID_B, text: 'drop the exclamation' },
      ],
    })
    expect(out).toContain('1. sounds like marketing copy')
    expect(out).toContain('2. drop the exclamation')
  })

  it('includes the new critique under its own heading', () => {
    const out = buildVerificationPrompt({
      newCritique: 'NEW_CRITIQUE_TEXT',
      candidates: [{ id: ID_A, text: 'old' }],
    })
    expect(out).toContain('## Just-committed critique')
    expect(out).toContain('NEW_CRITIQUE_TEXT')
  })

  it('reports the candidate count', () => {
    const out = buildVerificationPrompt({
      newCritique: 'x',
      candidates: [
        { id: ID_A, text: 'a' },
        { id: ID_B, text: 'b' },
      ],
    })
    expect(out).toContain('2 candidates')
  })
})

describe('ClusterVerificationOutputSchema', () => {
  it('accepts a yes verdict with proposed_rule_text', () => {
    const r = ClusterVerificationOutputSchema.safeParse({
      same_problem: true,
      reasoning: 'all about marketing tone',
      proposed_rule_text: 'no marketing flourishes',
    })
    expect(r.success).toBe(true)
  })

  it('accepts a no verdict without proposed_rule_text', () => {
    const r = ClusterVerificationOutputSchema.safeParse({
      same_problem: false,
      reasoning: 'mixed signals',
    })
    expect(r.success).toBe(true)
  })
})

describe('projectCluster', () => {
  const newCritique = {
    id: ID_NEW,
    text: 'too eager',
    messageId: MSG_NEW,
  }
  const matches: SimilarCritiqueMatch[] = [
    match(ID_A, 'sounds like marketing'),
    match(ID_B, 'drop the exclamation'),
  ]

  it('returns null when same_problem is false', () => {
    expect(
      projectCluster({
        verification: { same_problem: false, reasoning: 'no' },
        newCritique,
        matches,
      }),
    ).toBeNull()
  })

  it('returns null when proposed_rule_text is missing', () => {
    expect(
      projectCluster({
        verification: { same_problem: true, reasoning: 'yes' },
        newCritique,
        matches,
      }),
    ).toBeNull()
  })

  it('returns null when proposed_rule_text is whitespace-only', () => {
    expect(
      projectCluster({
        verification: {
          same_problem: true,
          reasoning: 'yes',
          proposed_rule_text: '   ',
        },
        newCritique,
        matches,
      }),
    ).toBeNull()
  })

  it('builds a payload with the new critique first then prior matches', () => {
    const cluster = projectCluster({
      verification: {
        same_problem: true,
        reasoning: 'all marketing tone',
        proposed_rule_text: 'no marketing flourishes',
      },
      newCritique,
      matches,
    })
    expect(cluster).not.toBeNull()
    if (!cluster) return
    expect(cluster.proposedRuleText).toBe('no marketing flourishes')
    expect(cluster.critiqueIds).toEqual([ID_NEW, ID_A, ID_B])
    expect(cluster.members[0].id).toBe(ID_NEW)
    expect(cluster.members[1].text).toBe('sounds like marketing')
  })

  it('trims proposedRuleText', () => {
    const cluster = projectCluster({
      verification: {
        same_problem: true,
        reasoning: 'yes',
        proposed_rule_text: '  no marketing flourishes  ',
      },
      newCritique,
      matches,
    })
    expect(cluster?.proposedRuleText).toBe('no marketing flourishes')
  })
})
