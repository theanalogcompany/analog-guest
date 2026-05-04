import type { TimingPlan } from './types'

const TOTAL_DELAY_MIN_MS = 25_000
// THE-230: tightened the upper bound from 120_000 (2 min) to 60_000 (1 min).
// Two minutes felt long enough that guests would re-text or refresh before the
// reply landed; a one-minute ceiling still reads as "the venue is busy" but
// stays within text-response patience.
const TOTAL_DELAY_MAX_MS = 40_000
const MARK_AS_READ_GAP_MIN_MS = 5_000
const MARK_AS_READ_GAP_MAX_MS = 15_000

function randIntInclusive(minInclusive: number, maxInclusive: number): number {
  return Math.floor(Math.random() * (maxInclusive - minInclusive + 1)) + minInclusive
}

/**
 * Sample a human-feeling timing plan for an outbound message reply.
 *
 * The total delay (read → pause → typing → send) lands somewhere in
 * 30s–60s. Within that window, the gap from receipt to mark-as-read is
 * 5–15s, then a pre-typing pause occupies 0 to half the remaining window,
 * and the typing indicator covers the rest right up until send.
 *
 * Invariant: markAsReadGapMs + preTypingPauseMs + typingDurationMs equals
 * totalDelayMs exactly. The unit test asserts this for every sample.
 *
 * Pure function — no I/O. Random sampling via Math.random().
 */
export function sampleTiming(): TimingPlan {
  const totalDelayMs = randIntInclusive(TOTAL_DELAY_MIN_MS, TOTAL_DELAY_MAX_MS)
  const markAsReadGapMs = randIntInclusive(MARK_AS_READ_GAP_MIN_MS, MARK_AS_READ_GAP_MAX_MS)
  const remainingAfterRead = totalDelayMs - markAsReadGapMs
  const preTypingPauseMs = randIntInclusive(0, Math.floor(remainingAfterRead / 2))
  const typingDurationMs = totalDelayMs - markAsReadGapMs - preTypingPauseMs

  return {
    totalDelayMs,
    markAsReadGapMs,
    preTypingPauseMs,
    typingDurationMs,
  }
}