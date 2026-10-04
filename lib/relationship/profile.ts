import { z } from 'zod'
import type { GraphMove, RelationshipGraph } from './schema'

// Guest profile and interaction memory: the two JSONB columns of
// guest_profiles (migration 067), read only through these schemas. Both are
// maintained by the post-turn assessor; both render into the situation brief
// (tier 3). This is the v2 replacement for guests.context AND for the whole
// prompted-once/brake/re-arm apparatus: the model sees what was asked and
// what came of it, and judges for itself (decision 0009).
//
// Live-boundary parses fail OPEN to the empty shape - a malformed row must
// not take down a venue's runs. The degrade is a console.warn only for now;
// the structured degrade event lands with the phase 6 persistence wiring,
// when these rows gain a production writer.

export const GuestProfileSchema = z.object({
  /** Typed-ish fields: first_name, home_base, usual_order, history_here, usual_time_of_day, reason_for_visiting, ... */
  fields: z.record(z.string(), z.string()).default({}),
  /** Everything that does not fit a field yet. A fact used often graduates to a field. */
  facts: z
    .array(
      z.object({
        fact: z.string(),
        learnedAt: z.string(),
        source: z.enum(['assessor', 'operator', 'onboarding']),
      }),
    )
    .default([]),
})
export type GuestProfile = z.infer<typeof GuestProfileSchema>

export const InteractionMemorySchema = z.object({
  entries: z
    .array(
      z.object({
        kind: z.enum(['question_asked', 'suggestion_made', 'exchange_note']),
        /** "Asked their name", "Suggested the canelé" - short, factual. */
        note: z.string(),
        at: z.string(),
        /** "answered: Maya", "no reply", "they loved it" - filled in by later turns. */
        outcome: z.string().optional(),
        /**
         * The graph move this entry pursued, when it pursued one - the
         * assessor tags it. Lets the open-moves render show each aim's own
         * attempt history ("raised 2026-10-04 - they deflected").
         */
        moveKey: z.string().optional(),
      }),
    )
    .default([]),
})
export type InteractionMemory = z.infer<typeof InteractionMemorySchema>

export const EMPTY_PROFILE: GuestProfile = { fields: {}, facts: [] }
export const EMPTY_MEMORY: InteractionMemory = { entries: [] }

export function parseGuestProfile(value: unknown): GuestProfile {
  const parsed = GuestProfileSchema.safeParse(value ?? {})
  if (parsed.success) return parsed.data
  console.warn(`[guest-profile] malformed profile JSONB, using empty`)
  return EMPTY_PROFILE
}

export function parseInteractionMemory(value: unknown): InteractionMemory {
  const parsed = InteractionMemorySchema.safeParse(value ?? {})
  if (parsed.success) return parsed.data
  console.warn(`[guest-profile] malformed memory JSONB, using empty`)
  return EMPTY_MEMORY
}

/** Renders for the situation brief. Empty string when nothing is known; compose supplies the fallback line. */
export function renderGuestProfile(profile: GuestProfile): string {
  const lines: string[] = []
  for (const [field, value] of Object.entries(profile.fields)) {
    if (value.trim().length > 0)
      lines.push(`${field.replace(/_/g, ' ')}: ${value}`)
  }
  for (const f of profile.facts.slice(0, 20)) lines.push(f.fact)
  return lines.join('\n')
}

export function renderInteractionMemory(memory: InteractionMemory): string {
  // Newest last, capped: old closed loops age out of the brief naturally.
  return memory.entries
    .slice(-15)
    .map((e) => {
      const when = e.at.slice(0, 10)
      const outcome = e.outcome ? ` - ${e.outcome}` : ' - no response yet'
      return `${when}: ${e.note}${outcome}`
    })
    .join('\n')
}

/**
 * The open moves at the guest's current state: every move homed at this
 * state OR an earlier one, minus any whose closedWhen field is already on
 * the profile. States are cumulative stages, not silos - measured by
 * first-contact-replay (2026-10-04): a guest promoted to discovery before
 * giving their name lost the learn_name aim from both the brief and the
 * assessor's tag vocabulary, so the agent never asked and the record never
 * linked. A move with an empty closedWhen rides every later state by
 * design (find_their_thing is evergreen). This remains the ONLY
 * suppression in v2 - everything else is the model reading the memory.
 */
export function openMoves(
  graph: RelationshipGraph,
  stateKey: string,
  profile: GuestProfile,
): GraphMove[] {
  const currentRank = graph.states.find((s) => s.key === stateKey)?.rank
  if (currentRank === undefined) return []
  const rankOf = new Map(graph.states.map((s) => [s.key, s.rank]))
  return graph.moves.filter((m) => {
    const homeRank = rankOf.get(m.homeState)
    if (homeRank === undefined || homeRank > currentRank) return false
    return !m.closedWhen.some((c) => {
      const value = profile.fields[c.profileField]
      return value !== undefined && value.trim().length > 0
    })
  })
}

/**
 * Open moves render as parallel aims, each annotated with its own attempt
 * history from move-linked memory entries - so "already raised and went
 * nowhere" is visible on the aim itself, not just findable in the memory
 * section.
 */
export function renderOpenMoves(
  moves: readonly GraphMove[],
  memory: InteractionMemory,
): string {
  return moves
    .map((m) => {
      const attempts = memory.entries.filter((e) => e.moveKey === m.key)
      const last = attempts[attempts.length - 1]
      if (last === undefined) return `- ${m.goal}`
      const when = last.at.slice(0, 10)
      const outcome = last.outcome ?? 'no answer yet'
      return `- ${m.goal} (raised ${when} - ${outcome})`
    })
    .join('\n')
}
