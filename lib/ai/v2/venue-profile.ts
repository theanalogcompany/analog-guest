/**
 * Tier 1: the venue's own facts, rendered for the v2 prompt.
 *
 * This replaced `JSON.stringify(venue_info, null, 1).slice(0, 4000)` in
 * run-turn.ts, which was labelled "crude serialization for now" and was worse
 * than crude: Le Mil's `venue_info` stringifies to 22,258 characters, so the
 * cut landed inside the `menu` array and `menu` was the ONLY key that reached
 * the model. Address, hours, contact, amenities, services, staff and
 * currentContext had never been in a v2 prompt. Measured 2026-10-05: asked
 * "where are you located?" and "what's your address?", v2 replied with a
 * Polk Street number that appears nowhere in the venue's data, and the
 * numbers differed between two runs of the identical prompt. The gate sent
 * both (verdict `send`, no policy matched) - nothing downstream can catch a
 * fabricated fact, so the only fix is to put the fact in the prompt.
 *
 * THERE IS NO CHARACTER BUDGET HERE, deliberately. Every section is a fact
 * the agent needs in order to answer, so a budget can only choose which
 * question to get wrong. If this section ever grows past what the model
 * accepts, the generate call fails loudly on its own, which is the correct
 * failure; a silent truncation is the one that cost two fabricated addresses.
 *
 * Two guards keep a fact from going missing again, and they cover different
 * causes:
 *
 *   1. `SECTIONS` is `satisfies Record<keyof VenueInfo, ...>`, so adding a
 *      field to VenueInfoSchema does not compile until someone decides
 *      whether v2 renders it. A `readonly K[]` would not be
 *      exhaustiveness-checked and would have let the same class back in.
 *   2. `unrendered` reports keys present in the stored row that no renderer
 *      reached. VenueInfoSchema is a plain `z.object`, so Zod strips unknown
 *      keys silently, and an operator adding one in Studio would otherwise
 *      get no signal at all.
 *
 * A parse failure THROWS, matching `buildRuntimeContext` (v1,
 * lib/agent/build-runtime-context.ts:382) rather than inventing a second
 * answer to "what happens when venue_info is malformed". `unrendered` does
 * not throw: the value was already stripped by the schema before any renderer
 * could see it, the fix is a schema edit, and taking down every turn at a
 * venue over an unrecognised key is the failure
 * `.claude/rules/errors-as-values.md` warns about at a live boundary.
 *
 * `services` keeps its three-state semantics verbatim from
 * `VenueServicesSchema`'s docstring: true says so, false renders an
 * unmissable negative, absent renders NOTHING. Absent must never read as a
 * negative - that would have the agent deny real services at every venue
 * nobody has configured yet.
 */

import {
  filterActiveContext,
  VenueInfoSchema,
  type MenuItem,
  type VenueInfo,
} from '@/lib/schemas'

export interface RenderedVenueProfile {
  /** The prompt section. Never truncated. */
  text: string
  /**
   * Keys in the stored row that reached no renderer. MUST be empty; the
   * template regression harness asserts it, and the playground shows it.
   */
  unrendered: string[]
  charCount: number
}

type SectionRenderer = (info: VenueInfo, now: Date) => string | null

function formatAddress(addr: VenueInfo['address']): string {
  const street = [addr.line1, addr.line2].filter(Boolean).join(', ')
  return `${street}, ${addr.city}, ${addr.region} ${addr.postalCode}`
}

const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const

function renderWhereYouAre(info: VenueInfo): string {
  const lines = [
    '## Where you are',
    `- Address: ${formatAddress(info.address)}`,
  ]
  const dayLines = DAYS.filter((d) => info.hours[d]).map(
    (d) => `  - ${d[0].toUpperCase() + d.slice(1)}: ${info.hours[d]}`,
  )
  if (dayLines.length > 0) lines.push('- Hours:', ...dayLines)
  if (info.hours.notes) {
    const noteLines = info.hours.notes
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (noteLines.length === 1) lines.push(`- Hours notes: ${noteLines[0]}`)
    else if (noteLines.length > 1)
      lines.push('- Hours notes:', ...noteLines.map((l) => `  - ${l}`))
  }
  if (info.contact.publicPhone)
    lines.push(`- Phone: ${info.contact.publicPhone}`)
  if (info.contact.publicEmail)
    lines.push(`- Email: ${info.contact.publicEmail}`)
  if (info.contact.website) lines.push(`- Website: ${info.contact.website}`)
  return lines.join('\n')
}

function renderTheRoom(info: VenueInfo): string | null {
  const a = info.amenities
  if (!a) return null
  const lines: string[] = []
  if (a.seating) lines.push(`- Seating: ${a.seating}`)
  if (a.parking) lines.push(`- Parking: ${a.parking}`)
  // Booleans are optional in the schema, so absent stays absent: rendering
  // "Wifi: no" for a venue nobody configured is the same false-negative the
  // services three-state exists to prevent.
  if (a.wifi !== undefined) lines.push(`- Wifi: ${a.wifi ? 'yes' : 'no'}`)
  if (a.petFriendly !== undefined)
    lines.push(`- Pet friendly: ${a.petFriendly ? 'yes' : 'no'}`)
  if (a.notes) lines.push(`- Notes: ${a.notes}`)
  return lines.length > 0 ? ['## The room', ...lines].join('\n') : null
}

