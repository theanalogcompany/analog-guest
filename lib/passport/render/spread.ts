// TAC-586: the open passport - two facing pages, stacked - with every stamp
// on them.
//
// THE BACKGROUND IS THE VENUE'S OWN FILE (ruled 2026-10-14: the crest makes
// it per venue), named in venue settings and kept exactly as exported:
// 1200×1680, two 600×840@2x pages, top page at y 0 and bottom at y 840, with
// TRANSPARENT ROUNDED CORNERS. The passport goes out on a transparent
// background, so its alpha is the passport's outline and is restored, pixel
// for pixel, as the last step. That also clips ink: a stamp near the edge
// never prints onto the transparent corners.
//
// DRAWN ON IT, in this order:
//   1. The page header and the page numbers, Cutive Mono 18 px, #857A6A
//      (ruled 2026-10-14). The header is the venue name, left-aligned at
//      x=80; the number is two digits, right-aligned at x=1120. Both have
//      their TEXT-BOX TOP at y=72 and y=912, which is Figma's measure: in the
//      numbered preview (172:1632) the capitals sit at y 77–86 and 917–926,
//      so the baseline is the top plus 15.
//   2. Every stamp on these two pages, in `seq` order so the newest is on
//      top, each blended `multiply` as ink on paper is, at its stored slot,
//      jitter and tilt.

import type { OverlayOptions } from 'sharp'

import { templateFor } from '../layout'

import { fontMetrics, PASSPORT_FONTS, resolveBackgroundPath } from './assets'
import { loadNative } from './native'
import {
  PNG_OPTIONS,
  type RenderResult,
  RENDER_SCALE,
  renderStamp,
  resvgOptions,
} from './stamp'
import { escapeXml, lineWidth, type StampFace, upper } from './stamp-svg'

export const SPREAD_WIDTH = 1200
export const SPREAD_HEIGHT = 1680
const PAGE_HEIGHT_PX = 840

const HEADER_COLOUR = '#857A6A'
const HEADER_SIZE = 18
const HEADER_LEFT = 80
const NUMBER_RIGHT = 1120
const TEXT_TOPS = [72, 912] as const
/** Text-box top to baseline, measured from 172:1632. */
const BASELINE_FROM_TOP = 15

/** Room around the pages so a stamp hanging off an edge composites cleanly. */
const PAD = 400

export type PlacedStamp = {
  seq: number
  guestId: string
  page: number
  slot: number
  dx: number
  dy: number
  rotation: number
  textureSeed: number
  face: StampFace
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function pageNumberLabel(page: number): string {
  return page.toString().padStart(2, '0')
}

function headerSvg(
  venueName: string,
  pages: readonly [number, number],
): string {
  const font = PASSPORT_FONTS.cutiveMono
  const metrics = fontMetrics('cutiveMono')
  const text = (x: number, top: number, value: string) =>
    `<text x="${x}" y="${top + BASELINE_FROM_TOP}" font-family="${font.family}" ` +
    `font-weight="${font.weight}" font-size="${HEADER_SIZE}" font-kerning="none" ` +
    `fill="${HEADER_COLOUR}">${escapeXml(value)}</text>`
  const parts: string[] = []
  pages.forEach((page, index) => {
    const top = TEXT_TOPS[index]!
    const number = pageNumberLabel(page)
    const numberWidth = lineWidth(metrics, number, HEADER_SIZE, 0)
    parts.push(text(HEADER_LEFT, top, upper(venueName)))
    parts.push(text(NUMBER_RIGHT - numberWidth, top, number))
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SPREAD_WIDTH}" height="${SPREAD_HEIGHT}" ` +
    `viewBox="0 0 ${SPREAD_WIDTH} ${SPREAD_HEIGHT}">${parts.join('')}</svg>`
  )
}

export async function renderSpread(input: {
  pages: readonly [number, number]
  venueName: string
  /** The venue's background file, from settings. */
  background: string
  stamps: readonly PlacedStamp[]
}): Promise<RenderResult<{ png: Buffer }>> {
  const native = await loadNative()
  if (!native.ok) return { ok: false, stage: 'native', error: native.error }
  const { sharp, Resvg } = native.data

  const backgroundPath = resolveBackgroundPath(input.background)
  if (!backgroundPath.ok)
    return {
      ok: false,
      stage: 'background',
      error: `${backgroundPath.error}: ${backgroundPath.detail}`,
    }

  let paper: Buffer
  try {
    const raw = await sharp(backgroundPath.data)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (raw.info.width !== SPREAD_WIDTH || raw.info.height !== SPREAD_HEIGHT) {
      return {
        ok: false,
        stage: 'background',
        error: `background is ${raw.info.width}x${raw.info.height}, not ${SPREAD_WIDTH}x${SPREAD_HEIGHT}`,
      }
    }
    paper = raw.data
  } catch (e) {
    return { ok: false, stage: 'background', error: message(e) }
  }

  let header: Buffer
  try {
    header = new Resvg(headerSvg(input.venueName, input.pages), resvgOptions(1))
      .render()
      .asPng()
  } catch (e) {
    return { ok: false, stage: 'raster', error: message(e) }
  }

  const onSpread = input.stamps
    .filter((stamp) => input.pages.includes(stamp.page))
    .sort((a, b) => a.seq - b.seq)
  const layers: OverlayOptions[] = []
  for (const stamp of onSpread) {
    const rendered = await renderStamp(stamp.face, {
      textureSeed: stamp.textureSeed,
      rotation: stamp.rotation,
    })
    if (!rendered.ok) return rendered
    const slot = templateFor(stamp.guestId, stamp.page).slots[stamp.slot]
    if (slot === undefined)
      return {
        ok: false,
        stage: 'svg',
        error: `slot ${stamp.slot} out of range`,
      }
    const pageTop = stamp.page === input.pages[0] ? 0 : PAGE_HEIGHT_PX
    const x = (slot.cx + stamp.dx) * RENDER_SCALE
    const y = (slot.cy + stamp.dy) * RENDER_SCALE + pageTop
    layers.push({
      input: rendered.data.png,
      left: PAD + Math.round(x - rendered.data.width / 2),
      top: PAD + Math.round(y - rendered.data.height / 2),
      blend: 'multiply',
    })
  }

  // ONE OPERATION PER PIPELINE. sharp runs `composite` after every other
  // operation in a pipeline whatever order the calls are written in, so a
  // header composited "before" an extend would land PAD pixels off, and an
  // extract "after" the stamps would cut before they were drawn.
  try {
    const raw = {
      width: SPREAD_WIDTH,
      height: SPREAD_HEIGHT,
      channels: 4,
    } as const
    const headed = await sharp(paper, { raw })
      .composite([{ input: header, left: 0, top: 0 }])
      .png()
      .toBuffer()
    const padded = await sharp(headed)
      .extend({
        top: PAD,
        bottom: PAD,
        left: PAD,
        right: PAD,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer()
    const inked = await sharp(padded).composite(layers).png().toBuffer()
    const composed = await sharp(inked)
      .extract({
        left: PAD,
        top: PAD,
        width: SPREAD_WIDTH,
        height: SPREAD_HEIGHT,
      })
      .ensureAlpha()
      .raw()
      .toBuffer()
    // The paper's own alpha, restored: the passport's outline, and the clip
    // that keeps ink off the transparent corners.
    for (let i = 3; i < composed.length; i += 4) composed[i] = paper[i]!
    const png = await sharp(composed, { raw }).png(PNG_OPTIONS).toBuffer()
    return { ok: true, data: { png } }
  } catch (e) {
    return { ok: false, stage: 'encode', error: message(e) }
  }
}
