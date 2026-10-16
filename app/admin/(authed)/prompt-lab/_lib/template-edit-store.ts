import { z } from 'zod'
import {
  resolveV2TemplateSet,
  type V2TemplateBlocks,
} from '@/lib/ai/v2/template-archive'
import { TemplateBlocksSchema } from '@/lib/schemas/playground'

// The TEMPLATE under edit - the blocks with their `{placeholders}` still in
// them - in this browser's localStorage.
//
// A SECOND STORE BESIDE THE BASELINE, because the two hold different things.
// `baseline-store.ts` holds the composed OUTPUT for one venue at one version,
// which is the right thing to edit for an ablation and the wrong thing to
// promote: V2_PROMPT_VERSION's v2.20.0 entry is the record of what promoting
// it costs. This holds the template itself, so the composer still fills each
// block per venue and per turn, and an edit measured here is the same thing
// that would ship.
//
// KEYED BY TEMPLATE VERSION ONLY, not by venue. A template edit is global
// copy by construction - the promotion target is the global default, and
// `V2_FRAME`'s own comments refuse a venue's name or handle in it for exactly
// that reason. Keying per venue would invite an edit that reads as venue
// tuning and promotes as a fleet-wide change. The venue difference that DOES
// exist is which block 2 composes, and that is two boxes rather than two
// scopes.
//
// ONLY THE BLOCKS THAT DIFFER ARE STORED, computed on write against the
// version's own strings. That keeps the override minimal - an untouched block
// is not sent at all, so the turn composes byte-identically to sending no
// override - and it is what makes "is this edited" a fact about the stored
// entry rather than a second flag that can disagree with it.
//
// `TemplateBlocksSchema` is the WIRE schema, reused here deliberately: what a
// block edit is has one definition, and a blob this store accepted is a blob
// the run route accepts.
//
// FAILS OPEN on anything unreadable, like the baseline store and the prompt
// library: a corrupt blob costs the edit, never the page.

const KEY = 'analog.prompt-lab.template-edit.v1'

const EditSchema = z.object({
  /** Which version's blocks these are edits to. Part of the identity. */
  templateVersion: z.string(),
  /** Only the blocks that differ from that version's own text. */
  blocks: TemplateBlocksSchema,
})
export type StoredTemplateEdit = z.infer<typeof EditSchema>

const StoredSchema = z.array(EditSchema)

let cache: StoredTemplateEdit[] | null = null
const EMPTY: StoredTemplateEdit[] = []
const listeners = new Set<() => void>()

function invalidate(): void {
  cache = null
  for (const cb of listeners) cb()
}

function readAll(): StoredTemplateEdit[] {
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
    console.warn('[prompt-lab] the stored template edit is malformed; ignoring')
    return EMPTY
  } catch {
    console.warn('[prompt-lab] the stored template edit is not JSON; ignoring')
    return EMPTY
  }
}

export function subscribeTemplateEdit(onChange: () => void): () => void {
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

export function templateEditSnapshot(): StoredTemplateEdit[] {
  cache ??= readAll()
  return cache
}

export function templateEditServerSnapshot(): StoredTemplateEdit[] {
  return EMPTY
}

const NO_BLOCKS: V2TemplateBlocks = {}

/**
 * The edited blocks for one version, or `{}` when nothing is edited.
 *
 * Cached by identity through the array it reads from, so the returned object
 * is stable between renders for as long as the store is - `{}` is a shared
 * constant for the same reason `useSyncExternalStore` needs a stable snapshot.
 */
export function templateEditFor(
  all: readonly StoredTemplateEdit[],
  templateVersion: string,
): V2TemplateBlocks {
  const hit = all.find((e) => e.templateVersion === templateVersion)
  return hit?.blocks ?? NO_BLOCKS
}

/**
 * One block, edited. Passing text equal to the version's own CLEARS the edit
 * rather than storing an identical copy, which is what makes Reset a write of
 * the original rather than a second code path.
 *
 * The version's strings come from `resolveV2TemplateSet`, so an unknown
 * version resolves the way it resolves everywhere else - fails open to the
 * current template, loudly.
 */
export function saveTemplateBlock(
  templateVersion: string,
  key: keyof V2TemplateBlocks,
  text: string,
): void {
  const all = readAll()
  const current = templateEditFor(all, templateVersion)
  const set = resolveV2TemplateSet(templateVersion)
  const original =
    key === 'outreachNote'
      ? set.outreach?.note
      : key === 'outreachCue'
        ? set.outreach?.cue
        : set[key]
  const blocks: V2TemplateBlocks = { ...current }
  if (text === original) delete blocks[key]
  else blocks[key] = text
  write(all, templateVersion, blocks)
}

/** Every edit to this version, dropped. */
export function clearTemplateEdit(templateVersion: string): void {
  write(readAll(), templateVersion, {})
}

function write(
  all: readonly StoredTemplateEdit[],
  templateVersion: string,
  blocks: V2TemplateBlocks,
): void {
  const others = all.filter((e) => e.templateVersion !== templateVersion)
  const next =
    Object.keys(blocks).length === 0
      ? others
      : [{ templateVersion, blocks }, ...others]
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // A quota failure costs persistence, never the run: the pane still holds
    // the text in React state for this session.
    console.warn('[prompt-lab] could not persist the template edit (quota?)')
  }
  invalidate()
}