const NAMED_SERVICES = {
  aheadOrdering: 'ordering ahead',
  holds: 'holding an item for later pickup',
  reservations: 'reservations',
  delivery: 'delivery',
  catering: 'catering',
} satisfies Record<string, string>

function renderWhatYouDo(info: VenueInfo): string | null {
  const s = info.services
  if (!s) return null
  const offered: string[] = []
  const notOffered: string[] = []
  for (const [key, label] of Object.entries(NAMED_SERVICES)) {
    const value = s[key as keyof typeof NAMED_SERVICES]
    if (value === true) offered.push(label)
    else if (value === false) notOffered.push(label)
  }
  offered.push(...s.alsoOffers)
  notOffered.push(...s.alsoDoesNotOffer)
  const lines: string[] = []
  if (offered.length > 0) lines.push(`- You do offer: ${offered.join(', ')}`)
  if (notOffered.length > 0)
    lines.push(`- You do NOT offer: ${notOffered.join(', ')}`)
  if (lines.length === 0) return null
  lines.push(
    'Anything not listed here has not been stated either way. Do not assume it is available, and do not tell the guest it is unavailable.',
  )
  return ['## What you do and do not do', ...lines].join('\n')
}

function renderStaff(info: VenueInfo): string | null {
  if (info.staff.length === 0) return null
  return `## Who works here\n- ${info.staff.join(', ')}`
}

function renderRightNow(info: VenueInfo, now: Date): string | null {
  const active = filterActiveContext(info.currentContext, now)
  if (active.length === 0) return null
  return [
    '## True at the venue right now',
    ...active.map((n) => `- ${n.content}`),
  ].join('\n')
}

function menuItemLine(item: MenuItem): string {
  const parts: string[] = [item.name]
  if (item.size) parts.push(item.size)
  if (item.price !== undefined) parts.push(`$${item.price.toFixed(2)}`)
  else if (item.priceNote) parts.push(item.priceNote)
  if (item.dietary.length > 0) parts.push(item.dietary.join(', '))
  if (item.modifiers.length > 0) parts.push(`add ${item.modifiers.join(', ')}`)
  if (item.availability) parts.push(item.availability)
  if (item.isOffMenu) parts.push('off menu')
  const line = `- ${parts.join(' - ')}`
  return item.description ? `${line}\n  ${item.description}` : line
}

function renderWhatYouServe(info: VenueInfo): string | null {
  const lines: string[] = []
  if (info.menu.highlights.length > 0)
    lines.push(`- Highlights: ${info.menu.highlights.join('; ')}`)
  if (info.menu.notes) lines.push(`- Notes: ${info.menu.notes}`)
  const byCategory = new Map<string, MenuItem[]>()
  for (const item of info.menu.items) {
    const list = byCategory.get(item.category) ?? []
    list.push(item)
    byCategory.set(item.category, list)
  }
  for (const [category, items] of byCategory) {
    lines.push(`### ${category}`, ...items.map(menuItemLine))
  }
  return lines.length > 0 ? ['## What you serve', ...lines].join('\n') : null
}

/**
 * Every key of VenueInfo, and what v2 does with it. `null` is a deliberate
 * decision not to render, never an omission - that is the whole point of the
 * totality claim below.
 */
const SECTIONS = {
  // address, hours and contact render as one block: a guest asking where the
  // venue is usually wants when it is open in the same breath.
  address: renderWhereYouAre,
  hours: null, // rendered by renderWhereYouAre
  contact: null, // rendered by renderWhereYouAre
  amenities: renderTheRoom,
  services: renderWhatYouDo,
  staff: renderStaff,
  currentContext: renderRightNow,
  menu: renderWhatYouServe,
  // The prefilled string on the venue's printed QR sign, matched by the
  // Sendblue webhook to tell a QR enrollment from an unprompted inbound
  // (TAC-323). It is plumbing for an inbound classification, not a fact about
  // the venue, and the agent has no use for it in a reply.
  qrEnrollmentMessage: null,
  // The curated link allowlist (TAC-509). v2 renders it through its own lane:
  // run-turn passes `providedLinks` to the generate call and the
  // `unverified_link` policy asks Jev the matching question. Rendering v1's
  // `formatVenueLinks` prose here too would put the allowlist in the prompt
  // twice and import v1 instruction copy into a frame whose design is that
  // style is judged, not legislated.
  links: null,
} satisfies Record<keyof VenueInfo, SectionRenderer | null>

/** Derived from the schema itself so it cannot drift from what Zod accepts. */
const KNOWN_KEYS: ReadonlySet<string> = new Set(
  Object.keys(VenueInfoSchema.shape),
)

/**
 * @throws if `raw` fails VenueInfoSchema. Deliberate: a malformed row means a
 * fact the agent answers with is unreadable, and v1 throws on exactly this.
 */
export function renderVenueProfile(
  raw: unknown,
  now: Date,
): RenderedVenueProfile {
  const parsed = VenueInfoSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `renderVenueProfile: venue_info JSONB validation failed: ${parsed.error.message}`,
    )
  }
  const info = parsed.data

  const unrendered =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k))
      : []

  const blocks: string[] = []
  for (const render of Object.values(SECTIONS)) {
    if (render === null) continue
    const block = render(info, now)
    if (block !== null) blocks.push(block)
  }
  const text = blocks.join('\n\n')
  return { text, unrendered, charCount: text.length }
}
