import { z } from 'zod'

// Guest commitments (TAC-297). Schemas covering: (1) what the agent emits on
// GeneratedMessageSchema.commitment + .arrivalCapture, (2) the
// messages.pending_commitment jsonb carrier shape, (3) the persisted
// guest_commitments row, (4) the active-commitments runtime projection
// rendered in the ## Active commitments user-prompt block.
//
// Schema strategy mirrors guest-context.ts:
//   - All emission fields .optional() so the no-op shape is `{}` — Anthropic
//     structured-output reliability per the TAC-296 precedent.
//   - No .min() / .max() / .datetime() on LLM-output number/string fields per
//     THE-157 (Anthropic rejects those JSON Schema constraints).
//   - Permissive parse on JSONB reads (no .strict()), so future schema
//     extensions don't break older deploys reading the same rows.
//   - Strings stored verbatim; the runtime stamps captured_at / generates the
//     code where needed.

// ===== Enums =====

// Commitment types. Gate routing: comp/hold/discount → routes through the
// TAC-212 approval gate (COMMITMENT_TYPE_GATED trigger in stages.ts);
// recommendation does NOT gate. See "Approval policy gates" in CLAUDE.md.
export const CommitmentTypeSchema = z.enum([
  'recommendation',
  'hold',
  'comp',
  'discount',
])
export type CommitmentType = z.infer<typeof CommitmentTypeSchema>

// Lifecycle of a commitment row. See migration 026 header for the diagram.
// Transitions are CAS-gated in lib/guests/commitments.ts so concurrent
// imminent inbound + cron firing on the same row produces exactly one push.
export const CommitmentStatusSchema = z.enum([
  'open',
  'pending_ack',
  'acknowledged',
  'redeemed',
  'expired',
  'cancelled',
])
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>

// How the guest signaled their arrival.
//   imminent — "on my way" / "nearby" / "here in 5" — transition to
//              pending_ack and push immediately, real-time off the inbound.
//   scheduled — "tomorrow morning" / "after 4" — store expected_arrival,
//              status stays 'open', the hourly cron fires it that morning.
export const ArrivalSignalSchema = z.enum(['imminent', 'scheduled'])
export type ArrivalSignal = z.infer<typeof ArrivalSignalSchema>

// Who created the row. Agent-only in v1 — operator-created commitments are
// out of scope per the ticket — but the column is shaped to accept it later.
export const CommitmentCreatedBySchema = z.enum(['agent', 'operator'])
export type CommitmentCreatedBy = z.infer<typeof CommitmentCreatedBySchema>

// ===== Code generation =====

// Cosmetic verification chip for comp/hold/discount commitments. The
// operator reads it aloud or types it to confirm the right guest before
// handing over the item. 4 alphanumeric chars — short enough to glance,
// long enough to disambiguate within a venue's daily volume (~36^4 ≈ 1.6M).
//
// Excludes visually-confusable characters (0/O, 1/I/L) to reduce
// read-aloud mistakes. The remaining alphabet is 31 chars; entropy is
// log2(31^4) ≈ 19.8 bits — sufficient for the daily-scope collision risk.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 4

export function generateCommitmentCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

// ===== Agent emission shapes =====

// What the agent emits on GeneratedMessageSchema.commitment. All fields
// optional so the no-op shape (no commitment this turn) is `{}` — mirrors
// the TAC-296 contextUpdate precedent. The orchestrator's
// isEmptyCommitmentEmission predicate short-circuits before any DB hit.
export const CommitmentEmissionSchema = z.object({
  type: CommitmentTypeSchema.optional(),
  description: z.string().optional(),
  code: z.string().optional(),
  expiresAt: z.string().optional(),
})
export type CommitmentEmission = z.infer<typeof CommitmentEmissionSchema>

// What the agent emits on GeneratedMessageSchema.arrivalCapture. All fields
// optional. Populated when the guest's inbound signals arrival in response
// to an existing active commitment surfaced in the ## Active commitments
// prompt block. The orchestrator's isEmptyArrivalCapture predicate
// short-circuits before any DB hit.
export const ArrivalCaptureEmissionSchema = z.object({
  signal: ArrivalSignalSchema.optional(),
  expectedArrival: z.string().optional(),
  referencesCommitmentId: z.string().optional(),
})
export type ArrivalCaptureEmission = z.infer<typeof ArrivalCaptureEmissionSchema>

/**
 * True when the agent emitted no actionable commitment this turn. Used by
 * orchestrators to skip the DB write entirely (zero round-trips, no Langfuse
 * span). Mirrors isEmptyContextUpdate in lib/guests/context.ts.
 *
 * "Actionable" requires BOTH `type` and `description` — a partial emission
 * (type only, description only) can't materialize a row and is treated as
 * no-op rather than a half-failure.
 */
