// TAC-586: one stamp, rendered: a transparent PNG at 2x, tilted, worn.
//
// Three steps, in this order:
//   1. resvg draws the SVG from stamp-svg.ts at 2x, tilt included, with the
//      bundled fonts only (`loadSystemFonts: false`, so a missing font is a
//      visible gap here, never a silent substitute on one machine).
//   2. Wear, per stamp-spec.md: the ink's alpha is multiplied by a seeded
//      crop and rotation of the worn-ink texture, then by a linear pressure
//      fade from 100% down to a seeded 74–82% at a seeded angle.
//   3. Every pixel's colour is set to the kind's one ink. The stamp is one
//      flat colour; only its alpha carries the drawing and the wear. Working
//      from alpha alone also sidesteps whether resvg's buffer is
//      premultiplied: alpha is the same either way.
//
// DETERMINISTIC ON ONE RUNTIME. Every choice above comes from
// `wearRng(texture_seed)`, the tilt comes from the row, and the PNG encoder
// runs with fixed options and no metadata. The texture's arbitrary-angle
// rotation resamples, which is exact for a given libvips build; the
// acceptance criterion is a re-render on the same runtime, and the harness
// and the /admin/health row both check it there. Across machines (macOS
// against Vercel's Linux) a pixel may differ by rounding, which is why the
// harness's goldens carry a small tolerance and its re-render check none.
//
// Never throws. A failure names its stage.

import { readFileSync } from 'node:fs'

import type { ResvgRenderOptions } from '@resvg/resvg-js'

import { wearRng } from '../layout'

import { allFontPaths, fontMetrics, textureFilePath } from './assets'
import { loadNative, type NativeLibs } from './native'
import { buildStampSvg, STAMP_INKS, type StampFace } from './stamp-svg'

export const RENDER_SCALE = 2

export const PNG_OPTIONS = {
  compressionLevel: 9,
  adaptiveFiltering: false,
  palette: false,
} as const

export type RenderStage =
  'native' | 'svg' | 'raster' | 'texture' | 'encode' | 'background'

export type RenderResult<T> =
  { ok: true; data: T } | { ok: false; stage: RenderStage; error: string }

export type RenderedStamp = {
  png: Buffer
  /** Pixels, at 2x. */
  width: number
  height: number
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** resvg options shared by every passport render. */
export function resvgOptions(scale: number): ResvgRenderOptions {
  return {
    fitTo: { mode: 'zoom', value: scale },
    font: {
      fontFiles: allFontPaths(),
      loadSystemFonts: false,
      defaultFontFamily: 'Courier Prime',
    },
    shapeRendering: 2,
    textRendering: 2,
    logLevel: 'off',
  }
}

let textureCache: Buffer | null = null

function loadTexture(): Buffer {
  textureCache ??= readFileSync(textureFilePath())
  return textureCache
}

/**
 * A width × height greyscale window of the texture: rotated by a seeded
 * angle, then cropped at a seeded offset from inside the rotated square, so
 * the corners the rotation fills are never part of it.
 */
async function textureWindow(
  sharp: NativeLibs['sharp'],
  rng: () => number,
  width: number,
  height: number,
): Promise<Buffer> {
  const angle = rng() * 360
  const rotated = await sharp(loadTexture())
    .greyscale()
    .rotate(angle, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rad = (angle * Math.PI) / 180
  const source = 1024
  const side = Math.floor(
    source / (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad))),
  )
  if (width > side || height > side)
    throw new Error(
      `stamp ${width}x${height} is larger than the texture's ${side}px window`,
    )
  const left = Math.floor(
    rotated.info.width / 2 - side / 2 + rng() * (side - width),
  )
  const top = Math.floor(
    rotated.info.height / 2 - side / 2 + rng() * (side - height),
  )
  return sharp(rotated.data, {
    raw: {
      width: rotated.info.width,
      height: rotated.info.height,
      channels: rotated.info.channels,
    },
  })
    .extract({ left, top, width, height })
    .extractChannel(0)
    .raw()
    .toBuffer()
}

function inkRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

export async function renderStamp(
  face: StampFace,
  wear: { textureSeed: number; rotation: number },
): Promise<RenderResult<RenderedStamp>> {
  const native = await loadNative()
  if (!native.ok) return { ok: false, stage: 'native', error: native.error }
  const { sharp, Resvg } = native.data

  let svg: string
  try {
    svg = buildStampSvg(face, wear.rotation, fontMetrics).svg
  } catch (e) {
    return { ok: false, stage: 'svg', error: message(e) }
  }

  let alpha: Buffer
  let width: number
  let height: number
  try {
    const rendered = new Resvg(svg, resvgOptions(RENDER_SCALE)).render()
    width = rendered.width
    height = rendered.height
    const pixels = rendered.pixels
    alpha = Buffer.alloc(width * height)
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3]!
  } catch (e) {
    return { ok: false, stage: 'raster', error: message(e) }
  }

  const rng = wearRng(wear.textureSeed)
  let texture: Buffer
  try {
    texture = await textureWindow(sharp, rng, width, height)
  } catch (e) {
    return { ok: false, stage: 'texture', error: message(e) }
  }

  // The pressure fade: full ink on one side, a seeded 74–82% on the other,
  // along a seeded direction across the stamp.
  const floor = 0.74 + rng() * 0.08
  const direction = rng() * Math.PI * 2
  const ux = Math.cos(direction)
  const uy = Math.sin(direction)
  const extent = Math.abs(width * ux) + Math.abs(height * uy)
  const [r, g, b] = inkRgb(STAMP_INKS[face.kind])
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const along =
        ((x - width / 2) * ux + (y - height / 2) * uy) / extent + 0.5
      const t = Math.min(1, Math.max(0, along))
      const pressure = 1 - (1 - floor) * t
      const a = (alpha[i]! * texture[i]! * pressure) / 255
      out[i * 4] = r
      out[i * 4 + 1] = g
      out[i * 4 + 2] = b
      out[i * 4 + 3] = Math.round(a)
    }
  }

  try {
    const png = await sharp(out, { raw: { width, height, channels: 4 } })
      .png(PNG_OPTIONS)
      .toBuffer()
    return { ok: true, data: { png, width, height } }
  } catch (e) {
    return { ok: false, stage: 'encode', error: message(e) }
  }
}
