// TAC-586: which page, which slot, and how far off true. Pure: no I/O, no
// clock, no Math.random.
//
// Six stamps to a page; stamp n (1-based `seq`) lands on page ⌈n/6⌉. A spread
// is two facing pages, (01–02), (03–04)…, and the guest is always sent the
// spread holding their newest stamp.
//
// ALL RANDOMNESS COMES FROM THE ROW'S `texture_seed`. The slot, the jitter
// and the wobble are drawn here once, at insert, and stored on the row, so a
// later render reads them back instead of drawing them again. The renderer
// draws its own wear from the same seed through `wearRng`, a separate stream,
// so changing how many numbers layout draws can never shift the wear of a
// stamp already sent.
//
// The page template is a function of (guest, page) alone, by FNV-1a, so
// every stamp on one page agrees on the template without storing it.
//
// Rotation = the slot's own angle + a seeded wobble of ±3°, clamped to the
// stamp spec's −8°…+8°.

import { PAGE_TEMPLATES, type PageTemplate } from './templates'

export const STAMPS_PER_PAGE = 6
export const JITTER_X = 12
export const JITTER_Y = 7
export const ROTATION_WOBBLE = 3
export const MAX_ROTATION = 8

/** A 32-bit seeded generator returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The renderer's stream for a stamp's wear, independent of layout's draws. */
export function wearRng(textureSeed: number): () => number {
  return mulberry32((textureSeed ^ 0x9e3779b9) >>> 0)
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function pageForSeq(seq: number): number {
  return Math.floor((seq - 1) / STAMPS_PER_PAGE) + 1
}

/** The two facing pages that hold `page`: 1→[1,2], 2→[1,2], 3→[3,4]. */
export function spreadForPage(page: number): readonly [number, number] {
  const left = page % 2 === 1 ? page : page - 1
  return [left, left + 1]
}

export function templateFor(guestId: string, page: number): PageTemplate {
  return PAGE_TEMPLATES[fnv1a(`${guestId}:${page}`) % PAGE_TEMPLATES.length]!
}

export type Placement = {
  page: number
  slot: number
  dx: number
  dy: number
  rotation: number
}

function between(rng: () => number, bound: number): number {
  return (rng() * 2 - 1) * bound
}

/**
 * Where stamp `seq` goes. Null only when every slot on its page is already
 * taken, which `seq`'s uniqueness makes unreachable; it is returned rather
 * than thrown so the caller can report it.
 */
export function placeStamp(input: {
  guestId: string
  seq: number
  /** Slots already taken on the page this stamp lands on. */
  usedSlots: readonly number[]
  textureSeed: number
}): Placement | null {
  const page = pageForSeq(input.seq)
  const template = templateFor(input.guestId, page)
  const free = template.slots
    .map((_, index) => index)
    .filter((index) => !input.usedSlots.includes(index))
  if (free.length === 0) return null

  const rng = mulberry32(input.textureSeed)
  const slot = free[Math.floor(rng() * free.length)]!
  const dx = Math.round(between(rng, JITTER_X))
  const dy = Math.round(between(rng, JITTER_Y))
  const wobble = between(rng, ROTATION_WOBBLE)
  const raw = template.slots[slot]!.rotation + wobble
  const clamped = Math.max(-MAX_ROTATION, Math.min(MAX_ROTATION, raw))
  // numeric(4, 2) on the row: round here so what is drawn now is what a
  // re-render reads back.
  const rotation = Math.round(clamped * 100) / 100
  return { page, slot, dx, dy, rotation }
}
