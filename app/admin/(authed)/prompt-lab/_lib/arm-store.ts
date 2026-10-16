import { z } from 'zod'
import {
  V2_DEFAULT_EFFORT,
  V2_DEFAULT_MODEL_KEY,
  V2_EFFORT_REQUESTS,
  V2_MODEL_KEYS,
  V2_PLAYGROUND_MAX_OUTPUT_TOKENS,
} from '@/lib/ai/v2/model-call'

// The call parameters the lab runs with - model, effort, output budget - in
// this browser's localStorage (owner-ruled 2026-10-15, "survive refresh").
//
// WHY PERSISTED. These are the arm of an experiment, not a view setting: an
// operator picks a model, sweeps 58 questions on it, reads the answers, and
// reloads to compare. Resetting the model on reload means the NEXT sweep runs
// on a different model than the one on screen, and nothing on the page would
// say so - the stored sweep records which model answered it, so the two would
// disagree silently. That is the failure this closes, and it is the same
// reason the sweep itself is persisted.
//
// NOT PER VENUE, unlike the sweep and the baseline. A model is a property of
// the question being asked ("how does 5.5 handle this prompt"), not of the
// venue, and keying it per venue would mean switching venue silently switches
// model mid-experiment.
//
// THE DEFAULT IS PRODUCTION'S, not the lab's own pin. It was `haiku-5-5` for
// the cheap-seat reason until 2026-10-15, and the owner ruled the lab onto the
// production default - `V2_DEFAULT_MODEL_KEY`, so this surface follows the
// product rather than needing a second edit whenever that moves. A sweep is
// still 58 generations, so the cost argument is real and is now the
// operator's to make with the picker.
//
// VALIDATED AGAINST THE LIVE PROFILE LIST, not stored blind: a model key that
// has since been removed would otherwise come back on every reload and fail at
// the request. An unreadable or unknown blob falls back to the defaults, like
// the sweep store and the prompt library - a corrupt entry costs the
// selection, never the page.

const KEY = 'analog.prompt-lab.arm.v1'

const ArmSchema = z.object({
  modelKey: z.enum(V2_MODEL_KEYS),
  effort: z.enum(V2_EFFORT_REQUESTS),
  // Bounded at both ends exactly as the run route bounds it: a stored 0 would
  // generate nothing and read as the model failing.
  maxOutputTokens: z
    .number()
    .int()
    .min(100)
    .max(V2_PLAYGROUND_MAX_OUTPUT_TOKENS),
})
export type StoredArm = z.infer<typeof ArmSchema>

export const DEFAULT_ARM: StoredArm = {
  modelKey: V2_DEFAULT_MODEL_KEY,
  effort: V2_DEFAULT_EFFORT,
  maxOutputTokens: V2_PLAYGROUND_MAX_OUTPUT_TOKENS,
}

let cache: StoredArm | null = null
const listeners = new Set<() => void>()

function invalidate(): void {
  cache = null
  for (const cb of listeners) cb()
}

export function subscribeArm(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

/**
 * Cached because `useSyncExternalStore` compares snapshots by identity: a
 * fresh object per call is an infinite render loop, not a performance note.
 */
export function armSnapshot(): StoredArm {
  if (cache !== null) return cache
  cache = read()
  return cache
}

/** The server render has no localStorage; the defaults are what it paints. */
export function armServerSnapshot(): StoredArm {
  return DEFAULT_ARM
}

function read(): StoredArm {
  if (typeof window === 'undefined') return DEFAULT_ARM
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    return DEFAULT_ARM
  }
  if (raw === null) return DEFAULT_ARM
  try {
    const parsed = ArmSchema.safeParse(JSON.parse(raw) as unknown)
    if (parsed.success) return parsed.data
    console.warn('[prompt-lab] stored call settings are malformed; ignoring')
    return DEFAULT_ARM
  } catch {
    return DEFAULT_ARM
  }
}

/**
 * Merges, so a caller changing one field cannot blank the other two.
 *
 * The patch is LOOSELY TYPED on purpose - the pickers hand back plain strings
 * (a `<Select>` has no idea what a profile key is) and the schema is the one
 * thing that decides whether a value is a real model or effort. A cast at the
 * call site would be that decision made twice, in a place that cannot fail.
 * An unknown value is dropped and the stored arm is left as it was.
 */
export function saveArm(patch: {
  modelKey?: string
  effort?: string
  maxOutputTokens?: number
}): void {
  const next = { ...armSnapshot(), ...patch }
  const parsed = ArmSchema.safeParse(next)
  if (!parsed.success) return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(parsed.data))
  } catch {
    // A full or blocked quota costs persistence, never the run.
    return
  }
  invalidate()
}
