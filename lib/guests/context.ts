import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'
import {
  type GuestContext,
  type GuestContextPatch,
  GuestContextSchema,
} from '@/lib/schemas/guest-context'

// The shape the agent emits on `GeneratedMessageSchema.contextUpdate` after a
// generation. `structured` is a DeepPartial of the persisted GuestContext;
// `observation` is the append-only shortcut for the catch-all observations[]
// array. Both fields optional — the no-op emission is `{}`. (TAC-296)
export type GuestContextUpdate = {
  structured?: GuestContextPatch
  observation?: string
}

// Result payload from updateGuestContext, threaded onto the Langfuse
// `context_write` span output. `identityColumnsChanged` lists the operator-
// visible columns (first_name / last_name) that got synced alongside the
// JSONB write — useful for distinguishing "the model claimed Sarah is a name"
// from "the model added a dietary preference."
export type GuestContextUpdateResult = {
  hasStructured: boolean
  hasObservation: boolean
  identityColumnsChanged: ('first_name' | 'last_name')[]
}

/**
 * True when the agent's contextUpdate emission has no content to persist.
 * Used by orchestrators to short-circuit before any DB hit or Langfuse span.
 *
 * Trims `observation` for the empty-string check so the model emitting
 * `observation: " "` (whitespace) is treated as no-op rather than appending a
 * whitespace-only observation.
 */
export function isEmptyContextUpdate(update: GuestContextUpdate): boolean {
  const structuredEmpty =
    update.structured === undefined ||
    Object.keys(update.structured).length === 0
  const observationEmpty =
    update.observation === undefined || update.observation.trim().length === 0
  return structuredEmpty && observationEmpty
}

/**
 * Pure deep-merge of a GuestContextPatch into an existing GuestContext.
 * - Top-level objects (guest_details, preferences) deep-merge field by field.
 * - One-level-down objects (guest_details.home_base, guest_details.workplace)
 *   also deep-merge — they're conceptually single entities, not arrays.
 * - All arrays (preferences.dietary/favorites/dislikes, life_context,
 *   observations) are REPLACED, not appended (per the TAC-296 ticket spec).
 *   The agent emits the full new array when it wants to update.
 * - life_context and observations entries missing `captured_at` are stamped
 *   with `now.toISOString()` so the persisted shape always carries the
 *   required timestamp.
 *
 * Exported for direct unit testing. Callers should usually go through
 * updateGuestContext, which also handles the observation shortcut and
 * identity-column sync.
 */
export function deepMergeContext(
  existing: GuestContext,
  patch: GuestContextPatch,
  now: Date,
): GuestContext {
  const merged: GuestContext = { ...existing }

  if (patch.guest_details !== undefined) {
    merged.guest_details = {
      ...existing.guest_details,
      ...patch.guest_details,
      home_base:
        patch.guest_details.home_base !== undefined
          ? { ...existing.guest_details?.home_base, ...patch.guest_details.home_base }
          : existing.guest_details?.home_base,
      workplace:
        patch.guest_details.workplace !== undefined
          ? { ...existing.guest_details?.workplace, ...patch.guest_details.workplace }
          : existing.guest_details?.workplace,
    }
  }

  if (patch.preferences !== undefined) {
    merged.preferences = {
      ...existing.preferences,
      ...patch.preferences,
    }
  }

  if (patch.life_context !== undefined) {
    merged.life_context = patch.life_context.map((entry) => ({
      ...entry,
      captured_at: entry.captured_at ?? now.toISOString(),
    }))
  }

  if (patch.observations !== undefined) {
    merged.observations = patch.observations.map((entry) => ({
      ...entry,
      captured_at: entry.captured_at ?? now.toISOString(),
    }))
  }

  return merged
}

/**
 * Read `guests.context` for the given guest and parse via GuestContextSchema.
 *
 * Fails OPEN on malformed JSONB: logs a warning, returns an empty context.
 * The agent path treats absence of context the same as empty context (the
 * prompt block is omitted entirely), so a malformed row degrades gracefully
 * rather than crashing the agent run on stored bad data.
 *
 * DB errors (network, RLS, missing row) DO bubble up as `{ ok: false }` — the
 * caller (orchestrator) catches and logs, but doesn't dispatch a write either
 * (the write helper short-circuits when the read fails).
 */
