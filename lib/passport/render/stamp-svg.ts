// TAC-586, TAC-587: one stamp as SVG, in 1x units. Pure apart from the font
// metrics it is handed.
//
// THE GEOMETRY IS lib/passport/assets/stamp-spec.md, number for number: sizes,
// stroke widths, insets, font sizes, letter-spacing, the y of every line. Where
// that file and the Figma spec block (161:1632) differ, the file wins (ruled
// 2026-10-14). TAC-587's time lines and VISIT layout are Figma section 08
// (181:1633), stars kept: the drawing lost them only because its font has no
// ★ (ruled 2026-10-14). A number here that is not in the spec says why beside
// it.
//
// TEXT IS PLACED BY ITS CENTRE, as the spec gives it. A line is drawn
// start-anchored at `cx - width / 2`, with its baseline at `cy` plus half the
// font's cap height: every line on a stamp is capitals, so the cap height is
// the height that is centred. Width is the sum of advances plus the
// letter-spacing between glyphs, which is exactly what resvg draws because
// every <text> carries `font-kerning="none"`. Start-anchoring is deliberate:
// SVG letter-spacing also trails the LAST glyph, which would pull a
// middle-anchored line off centre by half a gap.
//
// ★ IS DRAWN, NOT TYPESET. None of the bundled fonts has U+2605, and with
// system fonts off resvg would draw nothing in its place. The star is a
// five-point polygon as tall as the cap height of Oswald Medium at the size
// the spec names for it.
//
// SHRINK-TO-FIT. The spec shrinks VISIT's venue (to 104), DISCOVERED's item
// (26, then 21 past 12 characters, then to fit 200), and the three lines that
// carry the time: ARRIVED's date line (160), DISCOVERED's bottom line (212)
// and INVITED's (186). Every other line that carries a fill-in - ARRIVED's
// venue and city, VISIT's city, the perk - also shrinks to fit inside its
// border less 16, decided at TAC-586's plan time: a longer venue name would
// otherwise run off the stamp.

import type { StampKind } from '../decide'

import { type FontMetrics, type PassportFontId, PASSPORT_FONTS } from './assets'

export const STAMP_SIZES = {
  arrived: { width: 250, height: 156 },
  visit: { width: 150, height: 150 },
  discovered: { width: 240, height: 118 },
  invited: { width: 210, height: 150 },
} as const satisfies Record<StampKind, { width: number; height: number }>

export const STAMP_INKS = {
  arrived: '#A85638',
  visit: '#1C1814',
  discovered: '#7C8C63',
  invited: '#5C3F26',
} as const satisfies Record<StampKind, string>

/** Transparent margin around the rotated stamp, 1x. 24 px at 2x. */
export const STAMP_CANVAS_MARGIN = 12

export type StampFace = {
  kind: StampKind
  /** DISCOVERED: the item. INVITED: the perk line. Null otherwise. */
  label: string | null
  /** Already formatted: `30 OCT 2026`. */
  date: string
  /** Already formatted, venue-local: `1:22 PM`. */
  time: string
  /** As printed: `LE MIL'S COFFEE`. */
  venueName: string
  /** ARRIVED's city: `S.F.` */
  cityShort: string
  /** VISIT's city: `SAN FRANCISCO` */
  cityLong: string
}

export type MetricsFor = (font: PassportFontId) => FontMetrics

type Line = {
  text: string
  font: PassportFontId
  size: number
  /** em fraction: the spec's "letter-spacing 6%" is 0.06. */
  spacing: number
  cx: number
  cy: number
  maxWidth?: number
}

