import type { Scenario, ScenarioSheetRow } from './scenario-schema'

/**
 * TAC-347 Stage 1 (redesign). Delete-and-replace merge, per plan review:
 * content-derived ids aren't stable for model-written text, so an
 * id-keyed upsert-in-place merge (the original proposal) would duplicate
 * rows on every regeneration. Instead: a `generated` row whose visible
 * content still hashes to its own stored `generated_hash` is untouched
 * since it was written, so it's safe to wipe and replace outright. A row
 * whose hash no longer matches was touched by the owner in SOME way
 * (message, key facts, exclude, notes — anything computeRowHash covers)
 * and is preserved verbatim, never overwritten. `origin: 'owner'` rows are
 * always preserved regardless of hash. True deletions (a row absent from
 * the current sheet entirely) are handled separately via tombstones, not
 * by this function — see filterTombstoneDuplicates below.
 */

const HASH_FIELDS = [
  'topic',
  'category',
  'mode',
  'guest_state',
  'scenario',
  'inbound_message',
  'expected_failure',
  'scenario_source',
  'expected_facts',
  'forbidden_claims',
  'source_row_ids',
  'expected_route',
  'exclude',
  'notes',
] as const

type HashableRow = Pick<ScenarioSheetRow, (typeof HASH_FIELDS)[number]>

/**
 * Deterministic (non-cryptographic) hash of a row's visible content —
 * everything an owner could plausibly change, explicitly excluding
 * identity (`sample_id`) and provenance (`origin`, `generated_hash` itself).
 * Same field set is hashed at stamp time and at compare time, so "hash
 * still matches" means "nothing in this set has changed since we wrote it."
 */
export function computeRowHash(row: HashableRow): string {
  const payload = JSON.stringify(HASH_FIELDS.map((f) => row[f]))
  let hash = 0
  for (let i = 0; i < payload.length; i++) {
    hash = (Math.imul(31, hash) + payload.charCodeAt(i)) | 0
  }
  // Second pass with a different seed/mix to widen the effective hash space
  // beyond a single 32-bit djb2-style pass — cheap insurance against
  // collisions on a sheet with hundreds of rows sharing similar content.
  let hash2 = 5381
  for (let i = 0; i < payload.length; i++) {
    hash2 = (Math.imul(hash2, 33) ^ payload.charCodeAt(i)) | 0
  }
  return `${(hash >>> 0).toString(36)}-${(hash2 >>> 0).toString(36)}-${payload.length}`
}

/** Stamp fresh generator output into persistable sheet rows. */
export function stampFreshRows(scenarios: readonly Scenario[]): ScenarioSheetRow[] {
  return scenarios.map((s) => {
    const base: HashableRow & Scenario = { ...s, exclude: false, notes: '' }
    return {
      ...base,
      origin: 'generated' as const,
      generated_hash: computeRowHash(base),
    }
  })
}

export interface MergeStats {
  keptOwner: number
  keptEdited: number
  replaced: number
  inserted: number
  // TAC-347 Stage 3: sample_ids that had a same-id collision resolved by
  // dedupeRowsBySampleId — a non-empty list means the "false kept as
  // edited" bug (below) fired on this merge and was caught, not that it
  // didn't happen.
  dedupedSampleIds: string[]
}

export interface MergeResult {
  finalRows: ScenarioSheetRow[]
  stats: MergeStats
}

/**
 * TAC-347 Stage 3 bugfix ("the false 'kept as edited' rows"). Investigated
 * against the live le-mils-coffee sheet: 5 venue_topic rows (all in the
 * `menu_food` topic, which was regenerated between two Stage 1 builds in the
 * same session) had a `generated_hash` that didn't match their own current
 * content, despite no owner ever having touched them — ruled out array-
 * element whitespace and embedded semicolons (0 hits scanning the whole
 * sheet) and Sheets API auto-formatting on read (byte-identical
 * FORMATTED_VALUE vs UNFORMATTED_VALUE comparison). The exact per-row
 * mechanism wasn't pinned down with certainty, but the STRUCTURAL fact is
 * clear regardless of mechanism: `mergeScenarioRows`'s contract — at most
 * one row per `sample_id` — was violated for `venue_topic:menu_food:17` and
 * `:21` (two physical rows each, both `origin: 'generated'`, neither an
 * owner edit). Positional ids (`${topic}:${i+1}` from an LLM-array index)
 * are not stable across regenerations the way content hashes are, so this
 * class of collision can recur any time a topic is regenerated.
 *
 * Fix: enforce the invariant structurally rather than trust it. Applied to
 * the FINAL merged list (kept ++ fresh), which is deliberate — fresh rows
 * are appended last, so "last occurrence wins" for `generated` rows means a
 * brand-new generation always displaces a stale, unexplainably-mismatched
 * "kept" row sharing its id. An `origin: 'owner'` row is NEVER dropped by
 * this pass, in either direction — owner edits are the one thing this whole
 * merge design exists to protect, and that invariant doesn't bend for a
 * collision-cleanup pass.
 */
