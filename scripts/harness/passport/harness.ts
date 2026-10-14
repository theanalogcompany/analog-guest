// TAC-586: passport-check. Behavioural checks for the passport stamp, with no
// database, no network and no model. See README.md beside this file.
//
//   npm run passport-check                  run every check
//   npm run passport-check -- --write-goldens   re-record the golden PNGs
//
// Prints one `ok` or `FAIL` line per check and exits 1 if any failed.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'

import { decideStamp, itemKey, stampItemName } from '@/lib/passport/decide'
import { formatStampDate } from '@/lib/passport/face'
import {
  MAX_ROTATION,
  mulberry32,
  pageForSeq,
  placeStamp,
  spreadForPage,
  templateFor,
} from '@/lib/passport/layout'
import { fontMetrics, PASSPORT_FONTS } from '@/lib/passport/render/assets'
import { renderStamp, resvgOptions } from '@/lib/passport/render/stamp'
import { renderSpread, type PlacedStamp } from '@/lib/passport/render/spread'
import type { StampFace } from '@/lib/passport/render/stamp-svg'
import { sendWithRetry } from '@/lib/passport/send-retry'
import type { InstagramImageSendResult } from '@/lib/messaging/instagram/send'
import { Resvg } from '@resvg/resvg-js'

const HERE = join(process.cwd(), 'scripts', 'harness', 'passport')
const GOLDEN_DIR = join(HERE, 'golden')
const WRITE_GOLDENS = process.argv.includes('--write-goldens')
const OUT_DIR = join(tmpdir(), 'passport-check')

