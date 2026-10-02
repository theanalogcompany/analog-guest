// Pure: per-stage wall-clock for an admin page render. No `@/*` imports.
//
// The admin pages had no timing anywhere, so "it kept loading" could not be
// attributed: the agent runtime is traced in Langfuse, this surface is not.
// `mark(stage)` records the time since the previous mark, so a stage that was
// started but never finished (a hang) is simply absent, and `lastStage()` names
// the last completed stage - the one the render was past when it stalled.

export interface StageTimer {
  mark(stage: string): void
  stages(): Record<string, number>
  totalMs(): number
  lastStage(): string | null
}

export function createStageTimer(
  now: () => number = () => performance.now(),
): StageTimer {
  const startedAt = now()
  let previous = startedAt
  let last: string | null = null
  const durations: Record<string, number> = {}

  return {
    mark(stage) {
      const t = now()
      durations[stage] = Math.round(t - previous)
      previous = t
      last = stage
    },
    stages: () => ({ ...durations }),
    totalMs: () => Math.round(now() - startedAt),
    lastStage: () => last,
  }
}

// Above this a render is slow enough to warn on. Chosen against the measured
// healthy render (every query under 300ms, ~1s total) with a wide margin.
export const SLOW_RENDER_MS = 3000