export function upper(text: string): string {
  return text.toLocaleUpperCase('en-US')
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function codePoints(text: string): number[] {
  return Array.from(text, (ch) => ch.codePointAt(0) ?? 0)
}

/** Drawn width of `text` at `size` px with `spacing` em between glyphs. */
export function lineWidth(
  metrics: FontMetrics,
  text: string,
  size: number,
  spacing: number,
): number {
  const cps = codePoints(text)
  if (cps.length === 0) return 0
  const advances = cps.reduce((sum, cp) => sum + metrics.advance(cp), 0)
  return (
    (advances * size) / metrics.unitsPerEm + spacing * size * (cps.length - 1)
  )
}

function fitSize(metrics: FontMetrics, line: Line): number {
  if (line.maxWidth === undefined) return line.size
  const width = lineWidth(metrics, line.text, line.size, line.spacing)
  return width <= line.maxWidth
    ? line.size
    : (line.size * line.maxWidth) / width
}

function round(value: number): string {
  return (Math.round(value * 1000) / 1000).toString()
}

function textElement(metricsFor: MetricsFor, line: Line, fill: string): string {
  const metrics = metricsFor(line.font)
  const size = fitSize(metrics, line)
  const width = lineWidth(metrics, line.text, size, line.spacing)
  const baseline =
    line.cy + (metrics.capHeight / metrics.unitsPerEm) * size * 0.5
  const font = PASSPORT_FONTS[line.font]
  return (
    `<text x="${round(line.cx - width / 2)}" y="${round(baseline)}" ` +
    `font-family="${font.family}" font-weight="${font.weight}" ` +
    `font-size="${round(size)}" letter-spacing="${round(line.spacing * size)}" ` +
    `font-kerning="none" fill="${fill}">${escapeXml(line.text)}</text>`
  )
}

/** A five-point star centred on (cx, cy), as tall as Oswald Medium's caps at `size`. */
function star(
  metricsFor: MetricsFor,
  cx: number,
  cy: number,
  size: number,
  fill: string,
): string {
  const metrics = metricsFor('oswaldMedium')
  const height = (metrics.capHeight / metrics.unitsPerEm) * size
  // A regular star's height is R(1 + cos 36°); its inner radius is 0.382 R.
  const outer = height / (1 + Math.cos(Math.PI / 5))
  const inner = outer * 0.382
  // Centre the drawn height on cy, not the circumcentre.
  const top = cy - height / 2
  const ox = cx
  const oy = top + outer
  const points: string[] = []
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner
    const angle = -Math.PI / 2 + (i * Math.PI) / 5
    points.push(
      `${round(ox + r * Math.cos(angle))},${round(oy + r * Math.sin(angle))}`,
    )
  }
  return `<polygon points="${points.join(' ')}" fill="${fill}"/>`
}

function rule(
  x1: number,
  x2: number,
  y: number,
  width: number,
  ink: string,
): string {
  return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${ink}" stroke-width="${width}"/>`
}

function arrivedBody(face: StampFace, m: MetricsFor, ink: string): string {
  const { width: w, height: h } = STAMP_SIZES.arrived
  const outerRx = w / 2 - 3.4 / 2
  const outerRy = h / 2 - 3.4 / 2
  // "inset 10/9": the inner oval sits 10 in from the outer horizontally, 9 vertically.
  const innerRx = outerRx - 10
  const innerRy = outerRy - 9
  // The bottom line's room is the inner oval's chord at y=122, less 16.
  const chordHalf = innerRx * Math.sqrt(1 - ((122 - h / 2) / innerRy) ** 2)
  return [
    `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${round(outerRx)}" ry="${round(outerRy)}" fill="none" stroke="${ink}" stroke-width="3.4"/>`,
    `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${round(innerRx)}" ry="${round(innerRy)}" fill="none" stroke="${ink}" stroke-width="1.2" stroke-dasharray="5 4"/>`,
    textElement(
      m,
      {
        text: 'ARRIVED',
        font: 'oswaldSemiBold',
        size: 34,
        spacing: 0.06,
        cx: w / 2,
        cy: 50,
      },
      ink,
    ),
    rule(40, 210, 74, 1.6, ink),
    rule(40, 210, 104, 1.6, ink),
    textElement(
      m,
      {
        text: `${upper(face.date)} · ${face.time}`,
        font: 'courierPrimeBold',
        size: 13,
        spacing: 0,
        cx: w / 2,
        cy: 89,
        maxWidth: 160,
      },
      ink,
    ),
    star(m, 26, 89, 10, ink),
    star(m, 224, 89, 10, ink),
    textElement(
      m,
      {
        text: `${upper(face.venueName)} · ${upper(face.cityShort)}`,
        font: 'oswaldMedium',
        size: 10,
        spacing: 0.14,
        cx: w / 2,
        cy: 122,
        maxWidth: chordHalf * 2 - 16,
      },
      ink,
    ),
  ].join('')
}

