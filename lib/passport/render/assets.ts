// TAC-586: the passport's files on disk, and the font metrics read from them.
//
// READ FROM DISK, SO NOTHING IMPORTS THEM. No `import` names a .ttf or a .png,
// so Next's file tracer would leave every one of them out of the deployed
// function. next.config.ts `outputFileTracingIncludes` carries
// `./lib/passport/assets/**` into the two routes that render: the Instagram
// webhook and /admin/health. A route missing from that list fails here with
// `asset_missing`, never with a half-drawn stamp, and the health row is what
// shows it.
//
// WHY THE METRICS ARE PARSED HERE. Text on a stamp is centred, shrunk to fit
// and placed by its centre line (stamp-spec.md: "All y values are text
// centres"), so its width and cap height have to be known before resvg draws
// it. They come from the font files themselves - advance widths from `hmtx`,
// cap height from `OS/2` - rather than from constants, so a swapped font file
// moves the layout with it instead of silently disagreeing with it. resvg is
// told `font-kerning: none` in every stamp SVG, which is what makes the sum of
// advances the width it actually draws.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PASSPORT_ASSETS_DIR = join(
  process.cwd(),
  'lib',
  'passport',
  'assets',
)

export type PassportFontId =
  'oswaldSemiBold' | 'oswaldMedium' | 'courierPrimeBold' | 'cutiveMono'

/** How each font is named in SVG: family + weight, as resvg's fontdb matches it. */
export const PASSPORT_FONTS = {
  oswaldSemiBold: {
    file: 'Oswald-SemiBold.ttf',
    family: 'Oswald',
    weight: 600,
  },
  oswaldMedium: { file: 'Oswald-Medium.ttf', family: 'Oswald', weight: 500 },
  courierPrimeBold: {
    file: 'CourierPrime-Bold.ttf',
    family: 'Courier Prime',
    weight: 700,
  },
  cutiveMono: {
    file: 'CutiveMono-Regular.ttf',
    family: 'Cutive Mono',
    weight: 400,
  },
} as const satisfies Record<
  PassportFontId,
  { file: string; family: string; weight: number }
>

export function fontPath(id: PassportFontId): string {
  return join(PASSPORT_ASSETS_DIR, 'fonts', PASSPORT_FONTS[id].file)
}

export function allFontPaths(): string[] {
  return (Object.keys(PASSPORT_FONTS) as PassportFontId[]).map(fontPath)
}

export const WORN_INK_TEXTURE_FILE = 'worn-ink-texture.png'

/** A background file name from venue settings: one file in the assets dir, no paths. */
const BACKGROUND_FILE_RE = /^[a-z0-9@._-]+\.png$/

export type AssetResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'asset_missing' | 'asset_name_invalid'; detail: string }

export function resolveBackgroundPath(file: string): AssetResult<string> {
  if (!BACKGROUND_FILE_RE.test(file))
    return { ok: false, error: 'asset_name_invalid', detail: file }
  const path = join(PASSPORT_ASSETS_DIR, file)
  if (!existsSync(path))
    return { ok: false, error: 'asset_missing', detail: file }
  return { ok: true, data: path }
}

export function textureFilePath(): string {
  return join(PASSPORT_ASSETS_DIR, WORN_INK_TEXTURE_FILE)
}

// ---------------------------------------------------------------------------
// Font metrics
// ---------------------------------------------------------------------------

export type FontMetrics = {
  unitsPerEm: number
  capHeight: number
  /** Advance width in font units, by code point. Missing glyphs map to the .notdef advance. */
  advance: (codePoint: number) => number
  hasGlyph: (codePoint: number) => boolean
}

function tableOffsets(font: Buffer): Map<string, number> {
  const count = font.readUInt16BE(4)
  const out = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    const record = 12 + 16 * i
    out.set(
      font.toString('latin1', record, record + 4),
      font.readUInt32BE(record + 8),
    )
  }
  return out
}

/** cmap format 4 (BMP) lookup: code point → glyph id, 0 when absent. */
function format4Lookup(
  font: Buffer,
  cmapOffset: number,
): (cp: number) => number {
  const subtables = font.readUInt16BE(cmapOffset + 2)
  for (let i = 0; i < subtables; i++) {
    const record = cmapOffset + 4 + 8 * i
    const platform = font.readUInt16BE(record)
    const encoding = font.readUInt16BE(record + 2)
    const start = cmapOffset + font.readUInt32BE(record + 4)
    if (platform !== 3 || encoding !== 1) continue
    if (font.readUInt16BE(start) !== 4) continue
    const segX2 = font.readUInt16BE(start + 6)
    const ends = start + 14
    const starts = ends + segX2 + 2
    const deltas = starts + segX2
    const rangeOffsets = deltas + segX2
    return (cp: number) => {
      for (let s = 0; s < segX2; s += 2) {
        const end = font.readUInt16BE(ends + s)
        if (cp > end) continue
        const first = font.readUInt16BE(starts + s)
        if (cp < first) return 0
        const delta = font.readInt16BE(deltas + s)
        const rangeOffset = font.readUInt16BE(rangeOffsets + s)
        if (rangeOffset === 0) return (cp + delta) & 0xffff
        const glyphAt = rangeOffsets + s + rangeOffset + 2 * (cp - first)
        const glyph = font.readUInt16BE(glyphAt)
        return glyph === 0 ? 0 : (glyph + delta) & 0xffff
      }
      return 0
    }
  }
  return () => 0
}

export function parseFontMetrics(font: Buffer): FontMetrics {
  const tables = tableOffsets(font)
  const head = tables.get('head')
  const hhea = tables.get('hhea')
  const hmtx = tables.get('hmtx')
  const os2 = tables.get('OS/2')
  const cmap = tables.get('cmap')
  if (
    head === undefined ||
    hhea === undefined ||
    hmtx === undefined ||
    os2 === undefined ||
    cmap === undefined
  ) {
    throw new Error('font is missing a required table')
  }
  const unitsPerEm = font.readUInt16BE(head + 18)
  const longMetrics = font.readUInt16BE(hhea + 34)
  const capHeight = font.readInt16BE(os2 + 88)
  const glyphFor = format4Lookup(font, cmap)
  const advanceOf = (glyph: number) =>
    font.readUInt16BE(hmtx + 4 * Math.min(glyph, longMetrics - 1))
  return {
    unitsPerEm,
    capHeight,
    advance: (cp) => advanceOf(glyphFor(cp)),
    hasGlyph: (cp) => glyphFor(cp) !== 0,
  }
}

const metricsCache = new Map<PassportFontId, FontMetrics>()

/** Throws only if a bundled font is missing or corrupt; callers catch at their boundary. */
export function fontMetrics(id: PassportFontId): FontMetrics {
  const cached = metricsCache.get(id)
  if (cached !== undefined) return cached
  const metrics = parseFontMetrics(readFileSync(fontPath(id)))
  metricsCache.set(id, metrics)
  return metrics
}
