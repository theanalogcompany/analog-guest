// TAC-586, TAC-587: passport-check. Behavioural checks for the passport stamp, with no
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
import { formatStampDate, formatStampTime } from '@/lib/passport/face'
import {
  eligibleSpots,
  MAX_ROTATION,
  mulberry32,
  pagesForSeq,
  placeStamp,
  spreadForPage,
  STAMPS_PER_PAGE,
  STAMPS_PER_SPREAD,
  templateFor,
  type UsedSpot,
} from '@/lib/passport/layout'
import { PAGE_TEMPLATES } from '@/lib/passport/templates'
import { fontMetrics, PASSPORT_FONTS } from '@/lib/passport/render/assets'
import { renderStamp, resvgOptions } from '@/lib/passport/render/stamp'
import { renderSpread, type PlacedStamp } from '@/lib/passport/render/spread'
import type { StampFace } from '@/lib/passport/render/stamp-svg'
import { sendWithRetry } from '@/lib/passport/send-retry'
import type { InstagramImageSendResult } from '@/lib/messaging/instagram/send'
import { venueLocalDate } from '@/lib/schemas'
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

  // TAC-587: the time, from the same instant and timezone as the date.
  const LA = 'America/Los_Angeles'
  const at = (iso: string) => formatStampTime(new Date(iso), LA)
  check(
    'the time prints 12-hour with no leading zero: 1:22 PM, 9:05 AM, 12:00 PM, 12:05 AM',
    at('2026-10-30T20:22:00Z') === '1:22 PM' &&
      at('2026-10-30T16:05:00Z') === '9:05 AM' &&
      at('2026-10-30T19:00:00Z') === '12:00 PM' &&
      at('2026-10-30T07:05:00Z') === '12:05 AM',
  )
  const lateNight = new Date('2026-10-31T06:30:00Z')
  const lateDate = venueLocalDate(lateNight, LA)
  check(
    'a late-night purchase prints the venue-local date and time: 30 OCT 2026, 11:30 PM',
    lateDate !== null &&
      formatStampDate(lateDate) === '30 OCT 2026' &&
      formatStampTime(lateNight, LA) === '11:30 PM',
    `${lateDate} ${formatStampTime(lateNight, LA)}`,
  )
  check(
    'an unusable timezone prints no time',
    formatStampTime(lateNight, 'Not/AZone') === null,
  )
}

// ---------------------------------------------------------------------------
// (b) Layout
// ---------------------------------------------------------------------------

/** TAC-586's template rule, written out again: what every sent stamp was drawn with. */
function templateBefore587(guestId: string, page: number): string {
  let hash = 0x811c9dc5
  const text = `${guestId}:${page}`
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return PAGE_TEMPLATES[(hash >>> 0) % PAGE_TEMPLATES.length]!.name
}

// Ruled 2026-10-14 (TAC-587 Q1 = C). Written here as a number, not imported
// from layout.ts: a check that reads the constant it is checking passes
// whatever the constant says.
const RULED_MAX_PAGE_LEAD = 2