function visitBody(face: StampFace, m: MetricsFor, ink: string): string {
  const { width: w } = STAMP_SIZES.visit
  const c = w / 2
  const outerR = c - 3 / 2
  const innerR = outerR - 9
  // SAN FRANCISCO's room is the inner ring's chord at y=106, less 16.
  const chordHalf = Math.sqrt(innerR ** 2 - (106 - c) ** 2)
  return [
    `<circle cx="${c}" cy="${c}" r="${outerR}" fill="none" stroke="${ink}" stroke-width="3"/>`,
    `<circle cx="${c}" cy="${c}" r="${innerR}" fill="none" stroke="${ink}" stroke-width="1.1"/>`,
    textElement(
      m,
      {
        text: 'VISITED',
        font: 'oswaldSemiBold',
        size: 9,
        spacing: 0.45,
        cx: c,
        cy: 29,
      },
      ink,
    ),
    textElement(
      m,
      {
        text: upper(face.venueName),
        font: 'oswaldSemiBold',
        size: 15,
        spacing: 0.03,
        cx: c,
        cy: 45,
        maxWidth: 104,
      },
      ink,
    ),
    rule(26, 124, 58, 1.4, ink),
    rule(26, 124, 93, 1.4, ink),
    textElement(
      m,
      {
        text: upper(face.date),
        font: 'courierPrimeBold',
        size: 14,
        spacing: 0,
        cx: c,
        cy: 70,
      },
      ink,
    ),
    textElement(
      m,
      {
        text: face.time,
        font: 'courierPrimeBold',
        size: 10.5,
        spacing: 0,
        cx: c,
        cy: 83,
      },
      ink,
    ),
    textElement(
      m,
      {
        text: upper(face.cityLong),
        font: 'oswaldMedium',
        size: 8,
        spacing: 0.14,
        cx: c,
        cy: 106,
        maxWidth: chordHalf * 2 - 16,
      },
      ink,
    ),
    star(m, c, 121, 9, ink),
  ].join('')
}

function discoveredBody(face: StampFace, m: MetricsFor, ink: string): string {
  const { width: w, height: h } = STAMP_SIZES.discovered
  const outerInset = 3 / 2
  const innerInset = outerInset + 7
  const innerWidth = w - innerInset * 2
  const item = upper(face.label ?? '')
  return [
    `<rect x="${outerInset}" y="${outerInset}" width="${w - outerInset * 2}" height="${h - outerInset * 2}" rx="6" fill="none" stroke="${ink}" stroke-width="3"/>`,
    `<rect x="${innerInset}" y="${innerInset}" width="${innerWidth}" height="${h - innerInset * 2}" rx="3" fill="none" stroke="${ink}" stroke-width="1.2"/>`,
    textElement(
      m,
      {
        text: 'DISCOVERED',
        font: 'oswaldSemiBold',
        size: 13,
        spacing: 0.4,
        cx: w / 2,
        cy: 25,
      },
      ink,
    ),
    rule(30, 210, 39, 1.4, ink),
    rule(30, 210, 82, 1.4, ink),
    textElement(
      m,
      {
        text: item,
        font: 'oswaldSemiBold',
        size: Array.from(item).length > 12 ? 21 : 26,
        spacing: 0.03,
        cx: w / 2,
        cy: 61,
        maxWidth: 200,
      },
      ink,
    ),
    textElement(
      m,
      {
        text: `${upper(face.date)} · ${face.time} · ${upper(face.venueName)}`,
        font: 'courierPrimeBold',
        size: 10.5,
        spacing: 0,
        cx: w / 2,
        cy: 97,
        maxWidth: 212,
      },
      ink,
    ),
  ].join('')
}

