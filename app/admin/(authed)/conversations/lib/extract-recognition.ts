import type { ApiTraceWithFullDetails } from '@/lib/observability'

// Pure projection: trace → recognition data for the RecognitionCard.
//
// Source-of-truth for the signal set is `lib/agent/trace-content.ts`'s
// SIGNAL_KEYS — 7 signals in `recency, visitFrequency, engagementEvents,
// moneySpent, responseRate, percentMenuExplored, referrals` order. The
// extractor preserves whatever order the trace emits (which matches that
// constant) rather than re-sorting; if the source-of-truth set changes,
// the card adapts without code change.
//
// Returns null when:
//   - trace has no `context_build` observation (very old traces from before
//     THE-200, or malformed traces)
//   - the observation's output is missing or malformed
//   - the signals array is missing entirely
// Callers should treat null as "don't render the card."

export interface RecognitionSignalRow {
  /** Signal name (e.g. "responseRate") in source-of-truth order. */
  signal: string
  /** Pre-multiplier 0–100 score for this signal. */
  normalized: number
  /** Allocated weight, 0–1. */
  weight: number
  /** Realized contribution: signal × weight, 0–(weight*100). */
  contribution: number
}

export interface RecognitionData {
  /** 'new' | 'returning' | 'regular' | 'raving_fan' (typed loosely so a future state isn't dropped). */
  state: string
  /** Composite score, 0–100, rounded. */
  score: number
  /** Per-signal breakdown in source-of-truth order. */
  signals: RecognitionSignalRow[]
}

export function extractRecognition(
  trace: ApiTraceWithFullDetails,
): RecognitionData | null {
  const observation = (trace.observations ?? []).find(
    (obs) => obs.name === 'context_build',
  )
  if (!observation) return null
  const output = observation.output
  if (!isRecord(output)) return null

  // Signals live under output.content.signals (THE-216 content split).
  const content = isRecord(output.content) ? output.content : null
  const rawSignals = content?.signals
  if (!Array.isArray(rawSignals)) return null

  const signals: RecognitionSignalRow[] = []
  for (const entry of rawSignals) {
    if (!isRecord(entry)) continue
    const signal = typeof entry.signal === 'string' ? entry.signal : null
    if (!signal) continue
    signals.push({
      signal,
      normalized: numeric(entry.normalized),
      weight: numeric(entry.weight),
      contribution: numeric(entry.contribution),
    })
  }
  if (signals.length === 0) return null

  // State is metadata on the span output (output.recognitionState) — the
  // span sets it as a top-level scalar, not under content.
  const state =
    typeof output.recognitionState === 'string' ? output.recognitionState : 'unknown'

  // Score: prefer the explicit field on the span output. Fall back to summing
  // contributions when missing — equivalent by construction (score is the
  // pre-rounding sum of contributions; see lib/recognition/compute-strength.ts).
  let score: number
  if (typeof output.recognitionScore === 'number' && Number.isFinite(output.recognitionScore)) {
    score = Math.round(output.recognitionScore)
  } else {
    const sum = signals.reduce((acc, s) => acc + s.contribution, 0)
    score = Math.round(sum)
  }

  return { state, score, signals }
}

// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function numeric(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
