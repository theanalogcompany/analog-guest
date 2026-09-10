import { describe, expect, it } from 'vitest'
import type { BrandPersona, VenueContextNote } from '@/lib/schemas'
import { computeReadiness, READINESS_THRESHOLDS, type ReadinessInput } from './readiness'

const NOW = new Date('2026-04-29T12:00:00Z')

const fullPersona: BrandPersona = {
  voiceName: 'Sana',
  tone: 'warm, direct',
  formality: 'warm',
  speakerFraming: 'venue',
  signaturePhrases: ['see you soon'],
  bannedTopics: ['discounts'],
  emojiPolicy: 'sparingly',
  lengthGuide: 'one or two sentences',
  voiceAntiPatterns: [{ text: 'never say "as an AI"', source: 'manual' }],
  voiceTouchstones: ['warm neighborhood cafe'],
}

const dated = (id: string, expiresAt: string): VenueContextNote => ({
  id,
  content: 'x',
  source: 'text',
  addedAt: new Date('2026-01-01T00:00:00Z'),
  expiresAt,
})

const fullMechanic = (overrides: Partial<Parameters<typeof computeReadiness>[0]['mechanics'][number]> = {}) => ({
  id: 'm1',
  name: 'The Joey',
  isActive: true,
  trigger: { type: 'guest_initiated_request' },
  requiresOperatorApproval: false,
  description: 'A free drink',
  qualification: 'Any raving_fan',
  rewardDescription: 'One free drink',
  redemptionPolicy: 'one_time',
  redemptionWindowDays: null,
  ...overrides,
})

function baseInput(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    now: NOW,
    voiceCorpusCount: READINESS_THRESHOLDS.MIN_VOICE_CORPUS,
    knowledgeEntries: Array.from({ length: READINESS_THRESHOLDS.MIN_KNOWLEDGE_CHUNKS }, (_, i) => ({
      id: `k${i}`,
      primaryTags: ['history'],
      isProcessed: true,
    })),
    mechanics: [fullMechanic()],
    currentContext: [
      dated('c1', '2026-05-01T00:00:00Z'),
      dated('c2', '2026-05-02T00:00:00Z'),
    ],
    brandPersona: fullPersona,
    rawApprovalPolicy: null,
    ...overrides,
  }
}

