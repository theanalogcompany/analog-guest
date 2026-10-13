import { z } from 'zod'

// This venue's composed system prompt, kept in localStorage so the editor is
// there after a reload.
//
// IT IS ONE PLAIN DOCUMENT, not three blocks (owner-ruled 2026-10-13: "just
// one giant editable system prompt"). The composer builds three system blocks
// and the playground edits them by label; this stores their texts
// concatenated in order, with no delimiters, and the whole thing goes back as
// the `systemText` override. `replaceSystemText` in lib/ai/v2/prompt-text.ts
// says what collapsing them costs, and `_components/prompt-pane.tsx` says why
// it is the right trade on this surface.
//
// WHY PERSISTING IS SAFE: the entry is keyed by venue AND template version,
// and a run refreshes it whenever the composer disagrees - so a template
// edited under a reused version string, which is what `-draft` means, cannot
// leave a stale one behind. It is NOT refreshed while an edit is open, because
// replacing the baseline under an open edit would silently change what Reset
// goes back to.
//
// FAILS OPEN on anything unreadable, like the sweep store and the prompt
// library: a corrupt blob costs the saved prompt, never the page.

const KEY = 'analog.prompt-lab.baseline.v1'

const BaselineSchema = z.object({
  venueId: z.string().uuid(),
  /** Part of the identity: the same venue composes differently per template. */
  templateVersion: z.string(),
  /** Every system block's text, concatenated in order. */
  text: z.string(),
})
export type StoredBaseline = z.infer<typeof BaselineSchema>

const StoredSchema = z.array(BaselineSchema)

let cache: StoredBaseline[] | null = null
const EMPTY: StoredBaseline[] = []
const listeners = new Set<() => void>()

function invalidate(): void {
  cache = null
  for (const cb of listeners) cb()
}

function readAll(): StoredBaseline[] {
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
    console.warn('[prompt-lab] stored baseline is malformed; ignoring it')
    return EMPTY
  } catch {
    console.warn('[prompt-lab] stored baseline is not JSON; ignoring it')
    return EMPTY
  }
}

export function subscribeBaseline(onChange: () => void): () => void {
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

export function baselineSnapshot(): StoredBaseline[] {
  cache ??= readAll()
  return cache
}

export function baselineServerSnapshot(): StoredBaseline[] {
  return EMPTY
}

export function baselineFor(
  all: readonly StoredBaseline[],
  venueId: string | null,
  templateVersion: string,
): string {
  if (venueId === null) return ''
  const hit = all.find(
    (b) => b.venueId === venueId && b.templateVersion === templateVersion,
  )
  return hit?.text ?? ''
}

/** Record the composer's current system prompt. No-op when unchanged. */
export function rememberBaseline(entry: StoredBaseline): void {
  const all = readAll()
  const existing = all.find(
    (b) =>
      b.venueId === entry.venueId &&
      b.templateVersion === entry.templateVersion,
  )
  if (existing?.text === entry.text) return
  const next = [
    entry,
    ...all.filter(
      (b) =>
        b.venueId !== entry.venueId ||
        b.templateVersion !== entry.templateVersion,
    ),
  ]
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // A quota failure costs the saved baseline, not the session: the editor
    // still holds it in React state.
    console.warn('[prompt-lab] could not persist the baseline (quota?)')
  }
  invalidate()
}