function partB(): void {
  console.log('\n(b) where it lands')
  const input = {
    guestId: 'guest-a',
    seq: 3,
    used: [
      { page: 1, slot: 0 },
      { page: 2, slot: 4 },
    ],
    textureSeed: 123456,
  }
  const first = placeStamp(input)
  let stable = true
  for (let i = 0; i < 1000; i++)
    if (!same(placeStamp(input), first)) stable = false
  check('the same seed places the same way, 1,000 times', stable)

  check(
    'spread rollover: 1 and 12 → 01–02, 13 and 24 → 03–04, 25 → 05–06',
    same(pagesForSeq(1), [1, 2]) &&
      same(pagesForSeq(12), [1, 2]) &&
      same(pagesForSeq(13), [3, 4]) &&
      same(pagesForSeq(24), [3, 4]) &&
      same(pagesForSeq(25), [5, 6]),
  )
  check(
    'spreads: page 1 and 2 → 01–02, page 3 → 03–04',
    same(spreadForPage(1), [1, 2]) &&
      same(spreadForPage(2), [1, 2]) &&
      same(spreadForPage(3), [3, 4]),
  )

  // The balance rule, driven directly: two ahead closes a page, one does not.
  const spotsWith = (used: UsedSpot[]) =>
    eligibleSpots({ guestId: 'guest-b', seq: used.length + 1, used })
  const twoAhead = spotsWith([
    { page: 1, slot: 0 },
    { page: 1, slot: 1 },
  ])
  const oneAhead = spotsWith([{ page: 1, slot: 0 }])
  check(
    `a page ${RULED_MAX_PAGE_LEAD} stamps ahead takes no stamp; 1 ahead still does`,
    twoAhead.length === STAMPS_PER_PAGE &&
      twoAhead.every((spot) => spot.page === 2) &&
      oneAhead.some((spot) => spot.page === 1) &&
      oneAhead.some((spot) => spot.page === 2),
  )

  // 60 guests, 25 stamps each, seeds from a fixed stream.
  const seeds = mulberry32(587)
  let collisions = 0
  let outOfRange = 0
  let unplaced = 0
  let offSpread = 0
  let overLead = 0
  let fullBeforeOther = 0
  let unevenAtFull = 0
  let bothPagesUsed = 0
  for (let g = 0; g < 60; g++) {
    const guestId = `guest-${g}`
    const used: UsedSpot[] = []
    let firstSpreadPages = new Set<number>()
    for (let seq = 1; seq <= 25; seq++) {
      const pages = pagesForSeq(seq)
      const placed = placeStamp({
        guestId,
        seq,
        used,
        textureSeed: Math.floor(seeds() * 2 ** 31),
      })
      if (placed === null) {
        unplaced += 1
        continue
      }
      if (!pages.includes(placed.page)) offSpread += 1
      if (used.some((u) => u.page === placed.page && u.slot === placed.slot))
        collisions += 1
      if (Math.abs(placed.rotation) > MAX_ROTATION) outOfRange += 1
      used.push({ page: placed.page, slot: placed.slot })
      if (seq <= STAMPS_PER_SPREAD) firstSpreadPages.add(placed.page)

      const [top, bottom] = pages.map(
        (page) => used.filter((u) => u.page === page).length,
      ) as [number, number]
      if (Math.abs(top - bottom) > RULED_MAX_PAGE_LEAD) overLead += 1
      if (
        (top === STAMPS_PER_PAGE && bottom === 0) ||
        (bottom === STAMPS_PER_PAGE && top === 0)
      )
        fullBeforeOther += 1
      if (seq % STAMPS_PER_SPREAD === 0 && (top !== 6 || bottom !== 6))
        unevenAtFull += 1
    }
    if (firstSpreadPages.size === 2) bothPagesUsed += 1
    firstSpreadPages = new Set()
  }
  check(
    'no spot used twice across 60 guests × 25 stamps, none unplaced, none off its spread',
    collisions === 0 && unplaced === 0 && offSpread === 0,
    `${collisions} collisions, ${unplaced} unplaced, ${offSpread} off spread`,
  )
  check('every tilt within ±8°', outOfRange === 0)
  check(
    '12 stamps per spread, 6 on each page',
    unevenAtFull === 0,
    `${unevenAtFull} uneven`,
  )
  check(
    `neither page ever more than ${RULED_MAX_PAGE_LEAD} stamps ahead of the other`,
    overLead === 0,
    `${overLead} over`,
  )
  check(
    'both pages receive stamps before either is full',
    fullBeforeOther === 0 && bothPagesUsed === 60,
  )
  const fullSpread: UsedSpot[] = [1, 2].flatMap((page) =>
    [0, 1, 2, 3, 4, 5].map((slot) => ({ page, slot })),
  )
  check(
    'a full spread has no spot to give',
    placeStamp({ guestId: 'g', seq: 12, used: fullSpread, textureSeed: 1 }) ===
      null,
  )

  // Templates. A row stores its slot, not its coordinates, so the template a
  // page was drawn on must never change while it holds stamps.
  let sameOnSpread = 0
  let moved = 0
  for (let i = 0; i < 10_000; i++) {
    const id = `t-${i}`
    for (let page = 1; page <= 40; page += 2)
      if (templateFor(id, page).name === templateFor(id, page + 1).name)
        sameOnSpread += 1
    for (let page = 1; page <= 8; page++)
      if (templateFor(id, page).name !== templateBefore587(id, page)) moved += 1
  }
  check(
    "a spread's two pages never share a template, pages 01–40, 10,000 guests",
    sameOnSpread === 0,
    `${sameOnSpread} shared`,
  )
  check(
    'pages 01–08 keep the template every sent stamp was drawn on, 10,000 guests',
    moved === 0,
    `${moved} moved`,
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
    face: {
      kind: 'arrived',
      label: null,
      date: '30 OCT 2026',
      time: '1:22 PM',
      ...LE_MILS,
    },
    seed: 101,
    rotation: 4.25,
  },
  visit: {
    face: {
      kind: 'visit',
      label: null,
      date: '02 NOV 2026',
      time: '1:22 PM',
      ...LE_MILS,
    },
    seed: 202,
    rotation: -3.5,
  },
  discovered: {
    face: {
      kind: 'discovered',
      label: 'Oat Cortado',
      date: '06 NOV 2026',
      time: '1:22 PM',
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
      time: '1:22 PM',
      ...LE_MILS,
    },
    seed: 404,
    rotation: -5.75,
  },
}