export function dedupeRowsBySampleId(
  rows: readonly ScenarioSheetRow[],
): { rows: ScenarioSheetRow[]; droppedSampleIds: string[] } {
  const byId = new Map<string, ScenarioSheetRow[]>()
  for (const row of rows) {
    const list = byId.get(row.sample_id) ?? []
    list.push(row)
    byId.set(row.sample_id, list)
  }

  const result: ScenarioSheetRow[] = []
  const droppedSampleIds: string[] = []

  for (const group of byId.values()) {
    if (group.length === 1) {
      result.push(group[0])
      continue
    }
    const ownerRows = group.filter((r) => r.origin === 'owner')
    const winner = ownerRows.length > 0 ? ownerRows[0] : group[group.length - 1]
    result.push(winner)
    droppedSampleIds.push(winner.sample_id)
  }

  return { rows: result, droppedSampleIds }
}

/**
 * Delete-and-replace: every untouched `generated` row is dropped (to be
 * replaced by `freshStampedRows`); every edited `generated` row and every
 * `owner` row is preserved untouched. Final pass enforces the one-row-per-
 * sample_id invariant via dedupeRowsBySampleId (see its doc comment).
 */
export function mergeScenarioRows(args: {
  currentRows: readonly ScenarioSheetRow[]
  freshStampedRows: readonly ScenarioSheetRow[]
}): MergeResult {
  const kept: ScenarioSheetRow[] = []
  let keptOwner = 0
  let keptEdited = 0
  let replaced = 0

  for (const row of args.currentRows) {
    if (row.origin === 'owner') {
      kept.push(row)
      keptOwner += 1
      continue
    }
    const currentHash = computeRowHash(row)
    if (currentHash === row.generated_hash) {
      replaced += 1
      continue
    }
    kept.push(row)
    keptEdited += 1
  }

  const { rows: finalRows, droppedSampleIds } = dedupeRowsBySampleId([
    ...kept,
    ...args.freshStampedRows,
  ])

  return {
    finalRows,
    stats: {
      keptOwner,
      keptEdited,
      replaced,
      inserted: args.freshStampedRows.length,
      dedupedSampleIds: droppedSampleIds,
    },
  }
}

// ---------------------------------------------------------------------------
// Tombstones — "the owner deleted this, don't quietly bring it back"
// ---------------------------------------------------------------------------

export interface MetaEntry {
  id: string
  topic: string
  message: string
}

/**
 * `_meta` is an append-only log of every scenario id ever written, across
 * every run. A tombstone is a meta entry whose id is no longer present in
 * the current Scenarios tab at all — not "edited," genuinely gone. That can
 * only mean the owner removed it (this tool never deletes rows itself).
 */
export function detectTombstones(
  metaEntries: readonly MetaEntry[],
  currentRows: readonly ScenarioSheetRow[],
): MetaEntry[] {
  const currentIds = new Set(currentRows.map((r) => r.sample_id))
  return metaEntries.filter((m) => !currentIds.has(m.id))
}

export function groupTombstonesByTopic(
  tombstones: readonly MetaEntry[],
): Map<string, MetaEntry[]> {
  const map = new Map<string, MetaEntry[]>()
  for (const t of tombstones) {
    const list = map.get(t.topic) ?? []
    list.push(t)
    map.set(t.topic, list)
  }
  return map
}

/**
 * Drop any fresh candidate whose message is a near-duplicate (per
 * `similarityLookup`, injected so this stays pure/testable — the real
 * implementation embeds via Voyage and computes cosine similarity, see
 * merge-scenario-sheet.ts) of a tombstoned scenario in the SAME topic.
 * Scoped to topic deliberately: a generic "is this similar to anything
 * ever deleted" check would risk suppressing a legitimately different
 * question that happens to read similarly out of context.
 */
export function filterTombstoneDuplicates(
  freshScenarios: readonly Scenario[],
  tombstonesByTopic: ReadonlyMap<string, MetaEntry[]>,
  similarityLookup: (candidateMessage: string, tombstoneMessage: string) => number,
  threshold: number,
): { kept: Scenario[]; dropped: Array<{ scenario: Scenario; matchedTombstone: MetaEntry }> } {
  const kept: Scenario[] = []
  const dropped: Array<{ scenario: Scenario; matchedTombstone: MetaEntry }> = []

  for (const s of freshScenarios) {
    const tombstones = tombstonesByTopic.get(s.topic) ?? []
    let match: MetaEntry | null = null
    for (const t of tombstones) {
      if (similarityLookup(s.inbound_message, t.message) >= threshold) {
        match = t
        break
      }
    }
    if (match) {
      dropped.push({ scenario: s, matchedTombstone: match })
    } else {
      kept.push(s)
    }
  }

  return { kept, dropped }
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ---------------------------------------------------------------------------
// Runnable filter — Stage 2 consumes this; built now per the ticket's own
// required test ("excluded rows are kept but not run by the runner").
// ---------------------------------------------------------------------------

export function filterRunnableScenarios(rows: readonly ScenarioSheetRow[]): ScenarioSheetRow[] {
  return rows.filter((r) => !r.exclude)
}
