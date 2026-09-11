/**
 * TAC-347 Stage 2. Pure half of preflight.ts, split out per the
 * module-split-for-testability convention (CLAUDE.md) — preflight.ts
 * imports @/lib/agent/stages for findPendingDraft, which transitively
 * imports @/lib/rag and trips vitest's ESM directory-import resolver on
 * `voyageai` (same failure class as lib/tunables/manifest.ts). No @/*
 * imports here, so tests load this file directly.
 */

export interface GuardrailCounts {
  messages: number
  guestCommitments: number
  guestStates: number
  engagementEvents: number
}

/** Pure: which of the four counts changed, and by how much. Empty = clean run. */
export function diffGuardrailState(before: GuardrailCounts, after: GuardrailCounts): string[] {
  const deltas: string[] = []
  for (const key of (['messages', 'guestCommitments', 'guestStates', 'engagementEvents'] as const)) {
    if (before[key] !== after[key]) {
      deltas.push(`${key}: ${before[key]} -> ${after[key]} (delta ${after[key] - before[key]})`)
    }
  }
  return deltas
}
