import { z } from 'zod'

// The last sweep's v2 answers, per venue, in this browser's localStorage.
//
// WHY PERSISTED (owner-ruled 2026-10-13, "persist them in localstorage as well
// to survive refresh"). A sweep is 62 live generations and several minutes;
// losing it to a reload - or to a dev-server restart while someone is reading
// the results - means paying for it again to answer the same question.
//
// CHECKPOINTED PER UNIT, not written once at the end. That is the measurement
// harness rule applied to a browser (`scripts/CLAUDE.md` rule 2: the expensive
// half is the model calls, and losing them to a late failure in the cheap half
// is the specific failure). A refresh at question 40 keeps 40 answers.
//
// WHAT IS NOT STORED: the TurnTrace. 50-100 KB a turn against a ~5 MB origin
// budget would blow the quota somewhere around turn 60 - which is to say,
// exactly on a full sweep. Bubbles, verdict and the call's own labels are what
// the comparison reads; the trace is one regenerate away in the playground.
//
// THIS IS NOT A GOLDEN RUN and must never be written as one. `golden_runs`
// holds measured runs with provenance - a sha, a dirty flag, an open state. A
// lab sweep is an unreviewed prompt someone was in the middle of editing, and
// putting it in that table would let it be read beside real runs and cited.
//
// FAILS OPEN on anything it cannot read, like the prompt library: a corrupt
// blob costs the stored sweep, never the page.

const KEY = 'analog.prompt-lab.sweep.v1'

const V2StateSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('done'),
    bubbles: z.array(z.string()),
    verdict: z.enum(['send', 'queue', 'block']).nullable(),
    promptVersion: z.string(),
    model: z.string(),
    effort: z.string().nullable(),
    durationMs: z.number(),
    thinkingTokens: z.number().nullable(),
  }),
  z.object({ status: z.literal('error'), error: z.string() }),
  z.object({ status: z.literal('not_run'), reason: z.string() }),
  // `running` is deliberately NOT storable. A sweep interrupted mid-flight
  // would restore rows claiming to be in progress with nothing driving them,
  // and a spinner that never resolves reads as a hung page rather than as an
  // interrupted sweep. Those rows restore as absent - never asked.
])

const SweepArmSchema = z.object({
  promptName: z.string(),
  /**
   * Whether the system prompt was hand-edited. Defaulted, so a sweep stored
   * before this field existed still parses rather than being dropped - losing
   * a stored sweep to a schema change costs the 58 generations that produced
   * it.
   */
  promptEdited: z.boolean().default(false),
  templateVersion: z.string(),
  modelKey: z.string(),
  effort: z.string(),
  maxOutputTokens: z.number(),
})

const StoredSweepSchema = z.object({
  venueId: z.string().uuid(),
  startedAt: z.string(),
  arm: SweepArmSchema,
  /** Keyed by `GOLDEN_QUESTIONS[].key`. */
  results: z.record(z.string(), V2StateSchema),
})
export type StoredSweep = z.infer<typeof StoredSweepSchema>
export type StoredV2State = z.infer<typeof V2StateSchema>
export type StoredSweepArm = z.infer<typeof SweepArmSchema>

/** One sweep per venue - the latest. Comparing two sweeps is a later ask. */
const StoredSchema = z.array(StoredSweepSchema)

let cache: StoredSweep[] | null = null
const EMPTY: StoredSweep[] = []
const listeners = new Set<() => void>()

function invalidate(): void {
  cache = null
  for (const cb of listeners) cb()
}

function readAll(): StoredSweep[] {
  if (typeof window === 'undefined') return EMPTY
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    return EMPTY
  }
  if (raw === null) return EMPTY
  try {
    const parsed = StoredSchema.safeParse(JSON.parse(raw) as unknown)
    if (parsed.success) return parsed.data
    console.warn('[prompt-lab] stored sweep is malformed; ignoring it')
    return EMPTY
  } catch {
    console.warn('[prompt-lab] stored sweep is not JSON; ignoring it')
    return EMPTY
  }
}

function writeAll(entries: StoredSweep[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    // A quota failure costs the checkpoint, not the sweep: the results are
    // still in React state and still on screen. Warn rather than interrupt a
    // run that is spending real money.
    console.warn('[prompt-lab] could not persist the sweep (quota?)')
  }
  invalidate()
}

export function subscribeSweep(onChange: () => void): () => void {
  listeners.add(onChange)
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) invalidate()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function sweepSnapshot(): StoredSweep[] {
  cache ??= readAll()
  return cache
}

export function sweepServerSnapshot(): StoredSweep[] {
  return EMPTY
}

export function sweepFor(
  all: readonly StoredSweep[],
  venueId: string | null,
): StoredSweep | null {
  if (venueId === null) return null
  return all.find((s) => s.venueId === venueId) ?? null
}

/**
 * Begin a sweep: clears this venue's stored results and records the arm.
 *
 * CLEARS rather than merges, because a sweep is one prompt against the set.
 * Merging a new run's answers into an old run's leftovers would produce a
 * column where some cells came from the prompt in the header and some did not,
 * with nothing on screen able to tell them apart.
 */
export function startSweep(
  venueId: string,
  arm: StoredSweepArm,
  startedAt: string,
): void {
  writeAll([
    { venueId, startedAt, arm, results: {} },
    ...readAll().filter((s) => s.venueId !== venueId),
  ])
}

/**
 * Checkpoint one question's answer, opening a sweep if none is.
 *
 * IT OPENS ONE rather than no-opping, so a single Run survives a refresh too.
 * The alternative - persist only what "Run all" produced - loses exactly the
 * work an ablation loop is made of: three questions, re-run one at a time
 * against an edited block.
 *
 * THE ARM DESCRIBES THE SWEEP'S START, NOT EVERY CELL. A question re-run under
 * a different model lands in the same column, and the header would be wrong if
 * it were the only label. It is not: every answered cell renders its own
 * prompt version, model and effort off its own trace, so the cell is the
 * authority and the header is the heading.
 */
export function recordSweepResult(
  venueId: string,
  questionKey: string,
  state: StoredV2State,
  open: { arm: StoredSweepArm; startedAt: string },
): void {
  const all = readAll()
  const current = all.find((s) => s.venueId === venueId) ?? {
    venueId,
    startedAt: open.startedAt,
    arm: open.arm,
    results: {},
  }
  writeAll([
    { ...current, results: { ...current.results, [questionKey]: state } },
    ...all.filter((s) => s.venueId !== venueId),
  ])
}

export function clearSweep(venueId: string): void {
  writeAll(readAll().filter((s) => s.venueId !== venueId))
}
