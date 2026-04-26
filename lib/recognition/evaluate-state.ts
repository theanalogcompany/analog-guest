import type { GuestState, StateThresholds } from './types'

const FALLBACK_STATE: GuestState = 'new'

function clampScore(score: number): number {
  if (score < 0) return 0
  if (score > 100) return 100
  return score
}

/**
 * Pure: map a 0–100 score to a discrete state by checking which threshold
 * band it falls in. The score is clamped to [0, 100] before evaluation.
 *
 * If the thresholds array is malformed (gaps, overlaps, or no matching
 * band), a console.warn is emitted and the lowest matching state — by
 * minScore — is returned. If nothing matches at all, falls back to 'new'.
 */
export function evaluateState(score: number, thresholds: StateThresholds): GuestState {
  const clamped = clampScore(score)
  const matches = thresholds.thresholds.filter(
    (t) => clamped >= t.minScore && clamped <= t.maxScore,
  )
  if (matches.length === 0) {
    console.warn('evaluateState: no threshold band matched', {
      score,
      clamped,
      thresholds,
    })
    return FALLBACK_STATE
  }
  if (matches.length > 1) {
    console.warn('evaluateState: multiple threshold bands matched, picking lowest minScore', {
      score,
      clamped,
      matches: matches.map((m) => m.state),
    })
  }

  let lowest = matches[0]
  for (const m of matches) {
    if (m.minScore < lowest.minScore) lowest = m
  }
  return lowest.state
}