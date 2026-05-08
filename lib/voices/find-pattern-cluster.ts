// DB-touching wrapper around the pure cluster pipeline. Two callsites:
//
//   - commit endpoint (post-persistCritique). The new critique's embedding
//     is in hand, so we pass it directly. find_similar_critiques excludes
//     the just-committed row by id; verification fires when ≥2 prior
//     matches surface (third-member gate).
//
//   - GET /admin/voices/api/patterns/[venueId]. Re-derives clusters across
//     all unresolved edit_only critiques. For each row, pulls cosine-
//     neighbors and runs verification per candidate cluster. De-duplicates
//     so the same cluster isn't returned multiple times.
//
// Verification cost: one Sonnet call per candidate cluster. At venue scale
// this is sub-dollar per session even at high commit cadence; if it
// becomes annoying, persist a (cluster_signature, proposed_rule_text,
// last_verified_at) triple on critiques and cache. Documented as a
// follow-up TODO in CLAUDE.md.

import { generateObject } from 'ai'
import { getGenerationModel } from '@/lib/ai/client'
import { createAdminClient } from '@/lib/db/admin'
import {
  buildVerificationPrompt,
  type ClusterPayload,
  ClusterVerificationOutputSchema,
  CLUSTER_VERIFICATION_SYSTEM,
  hasEnoughCandidates,
  projectCluster,
  type SimilarCritiqueMatch,
} from './find-pattern-cluster-pure'

export type { ClusterPayload, SimilarCritiqueMatch } from './find-pattern-cluster-pure'

interface CritiqueLite {
  id: string
  text: string
  messageId: string
}

const SIMILARITY_THRESHOLD = 0.85
const MATCH_LIMIT = 20

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

async function fetchSimilar(
  venueId: string,
  embedding: number[],
  excludeId: string | null,
): Promise<SimilarCritiqueMatch[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('find_similar_critiques', {
    query_venue_id: venueId,
    query_embedding: toVectorLiteral(embedding),
    similarity_threshold: SIMILARITY_THRESHOLD,
    match_count: MATCH_LIMIT,
    ...(excludeId ? { exclude_id: excludeId } : {}),
  })
  if (error) {
    console.warn(
      `[find-pattern-cluster] find_similar_critiques failed for venue=${venueId}: ${error.message}`,
    )
    return []
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    messageId: r.message_id,
    critiqueText: r.critique_text,
    similarity: r.similarity,
  }))
}

async function runVerification(input: {
  newCritique: CritiqueLite
  matches: SimilarCritiqueMatch[]
}): Promise<ClusterPayload | null> {
  try {
    const { object } = await generateObject({
      model: getGenerationModel(),
      system: CLUSTER_VERIFICATION_SYSTEM,
      prompt: buildVerificationPrompt({
        newCritique: input.newCritique.text,
        candidates: input.matches.map((m) => ({ id: m.id, text: m.critiqueText })),
      }),
      schema: ClusterVerificationOutputSchema,
      temperature: 0.3,
      maxOutputTokens: 400,
    })
    return projectCluster({
      verification: object,
      newCritique: input.newCritique,
      matches: input.matches,
    })
  } catch (e) {
    console.warn(
      `[find-pattern-cluster] verification call failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
}

/**
 * Commit-time path. Runs cosine search + verification for the
 * just-committed critique. Returns null when there aren't enough prior
 * matches to form a cluster, when the cosine search degrades, or when
 * verification rejects the cluster.
 */
export async function findPatternClusterForCritique(input: {
  venueId: string
  critiqueId: string
  critiqueText: string
  messageId: string
  embedding: number[]
}): Promise<ClusterPayload | null> {
  const matches = await fetchSimilar(input.venueId, input.embedding, input.critiqueId)
  if (!hasEnoughCandidates(matches)) return null
  return runVerification({
    newCritique: {
      id: input.critiqueId,
      text: input.critiqueText,
      messageId: input.messageId,
    },
    matches,
  })
}

interface UnresolvedCritiqueRow {
  id: string
  message_id: string
  critique_text: string
  embedding: string
}

/**
 * Parse the pgvector text representation '[0.1,0.2,...]' into a number
 * array. The embedding column is stored as `vector(1024)`; supabase-js
 * surfaces it as a string. Defensive — returns null on parse failure.
 */
function parseVectorLiteral(literal: string): number[] | null {
  if (!literal.startsWith('[') || !literal.endsWith(']')) return null
  const inner = literal.slice(1, -1)
  if (inner.length === 0) return null
  const parts = inner.split(',')
  const out: number[] = []
  for (const p of parts) {
    const n = Number(p)
    if (Number.isNaN(n)) return null
    out.push(n)
  }
  return out
}

/**
 * Rail-load path. Re-derives all confirmed clusters in this venue's
 * unresolved edit_only critique pool. For each row we run cosine search
 * to find its neighbors; if ≥2 we fire verification. Clusters are
 * de-duplicated by signature (sorted member-id JSON).
 *
 * Cost scales with cluster count, not critique count — most rows in a
 * mature pool sit alone (no neighbors above threshold) and skip
 * verification entirely.
 */
export async function findActiveClusters(
  venueId: string,
): Promise<ClusterPayload[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('voice_critiques')
    .select('id, message_id, critique_text, embedding')
    .eq('venue_id', venueId)
    .eq('kind', 'edit_only')
    .is('promoted_at', null)
    .is('dismissed_at', null)
  if (error) {
    console.warn(
      `[find-pattern-cluster] unresolved critiques load failed for venue=${venueId}: ${error.message}`,
    )
    return []
  }

  const rows = (data ?? []) as UnresolvedCritiqueRow[]
  const clusters: ClusterPayload[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const embedding = parseVectorLiteral(row.embedding)
    if (!embedding) {
      console.warn(
        `[find-pattern-cluster] could not parse stored embedding for critique=${row.id}`,
      )
      continue
    }
    const matches = await fetchSimilar(venueId, embedding, row.id)
    if (!hasEnoughCandidates(matches)) continue

    const signature = [row.id, ...matches.map((m) => m.id)].sort().join(',')
    if (seen.has(signature)) continue
    seen.add(signature)

    const cluster = await runVerification({
      newCritique: {
        id: row.id,
        text: row.critique_text,
        messageId: row.message_id,
      },
      matches,
    })
    if (cluster) clusters.push(cluster)
  }

  return clusters
}
