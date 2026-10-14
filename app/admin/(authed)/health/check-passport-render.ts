// The /admin/health row for the passport renderer (TAC-586).
//
// WHY THIS EXISTS. A stamp is drawn by two native libraries (resvg, sharp)
// from fonts and images read off disk, and each of those reaches a deployment
// by a step that can fail without failing a build: the platform binary in the
// lockfile, and next.config.ts carrying lib/passport/assets/ into the
// function. When one is missing nothing breaks loudly: the webhook still
// answers 200 and the guest simply gets no stamp. This row is how that is
// noticed before a guest notices it.
//
// IT RENDERS, TWICE. "Is the file there" is not the question; the question is
// whether a passport draws on this machine, and whether drawing it again
// gives the same pixels, which is the passport's own acceptance criterion
// (re-rendering a stored stamp is pixel-identical). One spread holding one
// stamp, on the shipped page background, so the fonts, the texture, the
// background and both libraries are all exercised; raw pixels hashed.
//
// The libraries are loaded lazily (lib/passport/render/native.ts), so a
// missing binary is this row turning red, not the whole page failing.
//
// Never throws.

import { createHash } from 'node:crypto'

import { loadNative } from '@/lib/passport/render/native'
import { renderSpread } from '@/lib/passport/render/spread'

export interface CheckPassportRenderRow {
  label: 'Passport renderer'
  detail: string
  tone: 'good' | 'neutral' | 'bad'
}

const FIXTURE = {
  pages: [1, 2] as const,
  venueName: 'HEALTH CHECK',
  background: 'page-background-no-header@2x.png',
  stamps: [
    {
      seq: 1,
      guestId: 'health-check',
      page: 1,
      slot: 0,
      dx: 0,
      dy: 0,
      rotation: -4,
      textureSeed: 586,
      face: {
        kind: 'discovered' as const,
        label: 'Oat Cortado',
        date: '30 OCT 2026',
        venueName: 'HEALTH CHECK',
        cityShort: 'S.F.',
        cityLong: 'SAN FRANCISCO',
      },
    },
  ],
}

async function renderedHash(): Promise<
  { ok: true; hash: string } | { ok: false; error: string }
> {
  const native = await loadNative()
  if (!native.ok) return { ok: false, error: `native: ${native.error}` }
  const rendered = await renderSpread(FIXTURE)
  if (!rendered.ok)
    return { ok: false, error: `${rendered.stage}: ${rendered.error}` }
  const raw = await native.data.sharp(rendered.data.png).raw().toBuffer()
  return { ok: true, hash: createHash('sha256').update(raw).digest('hex') }
}

export async function checkPassportRender(): Promise<CheckPassportRenderRow> {
  const label = 'Passport renderer'
  try {
    const started = Date.now()
    const first = await renderedHash()
    if (!first.ok)
      return {
        label,
        detail: `Not rendering — ${first.error}. Bound scans are getting no stamp.`,
        tone: 'bad',
      }
    const ms = Date.now() - started
    const second = await renderedHash()
    if (!second.ok)
      return {
        label,
        detail: `Second render failed — ${second.error}`,
        tone: 'bad',
      }
    if (second.hash !== first.hash)
      return {
        label,
        detail:
          'Renders, but not identically twice — stored stamps will not re-draw the same.',
        tone: 'bad',
      }
    return {
      label,
      detail: `Renders, identical twice (${ms} ms, ${first.hash.slice(0, 12)})`,
      tone: 'good',
    }
  } catch (e) {
    return {
      label,
      detail: `Not rendering — ${e instanceof Error ? e.message : String(e)}`,
      tone: 'bad',
    }
  }
}