/** A full first spread: twelve stamps, both pages filling together. */
function goldenSpreadStamps(): PlacedStamp[] {
  const faces: Array<Omit<StampFace, keyof typeof LE_MILS>> = [
    { kind: 'arrived', label: null, date: '30 OCT 2026', time: '8:14 AM' },
    {
      kind: 'discovered',
      label: 'Oat Cortado',
      date: '01 NOV 2026',
      time: '1:22 PM',
    },
    { kind: 'visit', label: null, date: '03 NOV 2026', time: '9:05 AM' },
    { kind: 'visit', label: null, date: '05 NOV 2026', time: '12:40 PM' },
    {
      kind: 'discovered',
      label: 'Chai Latte',
      date: '07 NOV 2026',
      time: '3:58 PM',
    },
    {
      kind: 'invited',
      label: 'Off menu',
      date: '09 NOV 2026',
      time: '11:30 AM',
    },
    { kind: 'visit', label: null, date: '13 NOV 2026', time: '7:45 AM' },
    {
      kind: 'discovered',
      label: 'Cardamom Bun',
      date: '16 NOV 2026',
      time: '10:12 AM',
    },
    { kind: 'visit', label: null, date: '18 NOV 2026', time: '2:03 PM' },
    { kind: 'visit', label: null, date: '20 NOV 2026', time: '12:05 PM' },
    {
      kind: 'discovered',
      label: 'Matcha Latte',
      date: '24 NOV 2026',
      time: '4:30 PM',
    },
    { kind: 'visit', label: null, date: '27 NOV 2026', time: '6:55 PM' },
  ]
  const used: UsedSpot[] = []
  return faces.map((face, i) => {
    const seq = i + 1
    const placed = placeStamp({
      guestId: 'golden',
      seq,
      used,
      textureSeed: 9000 + i,
    })!
    used.push({ page: placed.page, slot: placed.slot })
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
      '12-stamp spread re-renders pixel-identically',
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
    {
      kind: 'discovered',
      label: 'Oat Cortado',
      date: '01 NOV 2026',
      time: '1:22 PM',
    },
    { kind: 'visit', label: null, date: '03 NOV 2026', time: '1:22 PM' },
    { kind: 'visit', label: null, date: '05 NOV 2026', time: '1:22 PM' },
    { kind: 'arrived', label: null, date: '30 OCT 2026', time: '1:22 PM' },
    {
      kind: 'discovered',
      label: 'Chai Latte',
      date: '07 NOV 2026',
      time: '1:22 PM',
    },
    { kind: 'visit', label: null, date: '09 NOV 2026', time: '1:22 PM' },
  ]
  const bottom: Array<Omit<StampFace, keyof typeof LE_MILS>> = [
    { kind: 'visit', label: null, date: '13 NOV 2026', time: '1:22 PM' },
    {
      kind: 'discovered',
      label: 'Cardamom Bun',
      date: '16 NOV 2026',
      time: '1:22 PM',
    },
    { kind: 'visit', label: null, date: '24 NOV 2026', time: '1:22 PM' },
    { kind: 'visit', label: null, date: '18 NOV 2026', time: '1:22 PM' },
    {
      kind: 'invited',
      label: 'Off menu',
      date: '20 NOV 2026',
      time: '1:22 PM',
    },
    {
      kind: 'discovered',
      label: 'Matcha Latte',
      date: '27 NOV 2026',
      time: '1:22 PM',
    },
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