function invitedBody(face: StampFace, m: MetricsFor, ink: string): string {
  const { width: w, height: h } = STAMP_SIZES.invited
  const inset = 2.8 / 2
  const innerWidth = w - inset * 2
  // The band's knockout is a mask: white keeps the band, the black text cuts
  // it, so the paper shows through the letters rather than a paper-coloured
  // fill sitting on top of them.
  const knockout = textElement(
    m,
    {
      text: 'INVITED',
      font: 'oswaldSemiBold',
      size: 15,
      spacing: 0.5,
      cx: w / 2,
      cy: 16,
    },
    '#000',
  )
  return [
    `<defs><mask id="invited-knockout" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">`,
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#fff"/>${knockout}</mask></defs>`,
    `<rect x="${inset}" y="${inset}" width="${innerWidth}" height="32" fill="${ink}" mask="url(#invited-knockout)"/>`,
    `<rect x="${inset}" y="${inset}" width="${innerWidth}" height="${h - inset * 2}" rx="3" fill="none" stroke="${ink}" stroke-width="2.8"/>`,
    textElement(
      m,
      {
        text: 'BY THE HOUSE',
        font: 'oswaldSemiBold',
        size: 25,
        spacing: 0.05,
        cx: w / 2,
        cy: 63,
      },
      ink,
    ),
    textElement(
      m,
      {
        text: upper(face.label ?? ''),
        font: 'oswaldMedium',
        size: 11,
        spacing: 0.26,
        cx: w / 2,
        cy: 92,
        maxWidth: innerWidth - 16,
      },
      ink,
    ),
    rule(20, 190, 107, 1.3, ink),
    textElement(
      m,
      {
        text: `${upper(face.date)} · ${face.time} · ${upper(face.venueName)}`,
        font: 'courierPrimeBold',
        size: 10.5,
        spacing: 0,
        cx: w / 2,
        cy: 127,
        maxWidth: 186,
      },
      ink,
    ),
  ].join('')
}

const BODIES = {
  arrived: arrivedBody,
  visit: visitBody,
  discovered: discoveredBody,
  invited: invitedBody,
} as const satisfies Record<
  StampKind,
  (face: StampFace, m: MetricsFor, ink: string) => string
>

/** The canvas a stamp tilted by `rotation` degrees needs, 1x, margin included. */
export function stampCanvas(
  kind: StampKind,
  rotation: number,
): { width: number; height: number } {
  const { width, height } = STAMP_SIZES[kind]
  const rad = (Math.abs(rotation) * Math.PI) / 180
  const w = width * Math.cos(rad) + height * Math.sin(rad)
  const h = width * Math.sin(rad) + height * Math.cos(rad)
  return {
    width: Math.ceil(w + STAMP_CANVAS_MARGIN * 2),
    height: Math.ceil(h + STAMP_CANVAS_MARGIN * 2),
  }
}

/**
 * The stamp, tilted by `rotation` about its centre, on a transparent canvas
 * just large enough to hold it. Every mark is the kind's ink; wear is applied
 * afterwards, to the raster.
 */
export function buildStampSvg(
  face: StampFace,
  rotation: number,
  metricsFor: MetricsFor,
): { svg: string; width: number; height: number } {
  const { width, height } = STAMP_SIZES[face.kind]
  const canvas = stampCanvas(face.kind, rotation)
  const ink = STAMP_INKS[face.kind]
  const body = BODIES[face.kind](face, metricsFor, ink)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">` +
    `<g transform="translate(${canvas.width / 2} ${canvas.height / 2}) rotate(${rotation}) translate(${-width / 2} ${-height / 2})">` +
    body +
    `</g></svg>`
  return { svg, width: canvas.width, height: canvas.height }
}
