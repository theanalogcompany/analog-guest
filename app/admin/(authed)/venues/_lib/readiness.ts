import {
  APPROVAL_POLICY_DEFAULT,
  type ApprovalDisposition,
  parseApprovalPolicy,
} from '@/lib/schemas/approval-policy'
import type { BrandPersona, VenueContextNote } from '@/lib/schemas'
import { partitionCurrentContext } from './expiry-queue'
import {
  findMissingMechanicFields,
  type MechanicFieldsInput,
  parseMechanicTriggerType,
} from './mechanic-fields'

// Computed Readiness panel (TAC-343 §2). Read-only and derived — nothing
// here is a stored status, so a count is always true the moment the page
// re-renders. Pure: takes already-loaded data from the venue detail loader,
// no DB access of its own, mirroring the pure-fed-by-caller-loaded-data
// shape of filterEligibleMechanics / deriveOpenIntentions.
//
// Thresholds come from the onboarding appendix's minimum viable transcript
// (CLAUDE.md "Phase 5 onboarding pipeline"). Named constants in one place,
// per the plan's approach note — nothing scattered through the UI.
export const READINESS_THRESHOLDS = {
  MIN_VOICE_CORPUS: 8,
  MIN_KNOWLEDGE_CHUNKS: 15,
  MIN_CURRENT_CONTEXT_DATED: 2,
} as const

export interface ReadinessKnowledgeEntryInput {
  id: string
  primaryTags: string[]
  isProcessed: boolean
}

export interface ReadinessMechanicInput extends MechanicFieldsInput {
  id: string
  name: string
  isActive: boolean
  trigger: unknown
  requiresOperatorApproval: boolean
}

export interface ReadinessInput {
  now: Date
  voiceCorpusCount: number
  knowledgeEntries: readonly ReadinessKnowledgeEntryInput[]
  mechanics: readonly ReadinessMechanicInput[]
  currentContext: readonly VenueContextNote[]
  brandPersona: BrandPersona | null
  rawApprovalPolicy: unknown
}

export interface KnowledgeTagCount {
  tag: string
  count: number
}

export interface MechanicIssue {
  id: string
  name: string
  missingFields: string[]
}

export interface ManualInviteWarning {
  id: string
  name: string
}

export interface BrandPersonaFieldStatus {
  field: string
  populated: boolean
}

export interface ReadinessReport {
  voiceCorpus: { count: number; threshold: number; met: boolean }
  knowledge: {
    /** Only is_processed=true entries — unprocessed ones aren't retrievable. */
    processedCount: number
    unprocessedCount: number
    threshold: number
    met: boolean
    /** Per-tag breakdown over processed entries only, raw (un-canonicalized) tags. */
    byPrimaryTag: KnowledgeTagCount[]
  }
  mechanics: {
    /** Every check below is scoped to active mechanics — a deactivated
     *  mechanic with missing params or a manual_invite gap is not a gap. */
    activeCount: number
    inactiveCount: number
    issues: MechanicIssue[]
    manualInviteWithoutApproval: ManualInviteWarning[]
  }
  currentContext: {
    /** Entries carrying a real, parseable expiresAt (active or expired both
     *  count — a permanent entry with no date, or a malformed one, doesn't). */
    datedCount: number
    threshold: number
    met: boolean
  }
  brandPersona: { fields: BrandPersonaFieldStatus[] }
  approvalPolicy: { default: ApprovalDisposition; perCategory: Record<string, ApprovalDisposition> }
}