let failures = 0
function check(name: string, pass: boolean, detail = ''): void {
  if (!pass) failures += 1
  console.log(
    `${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  )
}

function same<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const LE_MILS = {
  venueName: "LE MIL'S COFFEE",
  cityShort: 'S.F.',
  cityLong: 'SAN FRANCISCO',
}

// ---------------------------------------------------------------------------
// (a) The decision table
// ---------------------------------------------------------------------------

function partA(): void {
  console.log('\n(a) which stamp a purchase gets')
  const arrivedWith = (items: string[]) => ({
    kind: 'arrived' as const,
    label: null,
    lineItemNames: items,
  })
  const discovered = (label: string) => ({
    kind: 'discovered' as const,
    label,
    lineItemNames: [],
  })

  check(
    'first stamp is ARRIVED',
    same(decideStamp({ prior: [], lineItemNames: ['Oat Cortado'] }), {
      kind: 'arrived',
      label: null,
    }),
  )
  check(
    'first stamp is ARRIVED even when a perk unlocks on it',
    decideStamp({
      prior: [],
      lineItemNames: [],
      perkUnlocked: { perk: 'Off menu' },
    }).kind === 'arrived',
  )
  check(
    'a perk on a later visit is INVITED, carrying the perk line',
    same(
      decideStamp({
        prior: [arrivedWith(['Oat Cortado'])],
        lineItemNames: ['Matcha Latte'],
        perkUnlocked: { perk: 'Off menu' },
      }),
      { kind: 'invited', label: 'Off menu' },
    ),
  )
  check(
    'no perk passed, no INVITED',
    decideStamp({
      prior: [arrivedWith(['Oat Cortado'])],
      lineItemNames: ['Oat Cortado'],
    }).kind === 'visit',
  )
  check(
    'an item first ordered on the ARRIVED visit is already discovered',
    same(
      decideStamp({
        prior: [arrivedWith(['Pink Panther', 'Croissant'])],
        lineItemNames: ['Croissant'],
      }),
      { kind: 'visit', label: null },
    ),
  )
  check(
    'a new item is DISCOVERED and named',
    same(
      decideStamp({
        prior: [arrivedWith(['Croissant'])],
        lineItemNames: ['Oat Cortado'],
      }),
      { kind: 'discovered', label: 'Oat Cortado' },
    ),
  )
  const twoNew = decideStamp({
    prior: [arrivedWith(['Croissant'])],
    lineItemNames: ['Pink Panther', 'Matcha Latte'],
  })
  check(
    'two new items in one order: the first by line order is discovered',
    same(twoNew, { kind: 'discovered', label: 'Pink Panther' }),
  )
  check(
    '...and the second stays discoverable on a later visit',
    same(
      decideStamp({
        prior: [arrivedWith(['Croissant']), discovered('Pink Panther')],
        lineItemNames: ['Pink Panther', 'Matcha Latte'],
      }),
      { kind: 'discovered', label: 'Matcha Latte' },
    ),
  )
  check(
    'matching ignores case and spacing',
    decideStamp({
      prior: [arrivedWith(['Oat Cortado'])],
      lineItemNames: ['  oat   CORTADO '],
    }).kind === 'visit',
  )
  check(
    'a purchase with no readable items is a VISIT',
    decideStamp({ prior: [arrivedWith(['Croissant'])], lineItemNames: [] })
      .kind === 'visit',
  )

  // Ruled 2026-10-14: the item, never its size. Square sends the variation in
  // its own field; the stamp prints the name alone, and a different size of a
  // discovered item is a VISIT.
  const large = { name: 'Oat Milk Cortado', variationName: 'Large' }
  const printed = stampItemName(large)
  console.log(
    `      line item { name: "${large.name}", variation: "${large.variationName}" }` +
      ` prints "${printed.toLocaleUpperCase('en-US')}", matches as "${itemKey(printed)}"`,
  )
  check(
    'the variation is dropped from the printed name',
    printed === 'Oat Milk Cortado',
  )
  check(
    'a different size of a discovered item is a VISIT',
    decideStamp({
      prior: [arrivedWith(['Croissant']), discovered('Oat Milk Cortado')],
      lineItemNames: [
        stampItemName({ name: 'Oat Milk Cortado', variationName: 'Small' }),
      ],
    }).kind === 'visit',
  )
  check(
    'the date prints as 30 OCT 2026',
    formatStampDate('2026-10-30') === '30 OCT 2026' &&
      formatStampDate('nope') === null,
  )
}

// ---------------------------------------------------------------------------
// (b) Layout
// ---------------------------------------------------------------------------

function partB(): void {
  console.log('\n(b) where it lands')
  const input = {
    guestId: 'guest-a',
    seq: 3,
    usedSlots: [0, 4],
    textureSeed: 123456,
  }
  const first = placeStamp(input)
  let stable = true
  for (let i = 0; i < 1000; i++)
    if (!same(placeStamp(input), first)) stable = false
  check('the same seed places the same way, 1,000 times', stable)

  check(
    'page rollover: 6 → 01, 7 → 02, 12 → 02, 13 → 03',
    pageForSeq(6) === 1 &&
      pageForSeq(7) === 2 &&
      pageForSeq(12) === 2 &&
      pageForSeq(13) === 3,
  )
  check(
    'spreads: page 1 and 2 → 01–02, page 3 → 03–04',
    same(spreadForPage(1), [1, 2]) &&
      same(spreadForPage(2), [1, 2]) &&
      same(spreadForPage(3), [3, 4]),
  )

  // 60 guests, 13 stamps each, seeds from a fixed stream: no slot is used
  // twice on a page, and every tilt is inside the spec's ±8°.
  const seeds = mulberry32(586)
  let collisions = 0
  let outOfRange = 0
  let unplaced = 0
  for (let g = 0; g < 60; g++) {
    const guestId = `guest-${g}`
    const used = new Map<number, number[]>()
    for (let seq = 1; seq <= 13; seq++) {
      const page = pageForSeq(seq)
      const usedSlots = used.get(page) ?? []
      const placed = placeStamp({
        guestId,
        seq,
        usedSlots,
        textureSeed: Math.floor(seeds() * 2 ** 31),
      })
      if (placed === null) {
        unplaced += 1
        continue
      }
      if (usedSlots.includes(placed.slot)) collisions += 1
      if (Math.abs(placed.rotation) > MAX_ROTATION) outOfRange += 1
      used.set(page, [...usedSlots, placed.slot])
    }
  }
  check(
    'no slot collisions across 60 guests × 13 stamps',
    collisions === 0 && unplaced === 0,
  )
  check('every tilt within ±8°', outOfRange === 0)
  check(
    'a full page has no slot to give',
    placeStamp({
      guestId: 'g',
      seq: 6,
      usedSlots: [0, 1, 2, 3, 4, 5],
      textureSeed: 1,
    }) === null,
  )
}

// ---------------------------------------------------------------------------
// (c) Renders
// ---------------------------------------------------------------------------

async function rawHash(png: Buffer): Promise<string> {
  const raw = await sharp(png).ensureAlpha().raw().toBuffer()
  return createHash('sha256').update(raw).digest('hex')
}

/** Max channel delta ≤ 2 on at most 0.1% of pixels: rounding across machines, nothing more. */
async function matchesGolden(
  png: Buffer,
  golden: Buffer,
): Promise<{ pass: boolean; detail: string }> {
  const a = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const b = await sharp(golden)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (a.info.width !== b.info.width || a.info.height !== b.info.height)
    return {
      pass: false,
      detail: `size ${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}`,
    }
  let off = 0
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0
    for (let c = 0; c < 4; c++)
      delta = Math.max(delta, Math.abs(a.data[i + c]! - b.data[i + c]!))
    if (delta > 2) off += 1
  }
  const pixels = a.data.length / 4
  return {
    pass: off <= pixels * 0.001,
    detail: `${off} of ${pixels} pixels off`,
  }
}

const GOLDEN_FACES: Record<
  string,
  { face: StampFace; seed: number; rotation: number }
> = {
  arrived: {
    face: { kind: 'arrived', label: null, date: '30 OCT 2026', ...LE_MILS },
    seed: 101,
    rotation: 4.25,
  },
  visit: {
    face: { kind: 'visit', label: null, date: '02 NOV 2026', ...LE_MILS },
    seed: 202,
    rotation: -3.5,
  },
  discovered: {
    face: {
      kind: 'discovered',
      label: 'Oat Cortado',
      date: '06 NOV 2026',
      ...LE_MILS,
    },
    seed: 303,
    rotation: 6,
  },
  invited: {
    face: {
      kind: 'invited',
      label: 'Off menu',
      date: '02 JAN 2027',
      ...LE_MILS,
    },
    seed: 404,
    rotation: -5.75,
  },
}

function goldenSpreadStamps(): PlacedStamp[] {
  const faces: Array<Omit<StampFace, keyof typeof LE_MILS>> = [
    { kind: 'arrived', label: null, date: '30 OCT 2026' },
    { kind: 'discovered', label: 'Oat Cortado', date: '01 NOV 2026' },
    { kind: 'visit', label: null, date: '03 NOV 2026' },
    { kind: 'visit', label: null, date: '05 NOV 2026' },
    { kind: 'discovered', label: 'Chai Latte', date: '07 NOV 2026' },
    { kind: 'invited', label: 'Off menu', date: '09 NOV 2026' },
  ]
  const used: number[] = []
  return faces.map((face, i) => {
    const seq = i + 1
    const placed = placeStamp({
      guestId: 'golden',
      seq,
      usedSlots: used,
      textureSeed: 9000 + i,
    })!
    used.push(placed.slot)
    return {
      seq,
      guestId: 'golden',
      ...placed,
      textureSeed: 9000 + i,
      face: { ...face, ...LE_MILS },
    }
  })
}

async function compareOrWrite(name: string, png: Buffer): Promise<void> {
  const path = join(GOLDEN_DIR, `${name}.png`)
  if (WRITE_GOLDENS) {
    writeFileSync(path, png)
    console.log(`      wrote ${path}`)
    return
  }
  if (!existsSync(path)) {
    check(
      `${name} matches its golden`,
      false,
      'no golden; run with --write-goldens',
    )
    return
  }
  const result = await matchesGolden(png, readFileSync(path))
  check(`${name} matches its golden`, result.pass, result.detail)
}

async function partC(): Promise<void> {
  console.log('\n(c) renders')

  // The fonts the layout measures are the fonts resvg draws.
  const expected = {
    oswaldSemiBold: [810, 1000],
    oswaldMedium: [810, 1000],
    courierPrimeBold: [1187, 2048],
    cutiveMono: [1171, 2048],
  } as const
  for (const [id, [cap, upm]] of Object.entries(expected)) {
    const m = fontMetrics(id as keyof typeof PASSPORT_FONTS)
    check(
      `${id} cap height ${cap}/${upm}`,
      m.capHeight === cap && m.unitsPerEm === upm,
    )
  }
  check(
    'no bundled font has ★, which is why the star is drawn',
    !Object.keys(PASSPORT_FONTS).some((id) =>
      fontMetrics(id as keyof typeof PASSPORT_FONTS).hasGlyph(0x2605),
    ),
  )
  // resvg must tell Oswald 600 from Oswald 500, or every label is a title.
  const weightHash = (weight: number) =>
    createHash('sha256')
      .update(
        new Resvg(
          `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text x="4" y="30" font-family="Oswald" font-weight="${weight}" font-size="28">ARRIVED</text></svg>`,
          resvgOptions(1),
        ).render().pixels,
      )
      .digest('hex')
  check(
    'resvg draws Oswald SemiBold and Medium differently',
    weightHash(600) !== weightHash(500),
  )

  mkdirSync(OUT_DIR, { recursive: true })
  for (const [name, { face, seed, rotation }] of Object.entries(GOLDEN_FACES)) {
    const one = await renderStamp(face, { textureSeed: seed, rotation })
    const two = await renderStamp(face, { textureSeed: seed, rotation })
    if (!one.ok || !two.ok) {
      check(
        `${name} renders`,
        false,
        !one.ok ? one.error : !two.ok ? two.error : '',
      )
      continue
    }
    check(
      `${name} re-renders pixel-identically`,
      (await rawHash(one.data.png)) === (await rawHash(two.data.png)),
    )
    writeFileSync(join(OUT_DIR, `${name}.png`), one.data.png)
    await compareOrWrite(name, one.data.png)
  }

  const spreadInput = {
    pages: [1, 2] as const,
    venueName: LE_MILS.venueName,
    background: 'page-background-no-header@2x.png',
    stamps: goldenSpreadStamps(),
  }
  const spreadOne = await renderSpread(spreadInput)
  const spreadTwo = await renderSpread(spreadInput)
  if (!spreadOne.ok || !spreadTwo.ok) {
    check(
      'spread renders',
      false,
      !spreadOne.ok ? spreadOne.error : !spreadTwo.ok ? spreadTwo.error : '',
    )
  } else {
    check(
      '6-stamp spread re-renders pixel-identically',
      (await rawHash(spreadOne.data.png)) ===
        (await rawHash(spreadTwo.data.png)),
    )
    const meta = await sharp(spreadOne.data.png).metadata()
    const corner = await sharp(spreadOne.data.png)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .ensureAlpha()
      .raw()
      .toBuffer()
    check(
      'the spread is 1200×1680 with transparent corners kept',
      meta.width === 1200 && meta.height === 1680 && corner[3] === 0,
    )
    writeFileSync(join(OUT_DIR, 'spread.png'), spreadOne.data.png)
    await compareOrWrite('spread', spreadOne.data.png)
  }

  // THE CONTROL ARM. A comparison that passes everything proves nothing: a
  // different seed must FAIL the golden it was not drawn from.
  if (!WRITE_GOLDENS && existsSync(join(GOLDEN_DIR, 'discovered.png'))) {
    const golden = GOLDEN_FACES.discovered!
    const perturbed = await renderStamp(golden.face, {
      textureSeed: golden.seed + 1,
      rotation: golden.rotation,
    })
    if (perturbed.ok) {
      const result = await matchesGolden(
        perturbed.data.png,
        readFileSync(join(GOLDEN_DIR, 'discovered.png')),
      )
      check(
        'control: a different seed does NOT match the golden',
        !result.pass,
        result.detail,
      )
    } else {
      check('control renders', false, perturbed.error)
    }
  }
}

// ---------------------------------------------------------------------------
// (d) The reference spread, re-drawn, beside the Figma image
// ---------------------------------------------------------------------------

/** A guest id whose page 1 gets template A and page 2 template B, found by search. */
function referenceGuest(): string {
  for (let i = 0; i < 10_000; i++) {
    const id = `reference-${i}`
    if (templateFor(id, 1).name === 'A' && templateFor(id, 2).name === 'B')
      return id
  }
  throw new Error('no guest id maps to templates A and B')
}

async function partD(): Promise<void> {
  console.log('\n(d) the reference spread (167:1632), re-drawn with no jitter')
  const guestId = referenceGuest()
  // The twelve stamps of 167:1632, in its slot order (templates.ts).
  const top: Array<Omit<StampFace, keyof typeof LE_MILS>> = [
    { kind: 'discovered', label: 'Oat Cortado', date: '01 NOV 2026' },
    { kind: 'visit', label: null, date: '03 NOV 2026' },
    { kind: 'visit', label: null, date: '05 NOV 2026' },
    { kind: 'arrived', label: null, date: '30 OCT 2026' },
    { kind: 'discovered', label: 'Chai Latte', date: '07 NOV 2026' },
    { kind: 'visit', label: null, date: '09 NOV 2026' },
  ]
  const bottom: Array<Omit<StampFace, keyof typeof LE_MILS>> = [
    { kind: 'visit', label: null, date: '13 NOV 2026' },
    { kind: 'discovered', label: 'Cardamom Bun', date: '16 NOV 2026' },
    { kind: 'visit', label: null, date: '24 NOV 2026' },
    { kind: 'visit', label: null, date: '18 NOV 2026' },
    { kind: 'invited', label: 'Off menu', date: '20 NOV 2026' },
    { kind: 'discovered', label: 'Matcha Latte', date: '27 NOV 2026' },
  ]
  const stamps: PlacedStamp[] = [...top, ...bottom].map((face, i) => {
    const page = i < 6 ? 1 : 2
    const slot = i % 6
    return {
      seq: i + 1,
      guestId,
      page,
      slot,
      dx: 0,
      dy: 0,
      rotation: templateFor(guestId, page).slots[slot]!.rotation,
      textureSeed: 7000 + i,
      face: { ...face, ...LE_MILS },
    }
  })
  const ours = await renderSpread({
    pages: [1, 2],
    venueName: LE_MILS.venueName,
    background: 'page-background-no-header@2x.png',
    stamps,
  })
  if (!ours.ok) {
    check('reference spread renders', false, ours.error)
    return
  }
  const reference = await sharp(join(HERE, 'reference-167-1632.png'))
    .resize(1200, 1680)
    .png()
    .toBuffer()
  const side = join(OUT_DIR, 'reference-side-by-side.png')
  await sharp({
    create: { width: 2440, height: 1680, channels: 4, background: '#ffffff' },
  })
    .composite([
      { input: reference, left: 0, top: 0 },
      { input: ours.data.png, left: 1240, top: 0 },
    ])
    .png()
    .toFile(side)
  console.log(`      Figma left, ours right: ${side}`)
  console.log('      judged by eye; nothing here can fail it')
}

// ---------------------------------------------------------------------------
// (e) Sending: what is retried, and what is never sent twice
// ---------------------------------------------------------------------------

const SENT: InstagramImageSendResult = { ok: true, mid: 'mid-sent' }
const fails = (
  kind: 'rate_limited' | 'timeout' | 'token_rejected' | 'graph_error',
  httpStatus = 400,
): InstagramImageSendResult =>
  kind === 'graph_error'
    ? {
        ok: false,
        kind,
        failure: {
          reason: 'graph_error',
          httpStatus,
          code: null,
          subcode: null,
          type: null,
          fbtraceId: null,
        },
      }
    : kind === 'timeout'
      ? { ok: false, kind, failure: { reason: 'timeout' } }
      : { ok: false, kind, failure: null }

/** Runs sendWithRetry against scripted sends and echo lookups, on a fake clock. */
async function scripted(
  sends: InstagramImageSendResult[],
  echoes: Array<string | null> = [],
) {
  let attempts = 0
  let echoLookups = 0
  let slept = 0
  const result = await sendWithRetry({
    send: async () => sends[attempts - 1] ?? SENT,
    findEchoSince: async () => echoes[echoLookups++] ?? null,
    sleep: async (ms) => {
      slept += ms
    },
    now: () => new Date(0),
    onAttempt: () => {
      attempts += 1
    },
  })
  return { result, attempts, echoLookups, slept }
}

async function partE(): Promise<void> {
  console.log('\n(e) sending')
  let r = await scripted([SENT])
  check(
    'a clean send goes once',
    r.result.ok && r.attempts === 1 && r.slept === 0,
  )

  r = await scripted([fails('rate_limited'), SENT])
  check(
    'a rate limit is retried after 2 s and then goes',
    r.result.ok && r.attempts === 2 && r.slept === 2000,
  )

  r = await scripted([
    fails('rate_limited'),
    fails('rate_limited'),
    fails('rate_limited'),
  ])
  check(
    'retried at most 2 more times (2 s, then 6 s), then given up',
    !r.result.ok && r.attempts === 3 && r.slept === 8000,
  )

  r = await scripted([fails('token_rejected')])
  check('a rejected token is not retried', !r.result.ok && r.attempts === 1)

  r = await scripted([fails('timeout')], [null, 'mid-echo'])
  check(
    'a timeout whose echo arrives late is adopted, never resent',
    r.result.ok &&
      r.result.mid === 'mid-echo' &&
      r.attempts === 1 &&
      r.echoLookups === 2,
  )

  r = await scripted([fails('timeout'), SENT], [null, null])
  check(
    'a timeout with no echo stops: never sent a second time',
    !r.result.ok && r.attempts === 1 && r.echoLookups === 2,
  )

  r = await scripted([fails('graph_error', 503), SENT], [null, null])
  check(
    'a Meta 5xx is treated as possibly delivered: not resent',
    !r.result.ok && r.attempts === 1,
  )

  r = await scripted([fails('graph_error', 400), SENT])
  check(
    'a Meta 4xx was not delivered: retried',
    r.result.ok && r.attempts === 2,
  )
}

async function main(): Promise<void> {
  partA()
  partB()
  await partC()
  await partD()
  await partE()
  console.log(`\nrenders in ${OUT_DIR}`)
  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