export async function getGuestContext(
  guestId: string,
): Promise<RAGResult<GuestContext>> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guests')
      .select('context')
      .eq('id', guestId)
      .maybeSingle()
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_read_failed' }
    }
    if (!data) {
      return { ok: false, error: `guest not found: ${guestId}`, errorCode: 'guest_not_found' }
    }
    const parsed = GuestContextSchema.safeParse(data.context)
    if (!parsed.success) {
      console.warn(
        `[guest-context] malformed guests.context for ${guestId}: ${parsed.error.message}. Treating as empty.`,
      )
      return { ok: true, data: {} }
    }
    return { ok: true, data: parsed.data }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_read_threw' }
  }
}

/**
 * Compose the deep-merged context + observation append + identity column sync
 * into a single UPDATE statement. Atomic at the row level (TAC-296 architectural
 * call #5: no RPC, no sequenced writes).
 *
 * Order of operations:
 *   1. Read existing context via getGuestContext.
 *   2. Deep-merge structured patch (if present).
 *   3. Append observation shortcut (if present + non-empty after trim) to
 *      observations[] with captured_at = now.
 *   4. Detect identity-column dirty fields (first_name / last_name on
 *      patch.structured.guest_details).
 *   5. One UPDATE: SET context = ?, [first_name = ?,] [last_name = ?] WHERE id = ?.
 *
 * Concurrency posture: LAST-WRITE-WINS for v1 (TAC-296 architectural call #6,
 * documented in CLAUDE.md "Common gotchas"). Two near-simultaneous inbounds
 * from the same guest deep-merge against the same baseline and one will
 * clobber the other on UPDATE. Acceptable for pilot scale; revisit with
 * optimistic locking (updated_at precondition + retry) if pilot data shows
 * the failure mode.
 *
 * Failure posture: errors-as-values RAGResult. Never throws. The agent
 * orchestrator awaits this between generateStage success and
 * applyApprovalPolicyStage; a failure logs + continues to the gate, never
 * blocking dispatch (context-write is diagnostic, not load-bearing).
 */
export async function updateGuestContext(opts: {
  guestId: string
  update: GuestContextUpdate
  now: Date
}): Promise<RAGResult<GuestContextUpdateResult>> {
  const { guestId, update, now } = opts

  if (isEmptyContextUpdate(update)) {
    return {
      ok: true,
      data: { hasStructured: false, hasObservation: false, identityColumnsChanged: [] },
    }
  }

  const existing = await getGuestContext(guestId)
  if (!existing.ok) return existing

  let merged = update.structured
    ? deepMergeContext(existing.data, update.structured, now)
    : existing.data

  const trimmedObservation =
    update.observation !== undefined && update.observation.trim().length > 0
      ? update.observation.trim()
      : null

  if (trimmedObservation !== null) {
    merged = {
      ...merged,
      observations: [
        ...(merged.observations ?? []),
        { note: trimmedObservation, captured_at: now.toISOString() },
      ],
    }
  }

  // Identity-column sync. Only include columns that the patch explicitly
  // touched — never overwrite first_name with undefined when the patch didn't
  // mention it, which would null the column.
  const identityColumnsChanged: ('first_name' | 'last_name')[] = []
  const updatePayload: {
    context: GuestContext
    first_name?: string
    last_name?: string
  } = { context: merged }

  if (update.structured?.guest_details?.first_name !== undefined) {
    updatePayload.first_name = update.structured.guest_details.first_name
    identityColumnsChanged.push('first_name')
  }
  if (update.structured?.guest_details?.last_name !== undefined) {
    updatePayload.last_name = update.structured.guest_details.last_name
    identityColumnsChanged.push('last_name')
  }

  try {
    const supabase = createAdminClient()
    const { error } = await supabase
      .from('guests')
      .update(updatePayload)
      .eq('id', guestId)
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_write_failed' }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_write_threw' }
  }

  return {
    ok: true,
    data: {
      hasStructured:
        update.structured !== undefined &&
        Object.keys(update.structured).length > 0,
      hasObservation: trimmedObservation !== null,
      identityColumnsChanged,
    },
  }
}
