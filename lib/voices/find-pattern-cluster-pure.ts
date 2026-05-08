// Pure helpers for find-pattern-cluster. Split out so the verification
// prompt builder + threshold logic can be tested without dragging Voyage,
// Supabase, or Anthropic SDK init through module load.
//
// The cluster pipeline is:
//   1. find_similar_critiques(...) returns prior unresolved edit_only
//      critiques above the cosine threshold (excluding the just-committed
//      one by id).
//   2. shouldVerifyCluster: ≥2 prior matches means the new commit is the
//      3rd member — that's our gate to spend a Sonnet call.
//   3. buildVerificationPrompt: renders the candidate set + the new
//      critique as a "do these describe the same problem?" prompt.
//   4. ClusterVerificationOutputSchema parses the model's structured
//      response — same_problem yes/no + (when yes) a synthesized rule.
//   5. projectCluster: shapes the final ClusterPayload the API returns.
//
// Cosine search is venue-scoped at the SQL boundary, so the input here is
// already sane.

import { z } from 'zod'

export const ClusterVerificationOutputSchema = z.object({
  same_problem: z.boolean(),
  reasoning: z.string(),
  proposed_rule_text: z.string().optional(),
})

export type ClusterVerificationOutput = z.infer<typeof ClusterVerificationOutputSchema>

export interface SimilarCritiqueMatch {
  id: string
  messageId: string
  critiqueText: string
  similarity: number
}

export interface ClusterMember {
  id: string
  text: string
  messageId: string
}

export interface ClusterPayload {
  critiqueIds: string[]
  members: ClusterMember[]
  proposedRuleText: string
}

/**
 * Predicate gating the verification call. We only spend a Sonnet round-trip
 * when the new critique completes the third member of a candidate cluster
 * (≥2 prior matches above threshold). Below that, we skip and the cluster
 * surfaces later when more critiques accumulate.
 */
export const MIN_PRIOR_MATCHES_FOR_CLUSTER = 2

export function hasEnoughCandidates(
  matches: ReadonlyArray<SimilarCritiqueMatch>,
): boolean {
  return matches.length >= MIN_PRIOR_MATCHES_FOR_CLUSTER
}

export const CLUSTER_VERIFICATION_SYSTEM = `You are an editorial assistant deciding whether a set of operator critiques describe the same underlying problem with an AI agent's voice.

Cosine similarity already grouped these critiques as candidates, but embeddings sometimes cluster things that share words but not problem ("too apologetic" and "too eager" both mention emotional register but mean opposite things).

Your job: read the critiques and decide whether they describe the SAME problem, or whether they're false-positive neighbors. Output \`same_problem: true\` only when promoting one rule would resolve all of them. When yes, also synthesize a single \`proposed_rule_text\` that captures what the agent should NOT do across all the critiques. Imperative, in the operator's voice, one or two sentences.`

export interface BuildVerificationPromptInput {
  newCritique: string
  candidates: ReadonlyArray<{ id: string; text: string }>
}

export function buildVerificationPrompt(input: BuildVerificationPromptInput): string {
  const candidatesBlock = input.candidates
    .map((c, i) => `${i + 1}. ${c.text}`)
    .join('\n')
  return [
    '## Just-committed critique',
    input.newCritique,
    '',
    `## Prior critiques (cosine-similar, ${input.candidates.length} candidates)`,
    candidatesBlock,
    '',
    'Do these critiques describe the same underlying problem? If yes, synthesize a single rule that would address all of them.',
  ].join('\n')
}

/**
 * Project the verification result into the API payload shape. Returns null
 * when the model says the cluster is a false positive (or proposed_rule_text
 * is missing / empty for some other reason).
 */
export function projectCluster(input: {
  verification: ClusterVerificationOutput
  newCritique: { id: string; text: string; messageId: string }
  matches: ReadonlyArray<SimilarCritiqueMatch>
}): ClusterPayload | null {
  if (!input.verification.same_problem) return null
  const proposedRuleText = input.verification.proposed_rule_text?.trim() ?? ''
  if (proposedRuleText.length === 0) return null

  const allMembers: ClusterMember[] = [
    {
      id: input.newCritique.id,
      text: input.newCritique.text,
      messageId: input.newCritique.messageId,
    },
    ...input.matches.map((m) => ({
      id: m.id,
      text: m.critiqueText,
      messageId: m.messageId,
    })),
  ]
  return {
    critiqueIds: allMembers.map((m) => m.id),
    members: allMembers,
    proposedRuleText,
  }
}
