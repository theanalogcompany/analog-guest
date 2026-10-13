import { z } from 'zod'

// Hand-edited prompts, kept in this browser's localStorage.
//
// WHY LOCAL AND NOT A TABLE. A prompt in here is a work-in-progress ablation
// arm, not a shared artifact: it belongs to whoever is typing, it is usually
// wrong, and the useful lifetime is an afternoon. A table would need a
// migration, an admin write route, a reader on every surface that lists
// prompts, and a story for who may delete whose. None of that is earned yet.
// The thing a saved prompt must survive is a page reload and a regenerate,
// and localStorage survives both.
//
// WHAT THAT COSTS, so nobody is surprised by it later: it is one browser on
// one machine. Clearing site data loses the lot, a colleague cannot open your
// arm, and nothing is backed up. A prompt worth keeping belongs in a PR body
// or in the template. Say that at the UI, which `prompt-library.tsx` does.
//
// FAILS OPEN on a blob it cannot read, and that direction is the decision
// (`.claude/rules/errors-as-values.md`): this is client-owned state that a
// human can hand-edit in devtools, and a corrupt entry must cost the library,
// never the playground. A refused parse is reported, never thrown.

const KEY = 'analog.playground.saved-prompts.v1'

/**
 * Caps, both of them because localStorage is a shared ~5 MB origin budget and
 * a 23k-char prompt is ~23 KB of it. The playground is not the only thing in
 * there, so this takes a slice rather than all of it.
 *
 * It REFUSES at the cap rather than evicting the oldest. Silently dropping an
 * operator's prompt to make room for a new one is the failure this whole
 * feature exists to avoid, and an eviction policy nobody asked for would do
 * exactly that.
 */
const MAX_ENTRIES = 40
const MAX_TOTAL_CHARS = 1_500_000
export const SAVED_PROMPT_NAME_MAX = 80

const SavedPromptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(SAVED_PROMPT_NAME_MAX),
  /**
   * Scoped per venue, because a prompt is mostly the venue's OWN data - its
   * profile, its voice pack, its retrieval. Offering Le Mil's prompt while
   * another venue is selected would load one venue's facts into another
   * venue's turn, which is the one thing every venue being its own isolated
   * block is meant to prevent.
   */
  venueId: z.string().uuid(),
  savedAt: z.string().min(1),
  /**
   * The template version the prompt was derived FROM, carried so a prompt
   * saved two template bumps ago can say so. It is not a guarantee the text
   * matches that version - the text was hand-edited - it is the answer to
   * "how stale is this".
   */
  promptVersion: z.string().min(1),
  text: z.string().min(1),
})
export type SavedPrompt = z.infer<typeof SavedPromptSchema>

const StoredSchema = z.array(SavedPromptSchema)

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * The parsed store, CACHED, plus a subscription - the shape
 * `useSyncExternalStore` requires.
 *
 * Not a `useEffect` that calls `setState`: that is the pattern React now
 * flags, and it is flagged for a real reason here. The reader renders on the
 * server too (the admin shell is server-rendered), so the honest sequence is
 * "empty on the server, the store on the client" - which is exactly what a
 * store with a separate server snapshot expresses and what an effect
 * expresses by accident.
 *
 * The cache is what makes `getSnapshot` referentially stable. Re-parsing on
 * every call returns a new array each time and React loops forever.
 */
let cache: SavedPrompt[] | null = null
const EMPTY: SavedPrompt[] = []
const listeners = new Set<() => void>()

function invalidate(): void {
  cache = null
  for (const cb of listeners) cb()
}

export function subscribeSavedPrompts(onChange: () => void): () => void {
  listeners.add(onChange)
  // Cross-tab: `storage` fires in the OTHER tabs, never the writing one, so
  // same-tab writes go through `invalidate` and both paths end up here.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) invalidate()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function savedPromptsSnapshot(): SavedPrompt[] {
  cache ??= readAll()
  return cache
}

/** The server has no localStorage, and saying so is not a degraded answer. */
export function savedPromptsServerSnapshot(): SavedPrompt[] {
  return EMPTY
}

function readAll(): SavedPrompt[] {
  if (typeof window === 'undefined') return []
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    // Private-mode Safari throws on access rather than returning null.
    return []
  }
  if (raw === null) return []
  try {
    const parsed = StoredSchema.safeParse(JSON.parse(raw) as unknown)
    if (parsed.success) return parsed.data
    console.warn('[playground] saved prompts are malformed; ignoring the store')
    return []
  } catch {
    console.warn('[playground] saved prompts are not JSON; ignoring the store')
    return []
  }
}

function writeAll(entries: SavedPrompt[]): SaveResult {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries))
    invalidate()
    return { ok: true }
  } catch {
    // A quota failure is the expected one, and the caps above are meant to
    // keep it out of reach. Reaching it anyway is reported as itself rather
    // than as a generic failure, because the fix is "delete something".
    return {
      ok: false,
      error:
        'the browser refused the write - localStorage is full. Delete a saved prompt and try again.',
    }
  }
}

/**
 * This venue's saved prompts, newest first. Never throws.
 *
 * Takes the entries rather than reading the store, so the caller can hand it
 * the snapshot React is already subscribed to - reading again here would
 * return a fresh array and defeat the cache.
 */
export function promptsForVenue(
  all: readonly SavedPrompt[],
  venueId: string,
): SavedPrompt[] {
  return all
    .filter((p) => p.venueId === venueId)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/**
 * Save under a name, REPLACING a same-named prompt for the same venue.
 *
 * Replace rather than append, because the loop this serves is "tweak, rerun,
 * save again": appending would leave five entries called "no moves header" and
 * no way to tell which one ran. The name is the identity; the UI says it is
 * overwriting.
 */
export function saveNamedPrompt(entry: {
  name: string
  venueId: string
  promptVersion: string
  text: string
}): SaveResult {
  const name = entry.name.trim()
  if (name === '') return { ok: false, error: 'give the prompt a name' }
  if (name.length > SAVED_PROMPT_NAME_MAX)
    return {
      ok: false,
      error: `keep the name under ${SAVED_PROMPT_NAME_MAX} characters`,
    }
  if (entry.text.trim() === '')
    return { ok: false, error: 'there is no prompt to save' }

  const all = readAll()
  const kept = all.filter(
    (p) => !(p.venueId === entry.venueId && p.name === name),
  )
  const replacing = kept.length !== all.length
  if (!replacing && kept.length >= MAX_ENTRIES)
    return {
      ok: false,
      error: `${MAX_ENTRIES} saved prompts is the cap. Delete one first.`,
    }
  const total = kept.reduce((n, p) => n + p.text.length, 0) + entry.text.length
  if (total > MAX_TOTAL_CHARS)
    return {
      ok: false,
      error: `that would put the library over ${(MAX_TOTAL_CHARS / 1000).toLocaleString()}k characters. Delete one first.`,
    }

  return writeAll([
    {
      id: crypto.randomUUID(),
      name,
      venueId: entry.venueId,
      savedAt: new Date().toISOString(),
      promptVersion: entry.promptVersion,
      text: entry.text,
    },
    ...kept,
  ])
}

export function deleteSavedPrompt(id: string): SaveResult {
  return writeAll(readAll().filter((p) => p.id !== id))
}