export function isEmptyCommitmentEmission(
  emission: CommitmentEmission,
): boolean {
  if (emission.type === undefined) return true
  if (emission.description === undefined) return true
  if (emission.description.trim().length === 0) return true
  return false
}

/**
 * True when the agent emitted no actionable arrival capture this turn.
 * "Actionable" requires `signal` AND `referencesCommitmentId` — a signal
 * without a referenced commitment can't transition anything; a referenced
 * commitment without a signal carries no new info.
 */
export function isEmptyArrivalCapture(emission: ArrivalCaptureEmission): boolean {
  if (emission.signal === undefined) return true
  if (emission.referencesCommitmentId === undefined) return true
  if (emission.referencesCommitmentId.trim().length === 0) return true
  return false
}

// ===== Pending-commitment jsonb carrier =====

// The shape persisted on messages.pending_commitment. Stricter than the
// emission schema — by the time this lands on disk, the orchestrator has
// validated the emission has type + description and generated a code if
// needed. `code` and `expiresAt` are nullable rather than optional because
// the jsonb shape is fully self-describing — the dispatch site shouldn't
// have to disambiguate "absent" from "explicitly no code."
export const PendingCommitmentSchema = z.object({
  type: CommitmentTypeSchema,
  description: z.string().min(1),
  code: z.string().nullable(),
  expiresAt: z.string().nullable(),
})
export type PendingCommitment = z.infer<typeof PendingCommitmentSchema>

/**
 * Convert an agent emission into a PendingCommitment ready to write to the
 * jsonb carrier. Generates a verification code if the agent didn't emit
 * one AND the type requires one (comp/hold/discount). Returns null if the
 * emission is not actionable — caller should skip the write.
 */
export function pendingFromEmission(
  emission: CommitmentEmission,
): PendingCommitment | null {
  if (isEmptyCommitmentEmission(emission)) return null
  // Type-narrowing: isEmptyCommitmentEmission guarantees both are defined.
  const type = emission.type!
  const description = emission.description!.trim()
  const requiresCode = type === 'comp' || type === 'hold' || type === 'discount'
  const code = requiresCode ? (emission.code?.trim() || generateCommitmentCode()) : null
  const expiresAt = emission.expiresAt?.trim() || null
  return { type, description, code, expiresAt }
}

// ===== Persisted row + runtime projection =====

// Full DB row shape. Used by lib/guests/commitments.ts and the operator API
// response handlers. Field names mirror migration 026 column names.
export const GuestCommitmentRowSchema = z.object({
  id: z.string(),
  guest_id: z.string(),
  venue_id: z.string(),
  type: CommitmentTypeSchema,
  description: z.string(),
  code: z.string().nullable(),
  status: CommitmentStatusSchema,
  expected_arrival: z.string().nullable(),
  arrival_signal: ArrivalSignalSchema.nullable(),
  created_by: CommitmentCreatedBySchema,
  expires_at: z.string().nullable(),
  acknowledged_at: z.string().nullable(),
  acknowledged_by: z.string().nullable(),
  redeemed_at: z.string().nullable(),
  source_message_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type GuestCommitmentRow = z.infer<typeof GuestCommitmentRowSchema>

// The runtime-ready projection rendered into the ## Active commitments
// prompt block. A trimmed shape — drops audit columns the agent doesn't
// need (created_by, acknowledged_*, redeemed_at, source_message_id).
// Distinct from GuestCommitmentRow to make it harder for the serializer to
// accidentally leak audit fields into the user prompt.
export interface ActiveCommitment {
  id: string
  type: CommitmentType
  description: string
  code: string | null
  status: Extract<CommitmentStatus, 'open' | 'pending_ack'>
  expected_arrival: string | null
  arrival_signal: ArrivalSignal | null
  created_at: string
}

/**
 * Project a persisted row into the ActiveCommitment shape. Pure — no side
 * effects. Returns null if the row is not in the active set (acknowledged,
 * expired, cancelled, redeemed) — caller should filter on this.
 */
export function toActiveCommitment(
  row: GuestCommitmentRow,
): ActiveCommitment | null {
  if (row.status !== 'open' && row.status !== 'pending_ack') return null
  return {
    id: row.id,
    type: row.type,
    description: row.description,
    code: row.code,
    status: row.status,
    expected_arrival: row.expected_arrival,
    arrival_signal: row.arrival_signal,
    created_at: row.created_at,
  }
}

// ===== Operator-API payload shape =====

// The Contract-locked shape consumed by analog-operator (TAC-298) via
// GET /api/operator/queue's new `commitments` field. Field names use
// snake_case to match the SQL row shape (consistent with QueueDraft).
export interface HeadsUpCommitment {
  id: string
  type: CommitmentType
  guest: { name: string }
  description: string
  code: string | null
  expected_arrival: string | null
  created_at: string
}
