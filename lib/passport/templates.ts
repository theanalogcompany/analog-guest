// TAC-586: where the six stamps on a passport page go.
//
// MEASURED, NOT DESIGNED. Templates A and B are the top and bottom pages of
// the reference spread in Figma, "Passport / pages 01–02 · 6 per page"
// (167:1632, page "Passport — final"). That frame is one flattened image, so
// there were no layers to read: each centre and angle was read off a 600×840
// render of it, to about ±6 px and ±2°. A′ and B′ are the same two pages
// mirrored left to right (x → 600 − x, angle negated), so four guests in a
// row do not all get the same page shape.
//
// The reference's two steepest stamps (CHAI LATTE and the INVITED box, about
// −11°) are entered at −8: the stamp spec allows −8° to +8° and no more
// (lib/passport/assets/stamp-spec.md).
//
// Units are 1x px, page-local: a page is 600×420, the top page of a spread
// sits at y 0 and the bottom page at y 420. Slot order is reading order and
// carries no meaning beyond being stable, because `slot` is stored.
//
// `scripts/harness/passport/` draws the reference's twelve stamps into A and
// B with no jitter and writes the result beside the Figma image. That
// side-by-side is the only check these numbers have.

export type Slot = {
  /** Centre, 1x px from the page's left edge. */
  cx: number
  /** Centre, 1x px from the page's top edge. */
  cy: number
  /** Degrees, clockwise positive. */
  rotation: number
}

export type PageTemplate = {
  name: string
  slots: readonly [Slot, Slot, Slot, Slot, Slot, Slot]
}

export const PAGE_WIDTH = 600
export const PAGE_HEIGHT = 420

const A: PageTemplate = {
  name: 'A',
  slots: [
    { cx: 145, cy: 113, rotation: 8 },
    { cx: 385, cy: 82, rotation: 2 },
    { cx: 262, cy: 218, rotation: 5 },
    { cx: 460, cy: 222, rotation: 5 },
    { cx: 125, cy: 330, rotation: -8 },
    { cx: 388, cy: 337, rotation: 4 },
  ],
}

const B: PageTemplate = {
  name: 'B',
  slots: [
    { cx: 125, cy: 100, rotation: 4 },
    { cx: 470, cy: 95, rotation: -3 },
    { cx: 272, cy: 155, rotation: 5 },
    { cx: 230, cy: 262, rotation: 4 },
    { cx: 460, cy: 285, rotation: -8 },
    { cx: 140, cy: 345, rotation: 7 },
  ],
}

function mirrored(template: PageTemplate, name: string): PageTemplate {
  const [s0, s1, s2, s3, s4, s5] = template.slots.map((slot) => ({
    cx: PAGE_WIDTH - slot.cx,
    cy: slot.cy,
    rotation: slot.rotation === 0 ? 0 : -slot.rotation,
  })) as [Slot, Slot, Slot, Slot, Slot, Slot]
  return { name, slots: [s0, s1, s2, s3, s4, s5] }
}

export const PAGE_TEMPLATES: readonly PageTemplate[] = [
  A,
  B,
  mirrored(A, 'A′'),
  mirrored(B, 'B′'),
]

/** The two reference pages, unmirrored, for the harness's side-by-side. */
export const REFERENCE_TEMPLATES = { top: A, bottom: B } as const
