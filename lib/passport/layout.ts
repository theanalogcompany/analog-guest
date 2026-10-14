// TAC-586, TAC-587: which page, which slot, and how far off true. Pure: no
// I/O, no clock, no Math.random.
//
// TWELVE STAMPS TO A SPREAD, BOTH PAGES FILLING TOGETHER (TAC-587). A spread
// is two facing pages, (01–02), (03–04)…, with six slots each. Stamp n
// (1-based `seq`) lands on spread ⌈n/12⌉, on whichever of its two pages the
// seeded pick chooses. The guest is always sent the spread holding their
// newest stamp. Migration 086 holds the page to the spread.
//
// NEITHER PAGE MAY GET MORE THAN TWO STAMPS AHEAD OF THE OTHER (ruled
// 2026-10-14, TAC-587 Q1 = C). A pure pick over all twelve spots would, about
// once in 460 guests, put a guest's first six stamps on one page and leave its
// facing page blank. The rule never strands a stamp: whenever the spread has
// a free spot, the page that is behind has one. It governs where a NEW stamp
// goes, so it bounds a spread only from empty: one filled top-page-first
// under TAC-586 (six on page 01, then 07) keeps its lead, and every new stamp
// lands on the page that is behind until the two are within two.
//
// ALL RANDOMNESS COMES FROM THE ROW'S `texture_seed`. The slot, the jitter
// and the wobble are drawn here once, at insert, and stored on the row, so a
// later render reads them back instead of drawing them again. The renderer
// draws its own wear from the same seed through `wearRng`, a separate stream,
// so changing how many numbers layout draws can never shift the wear of a
// stamp already sent.
//
// THE PAGE TEMPLATE IS A FUNCTION OF (guest, page), by FNV-1a, so every stamp
// on one page agrees on the template without storing it. A row stores its
// slot index, not its coordinates, so this function is what keeps a sent
// stamp where it was drawn: it must never change for a page that already
// holds stamps. TAC-587 kept it keyed by page rather than by spread for that
// reason. Its one addition, the bottom page stepping to the next template
// when it would repeat the top page's, never fires on pages 01–08, so no page
// that held a stamp when it shipped changed. Why: the two keys of each pair
// differ only in their last character, by an odd XOR, and FNV-1a's odd
// multiplier keeps them different modulo 4, which is the template count. That
// argument needs a power-of-two count; passport-check holds the claim itself
// against TAC-586's rule for 10,000 guests.
//
// Rotation = the slot's own angle + a seeded wobble of ±3°, clamped to the
// stamp spec's −8°…+8°.

import { PAGE_TEMPLATES, type PageTemplate } from './templates'

export const STAMPS_PER_PAGE = 6
export const STAMPS_PER_SPREAD = STAMPS_PER_PAGE * 2
/** How far one page of a spread may run ahead of the other (TAC-587 Q1 = C). */
export const MAX_PAGE_LEAD = 2
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

/** The two facing pages stamp `seq` may land on: 1–12 → [1,2], 13 → [3,4]. */
export function pagesForSeq(seq: number): readonly [number, number] {
  const left = Math.floor((seq - 1) / STAMPS_PER_SPREAD) * 2 + 1
  return [left, left + 1]
}

/** The two facing pages that hold `page`: 1→[1,2], 2→[1,2], 3→[3,4]. */
export function spreadForPage(page: number): readonly [number, number] {
  const left = page % 2 === 1 ? page : page - 1
  return [left, left + 1]
}

function templateIndex(guestId: string, page: number): number {
  return fnv1a(`${guestId}:${page}`) % PAGE_TEMPLATES.length
}

export function templateFor(guestId: string, page: number): PageTemplate {
  let index = templateIndex(guestId, page)
  if (page % 2 === 0 && index === templateIndex(guestId, page - 1))
    index = (index + 1) % PAGE_TEMPLATES.length
  return PAGE_TEMPLATES[index]!
}

export type Placement = {
  page: number
  slot: number
  dx: number
  dy: number
  rotation: number
}

export type UsedSpot = { page: number; slot: number }

function between(rng: () => number, bound: number): number {
  return (rng() * 2 - 1) * bound
}

/**
 * The spots stamp `seq` may take: free, on its spread, and on a page that is
 * not already MAX_PAGE_LEAD stamps ahead of its facing page. Top page first,
 * slot order within a page, so the seeded pick is stable.
 */
export function eligibleSpots(input: {
  guestId: string
  seq: number
  used: readonly UsedSpot[]
}): UsedSpot[] {
  const pages = pagesForSeq(input.seq)
  const usedOn = pages.map((page) =>
    input.used.filter((spot) => spot.page === page).map((spot) => spot.slot),
  )
  const spots: UsedSpot[] = []
  pages.forEach((page, i) => {
    const lead = usedOn[i]!.length - usedOn[1 - i]!.length
    if (lead >= MAX_PAGE_LEAD) return
    templateFor(input.guestId, page).slots.forEach((_, slot) => {
      if (!usedOn[i]!.includes(slot)) spots.push({ page, slot })
    })
  })
  return spots
}

/**
 * Where stamp `seq` goes, given the spots already taken on its spread. Null
 * only when the spread is full, which `seq`'s uniqueness makes unreachable;
 * it is returned rather than thrown so the caller can report it.
 */
export function placeStamp(input: {
  guestId: string
  seq: number
  /** Spots already taken; any off this stamp's spread are ignored. */
  used: readonly UsedSpot[]
  textureSeed: number
}): Placement | null {
  const free = eligibleSpots(input)
  if (free.length === 0) return null

  const rng = mulberry32(input.textureSeed)
  const { page, slot } = free[Math.floor(rng() * free.length)]!
  const dx = Math.round(between(rng, JITTER_X))
  const dy = Math.round(between(rng, JITTER_Y))
  const wobble = between(rng, ROTATION_WOBBLE)
  const raw = templateFor(input.guestId, page).slots[slot]!.rotation + wobble
  const clamped = Math.max(-MAX_ROTATION, Math.min(MAX_ROTATION, raw))
  // numeric(4, 2) on the row: round here so what is drawn now is what a
  // re-render reads back.
  const rotation = Math.round(clamped * 100) / 100
  return { page, slot, dx, dy, rotation }
}