describe('computeReadiness', () => {
  it('meets every threshold for a fully-ready venue', () => {
    const report = computeReadiness(baseInput())
    expect(report.voiceCorpus.met).toBe(true)
    expect(report.knowledge.met).toBe(true)
    expect(report.currentContext.met).toBe(true)
    expect(report.mechanics.issues).toEqual([])
    expect(report.mechanics.manualInviteWithoutApproval).toEqual([])
  })

  it('fails the voice corpus threshold when count is below 8', () => {
    const report = computeReadiness(baseInput({ voiceCorpusCount: 3 }))
    expect(report.voiceCorpus.met).toBe(false)
    expect(report.voiceCorpus.count).toBe(3)
  })

  it('fails the knowledge threshold when processed count is below 15', () => {
    const report = computeReadiness(
      baseInput({
        knowledgeEntries: [{ id: 'k1', primaryTags: ['history'], isProcessed: true }],
      }),
    )
    expect(report.knowledge.met).toBe(false)
    expect(report.knowledge.processedCount).toBe(1)
  })

  it('excludes unprocessed entries from the count-vs-threshold and reports them separately', () => {
    const entries = [
      ...Array.from({ length: 14 }, (_, i) => ({
        id: `p${i}`,
        primaryTags: ['history'],
        isProcessed: true,
      })),
      { id: 'unprocessed1', primaryTags: ['history'], isProcessed: false },
      { id: 'unprocessed2', primaryTags: ['history'], isProcessed: false },
    ]
    const report = computeReadiness(baseInput({ knowledgeEntries: entries }))
    expect(report.knowledge.processedCount).toBe(14)
    expect(report.knowledge.met).toBe(false) // 14 < 15, unprocessed don't help
    expect(report.knowledge.unprocessedCount).toBe(2)
  })

  it('computes the per-tag breakdown over processed entries only', () => {
    const entries = [
      { id: 'a', primaryTags: ['history'], isProcessed: true },
      { id: 'b', primaryTags: ['history'], isProcessed: true },
      { id: 'c', primaryTags: ['sourcing'], isProcessed: true },
      { id: 'd', primaryTags: ['sourcing'], isProcessed: false },
    ]
    const report = computeReadiness(baseInput({ knowledgeEntries: entries }))
    expect(report.knowledge.byPrimaryTag).toEqual([
      { tag: 'history', count: 2 },
      { tag: 'sourcing', count: 1 },
    ])
  })

  it('fails the currentContext threshold when fewer than 2 entries carry a valid date', () => {
    const report = computeReadiness(baseInput({ currentContext: [dated('c1', '2026-05-01T00:00:00Z')] }))
    expect(report.currentContext.met).toBe(false)
    expect(report.currentContext.datedCount).toBe(1)
  })

  it('does not count a permanent (no expiresAt) entry toward the dated threshold', () => {
    const permanent: VenueContextNote = {
      id: 'permanent',
      content: 'x',
      source: 'text',
      addedAt: new Date('2026-01-01T00:00:00Z'),
    }
    const report = computeReadiness(
      baseInput({ currentContext: [dated('c1', '2026-05-01T00:00:00Z'), permanent] }),
    )
    expect(report.currentContext.datedCount).toBe(1)
  })

  it('flags a mechanic with missing fields', () => {
    const report = computeReadiness(
      baseInput({ mechanics: [fullMechanic({ description: null, qualification: null })] }),
    )
    expect(report.mechanics.issues).toEqual([
      { id: 'm1', name: 'The Joey', missingFields: ['description', 'qualification'] },
    ])
  })

  it('excludes a deactivated mechanic from missing-field issues', () => {
    const report = computeReadiness(
      baseInput({
        mechanics: [fullMechanic({ isActive: false, description: null, qualification: null })],
      }),
    )
    expect(report.mechanics.issues).toEqual([])
    expect(report.mechanics.activeCount).toBe(0)
    expect(report.mechanics.inactiveCount).toBe(1)
  })

  it('flags a manual_invite mechanic without requires_operator_approval', () => {
    const report = computeReadiness(
      baseInput({
        mechanics: [
          fullMechanic({ trigger: { type: 'manual_invite' }, requiresOperatorApproval: false }),
        ],
      }),
    )
    expect(report.mechanics.manualInviteWithoutApproval).toEqual([{ id: 'm1', name: 'The Joey' }])
  })

  it('does not flag a manual_invite mechanic that does require approval', () => {
    const report = computeReadiness(
      baseInput({
        mechanics: [
          fullMechanic({ trigger: { type: 'manual_invite' }, requiresOperatorApproval: true }),
        ],
      }),
    )
    expect(report.mechanics.manualInviteWithoutApproval).toEqual([])
  })

  it('excludes a deactivated manual_invite-without-approval mechanic from the warning', () => {
    const report = computeReadiness(
      baseInput({
        mechanics: [
          fullMechanic({
            isActive: false,
            trigger: { type: 'manual_invite' },
            requiresOperatorApproval: false,
          }),
        ],
      }),
    )
    expect(report.mechanics.manualInviteWithoutApproval).toEqual([])
  })

  it('marks every brand_persona field unpopulated when persona is null', () => {
    const report = computeReadiness(baseInput({ brandPersona: null }))
    expect(report.brandPersona.fields.every((f) => f.populated === false)).toBe(true)
  })

  it('marks required-enum fields populated on any successfully-parsed persona', () => {
    const report = computeReadiness(baseInput({ brandPersona: fullPersona }))
    const byField = Object.fromEntries(report.brandPersona.fields.map((f) => [f.field, f.populated]))
    expect(byField.formality).toBe(true)
    expect(byField.speakerFraming).toBe(true)
    expect(byField.emojiPolicy).toBe(true)
  })

  it('flags an empty array field as unpopulated', () => {
    const report = computeReadiness(
      baseInput({ brandPersona: { ...fullPersona, signaturePhrases: [] } }),
    )
    const byField = Object.fromEntries(report.brandPersona.fields.map((f) => [f.field, f.populated]))
    expect(byField.signaturePhrases).toBe(false)
  })

  it('falls back to the code default approval policy when the stored value is null', () => {
    const report = computeReadiness(baseInput({ rawApprovalPolicy: null }))
    expect(report.approvalPolicy.default).toBe('auto_send')
    expect(report.approvalPolicy.perCategory.comp_complaint).toBe('operator_approval')
  })

  it('layers a stored perCategory override on top of the code default, not replacing it', () => {
    const report = computeReadiness(
      baseInput({
        rawApprovalPolicy: { default: 'auto_send', perCategory: { mechanic_request: 'operator_approval' } },
      }),
    )
    expect(report.approvalPolicy.perCategory.comp_complaint).toBe('operator_approval')
    expect(report.approvalPolicy.perCategory.mechanic_request).toBe('operator_approval')
  })
})