const BRAND_PERSONA_FIELDS: ReadonlyArray<{
  field: string
  isPopulated: (p: BrandPersona) => boolean
}> = [
  { field: 'voiceName', isPopulated: (p) => Boolean(p.voiceName) },
  { field: 'tone', isPopulated: (p) => p.tone.trim().length > 0 },
  // formality/speakerFraming/emojiPolicy are required enums — a persona that
  // parsed at all always has one. Listed anyway so the panel shows the full
  // field set, per "which fields are populated, which are empty."
  { field: 'formality', isPopulated: () => true },
  { field: 'speakerFraming', isPopulated: () => true },
  { field: 'speakerName', isPopulated: (p) => Boolean(p.speakerName) },
  { field: 'emojiPolicy', isPopulated: () => true },
  { field: 'lengthGuide', isPopulated: (p) => p.lengthGuide.trim().length > 0 },
  { field: 'signaturePhrases', isPopulated: (p) => p.signaturePhrases.length > 0 },
  { field: 'bannedTopics', isPopulated: (p) => p.bannedTopics.length > 0 },
  { field: 'voiceTouchstones', isPopulated: (p) => p.voiceTouchstones.length > 0 },
  { field: 'voiceAntiPatterns', isPopulated: (p) => p.voiceAntiPatterns.length > 0 },
]

function computeBrandPersonaFields(persona: BrandPersona | null): BrandPersonaFieldStatus[] {
  return BRAND_PERSONA_FIELDS.map(({ field, isPopulated }) => ({
    field,
    populated: persona !== null && isPopulated(persona),
  }))
}

export function computeReadiness(input: ReadinessInput): ReadinessReport {
  const processed = input.knowledgeEntries.filter((e) => e.isProcessed)
  const unprocessed = input.knowledgeEntries.filter((e) => !e.isProcessed)

  const tagCounts = new Map<string, number>()
  for (const entry of processed) {
    for (const tag of entry.primaryTags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
  }
  const byPrimaryTag = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag))

  const activeMechanics = input.mechanics.filter((m) => m.isActive)
  const issues: MechanicIssue[] = []
  const manualInviteWithoutApproval: ManualInviteWarning[] = []
  for (const m of activeMechanics) {
    const missing = findMissingMechanicFields(m)
    if (missing.length > 0) issues.push({ id: m.id, name: m.name, missingFields: missing })
    const triggerType = parseMechanicTriggerType(m.trigger)
    if (triggerType === 'manual_invite' && m.requiresOperatorApproval !== true) {
      manualInviteWithoutApproval.push({ id: m.id, name: m.name })
    }
  }

  const { active, expired } = partitionCurrentContext(input.currentContext, input.now)
  const datedCount = [...active, ...expired].filter((e) => e.expiresAt !== undefined).length

  // Same merge resolveCategoryPolicy applies at runtime, so what's displayed
  // is the effective policy, not just the raw stored jsonb.
  const policy = parseApprovalPolicy(input.rawApprovalPolicy)
  const mergedPerCategory: Record<string, ApprovalDisposition> = {
    ...APPROVAL_POLICY_DEFAULT.perCategory,
    ...policy.perCategory,
  }

  return {
    voiceCorpus: {
      count: input.voiceCorpusCount,
      threshold: READINESS_THRESHOLDS.MIN_VOICE_CORPUS,
      met: input.voiceCorpusCount >= READINESS_THRESHOLDS.MIN_VOICE_CORPUS,
    },
    knowledge: {
      processedCount: processed.length,
      unprocessedCount: unprocessed.length,
      threshold: READINESS_THRESHOLDS.MIN_KNOWLEDGE_CHUNKS,
      met: processed.length >= READINESS_THRESHOLDS.MIN_KNOWLEDGE_CHUNKS,
      byPrimaryTag,
    },
    mechanics: {
      activeCount: activeMechanics.length,
      inactiveCount: input.mechanics.length - activeMechanics.length,
      issues,
      manualInviteWithoutApproval,
    },
    currentContext: {
      datedCount,
      threshold: READINESS_THRESHOLDS.MIN_CURRENT_CONTEXT_DATED,
      met: datedCount >= READINESS_THRESHOLDS.MIN_CURRENT_CONTEXT_DATED,
    },
    brandPersona: { fields: computeBrandPersonaFields(input.brandPersona) },
    approvalPolicy: { default: policy.default, perCategory: mergedPerCategory },
  }
}
