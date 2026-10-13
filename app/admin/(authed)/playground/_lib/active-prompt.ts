import { z } from 'zod'

// The prompt edit currently IN FORCE for a venue, in this browser.
//
// WHAT IT IS FOR. The ablation loop is "change one line, try it on six
// inbounds" (`.claude/skills/ablate-a-bad-reply`), and the edit has to outlive
// the turn or every inbound costs a retype. It outlives a page refresh for the
// same reason: a refresh in the middle of that loop is not a request to go back
// to the composed prompt.
//
// WHY BLOCKS AND NOT A DOCUMENT is `PromptBlockOverride`'s own docstring, and
// it is the thing that makes an active prompt safe to carry forward at all:
// only the blocks the operator changed are pinned, so HOUSE NOTES stays live
// per turn unless they deliberately pinned it. The UI warns when they have.
//
// SEPARATE FROM THE PROMPT LIBRARY (`saved-prompts.ts`), which is named
// prompts you choose to load. This is the one unnamed edit that is running
// right now. Collapsing them would mean either that saving a prompt applies it
// or that an edit you are mid-way through shows up in a list of keepers.
//
// FAILS OPEN on anything it cannot read, like the library: a corrupt blob
// costs the active edit, never the playground.

import type { PromptBlockOverride } from '@/lib/ai/v2/prompt-text'

const KEY = 'analog.playground.active-prompt.v1'

const ActivePromptSchema = z.object({
  venueId: z.string().uuid(),
  savedAt: z.string().min(1),
  /** The template version it was derived from, so a stale one can say so. */
  promptVersion: z.string().min(1),
  blocks: z
    .array(z.object({ label: z.string().min(1), text: z.string() }))
    .min(1)
    .max(8),
})
export type ActivePrompt = z.infer<typeof ActivePromptSchema>

/** One per venue. Keyed by venue so switching venues does not carry an edit across. */
const StoredSchema = z.array(ActivePromptSchema)

let cache: ActivePrompt[] | null = null
const EMPTY: ActivePrompt[] = []
const listeners = new Set<() => void>()

function invalidate(): void {
  cache = null
  for (const cb of listeners) cb()
}

function readAll(): ActivePrompt[] {
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
    console.warn('[playground] active prompt is malformed; ignoring it')
    return EMPTY
  } catch {
    console.warn('[playground] active prompt is not JSON; ignoring it')
    return EMPTY
  }
}

function writeAll(entries: ActivePrompt[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    // Nothing useful to do and nothing to tell the operator that is not noise:
    // the edit still applies for this session, it just will not survive a
    // refresh. The library is where a quota failure is actionable.
    console.warn('[playground] could not persist the active prompt')
  }
  invalidate()
}

export function subscribeActivePrompt(onChange: () => void): () => void {
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

export function activePromptsSnapshot(): ActivePrompt[] {
  cache ??= readAll()
  return cache
}

export function activePromptsServerSnapshot(): ActivePrompt[] {
  return EMPTY
}

export function activePromptFor(
  all: readonly ActivePrompt[],
  venueId: string | null,
): ActivePrompt | null {
  if (venueId === null) return null
  return all.find((p) => p.venueId === venueId) ?? null
}

/**
 * Make these blocks the active edit, or clear it when there are none.
 *
 * An empty array CLEARS rather than storing an empty override, because "no
 * blocks differ from the composed prompt" and "no edit is in force" are the
 * same state - and storing the former would leave a banner claiming an edit is
 * running when nothing is.
 */
export function setActivePrompt(entry: {
  venueId: string
  promptVersion: string
  blocks: readonly PromptBlockOverride[]
}): void {
  const others = readAll().filter((p) => p.venueId !== entry.venueId)
  if (entry.blocks.length === 0) {
    writeAll(others)
    return
  }
  writeAll([
    {
      venueId: entry.venueId,
      savedAt: new Date().toISOString(),
      promptVersion: entry.promptVersion,
      blocks: [...entry.blocks],
    },
    ...others,
  ])
}

export function clearActivePrompt(venueId: string): void {
  writeAll(readAll().filter((p) => p.venueId !== venueId))
}
