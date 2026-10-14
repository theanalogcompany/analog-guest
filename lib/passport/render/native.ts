// TAC-586: sharp and resvg, loaded when a stamp is drawn and not before.
//
// WHY NOT A STATIC IMPORT. Both load a platform binary the moment they are
// imported. The renderer is reached from the Instagram webhook route, so a
// static import would load them when the ROUTE loads: a missing or mismatched
// binary on a deploy would then fail every Instagram delivery with a 500, not
// just stamps, and the route's "200 on everything" design would never run
// (Meta disables a subscription after repeated non-2xx, with no alert; see
// lib/messaging/instagram/CLAUDE.md). Loaded here, a failure is one stamp's
// `native` failure, an event, and a red /admin/health row.
//
// Cached after the first success. A failed load is not cached, so a cold
// start that hits a transient problem does not pin the failure.

import type { Resvg as ResvgClass } from '@resvg/resvg-js'

export type NativeLibs = {
  sharp: typeof import('sharp')
  Resvg: typeof ResvgClass
}

let cached: NativeLibs | null = null

export async function loadNative(): Promise<
  { ok: true; data: NativeLibs } | { ok: false; error: string }
> {
  if (cached !== null) return { ok: true, data: cached }
  try {
    const [sharpModule, resvgModule] = await Promise.all([
      import('sharp'),
      import('@resvg/resvg-js'),
    ])
    cached = { sharp: sharpModule.default, Resvg: resvgModule.Resvg }
    return { ok: true, data: cached }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
