import type { EligibleMechanic } from '@/lib/recognition'
import {
  type ActiveCommitment,
  type BrandPersona,
  isEmptyGuestContext,
  type MenuItem,
  type ParsedGuestContext,
  parseVenueLinks,
  type VenueInfo,
  type VenueServices,
} from '@/lib/schemas'
import type { MessageChannel } from '@/lib/schemas/message-channel'
import type { EmojiDirective } from '../emoji-cadence'
import {
  applyChannelSubstitutions,
  type ChannelSubstitution,
  copyVariantFor,
} from './channel-variants'
import type {
  FollowupContext,
  FollowupReason,
  KnowledgeCorpusChunk,
  MessageCategory,
  MessageDelivery,
  PendingQuestion,
  RecentMessage,
  RuntimeContext,
  Visit,
  VoiceCorpusChunk,
} from '../types'

const MAX_HISTORY_BODY_CHARS = 200

const FORMALITY_GUIDANCE: Record<BrandPersona['formality'], string> = {
  casual: 'Use contractions; lowercase starts are fine; write the way you would text a friend.',
  warm: 'Conversational and friendly. Contractions are fine. Avoid stiffness, but stay clear and complete.',
  formal: 'Complete sentences and proper capitalization. No slang. Polite but never stiff.',
}

// TAC-495: the casual line's Instagram variant says "message a friend", not
// "text a friend" (approved 2026-09-19), made like the other channel variants
// (channel-variants.ts). The phrase does register work: it is a yardstick for
// how casual to be, and "texting a friend" is the sharper, more universally
// understood anchor, so the swap costs a little precision. It was taken because
// the bigger risk is the model echoing "text" to a guest who isn't texting. If
// the Instagram voice reads more formal than Sendblue's (TAC-469's behavioural
// check), this line is the first place to look. Warm and formal claim no
// channel and are identical on both.
const CASUAL_FORMALITY_CHANNEL_SUBSTITUTIONS = {
  text: [],
  instagram: [{ from: 'write the way you would text a friend.', to: 'write the way you would message a friend.' }],
} as const satisfies Record<MessageChannel, readonly ChannelSubstitution[]>

const CASUAL_FORMALITY_BY_CHANNEL: Record<MessageChannel, string> = {
  text: applyChannelSubstitutions(
    FORMALITY_GUIDANCE.casual,
    CASUAL_FORMALITY_CHANNEL_SUBSTITUTIONS.text,
    'FORMALITY_GUIDANCE.casual/text',
  ),
  instagram: applyChannelSubstitutions(
    FORMALITY_GUIDANCE.casual,
    CASUAL_FORMALITY_CHANNEL_SUBSTITUTIONS.instagram,
    'FORMALITY_GUIDANCE.casual/instagram',
  ),
}

function formalityGuidanceFor(formality: BrandPersona['formality'], channel: MessageChannel | null): string {
  return formality === 'casual' ? CASUAL_FORMALITY_BY_CHANNEL[copyVariantFor(channel)] : FORMALITY_GUIDANCE[formality]
}

const EMOJI_GUIDANCE: Record<BrandPersona['emojiPolicy'], string> = {
  never: 'Do not use emoji.',
  sparingly: 'You may use one emoji occasionally — only when it genuinely fits the tone. Default to none.',
  // TAC-362: `never` and `sparingly` are UNCHANGED and deliberately so —
  // both measure 0 emoji across 240 responses, and rewording a proven path
  // is how you find out it was load-bearing. Only `frequent` moves, because
  // only `frequent` produced the complaint (10 of 11 responses).
  //
  // What was removed: "Use them where they feel natural, but do not stuff
  // them." That is a STANDING LICENCE, evaluated identically on every turn,
  // and a model with a standing licence and no memory of last turn takes it
  // every time. The replacement states the venue fact and then explicitly
  // refuses to be read as a rate — the per-message block is the only thing
  // that decides this turn.
  frequent:
    "Emoji fit this venue's voice. Whether this particular message carries one is decided per message and stated in that message's own instructions; if no such instruction appears, do not use one. Do not read a general rate into this line.",
}

// TAC-338: named_person previously read "texting on the venue's behalf as
// that named person" — third-party framing that let the model refer to
// venue staff as an outsider would. See system-template.ts's v1.39.0
// changelog for the full incident and the reasoning against a symptom-level
// ban. "On the venue's behalf" is a banned framing for this identity fact —
// don't reintroduce it here or in SYSTEM_TEMPLATE's opening line.
//
// TAC-348: named_person previously told the model to "Sign messages as
// {name}." Real iMessage/SMS threads don't carry signatures — a signed
// text reads like an email, not a text from a person — and at least one
// venue needed a manual anti-pattern rule to undo this. Removed outright
// rather than reworded; the sentence had no other job.
//
// TAC-495: the named_person line has a channel variant, made the same way as
// the system template's (channel-variants.ts): the SMS line is written out in
// full and takes no substitutions, and Instagram swaps "texting" for
// "messaging". TAC-338's "as yourself" framing is identical on both. The
// {speakerName} slot is filled after the substitution, so the table is
// applied once, at module load, to a constant.
const NAMED_PERSON_LINE =
  'You are {speakerName}, staff at the venue, texting as yourself. Do not sign messages with your name. You ARE that person, not an outside service representing it.'

const NAMED_PERSON_LINE_CHANNEL_SUBSTITUTIONS = {
  text: [],
  instagram: [{ from: 'staff at the venue, texting as yourself.', to: 'staff at the venue, messaging as yourself.' }],
} as const satisfies Record<MessageChannel, readonly ChannelSubstitution[]>

const NAMED_PERSON_LINE_BY_CHANNEL: Record<MessageChannel, string> = {
  text: applyChannelSubstitutions(
    NAMED_PERSON_LINE,
    NAMED_PERSON_LINE_CHANNEL_SUBSTITUTIONS.text,
    'NAMED_PERSON_LINE/text',
  ),
  instagram: applyChannelSubstitutions(
    NAMED_PERSON_LINE,
    NAMED_PERSON_LINE_CHANNEL_SUBSTITUTIONS.instagram,
    'NAMED_PERSON_LINE/instagram',
  ),
}

function speakerFramingProse(persona: BrandPersona, channel: MessageChannel | null): string {
  switch (persona.speakerFraming) {
    case 'venue':
      return 'Speak as the venue itself ("we"). Do not sign messages with a personal name.'
    case 'named_person':
      // A function replacement, so a name containing "$&" is inserted as typed.
      return NAMED_PERSON_LINE_BY_CHANNEL[copyVariantFor(channel)].replace(
        '{speakerName}',
        () => persona.speakerName ?? '[name missing]',
      )
    case 'owner':
      return 'Speak as the owner of the venue, in first person. Do not name yourself unless the guest asks.'
  }
}

/**
 * Render one persona list entry as a bullet that OWNS its own structure.
 *
 * TAC-313. These entries are operator-authored free text and routinely carry
 * paragraphs, and sometimes their own nested list. Splicing them in raw as
 * `- ${text}` corrupts the result in two ways, both silent:
 *
 *   1. A continuation paragraph renders flush-left with no bullet, so it reads
 *      as document-level prose rather than part of the rule above it. Mock
 *      Sextant's out-of-domain anti-pattern is three paragraphs: ¶1 supplies
 *      the phrase "not my world", ¶2 is the carve-out forbidding that phrase
 *      for documented nearby places. ¶1 got the bullet, ¶2 trailed as loose
 *      text, and the agent hedged on a recommendation it had documented.
 *   2. An entry containing its own `- ` list emits those inner bullets at the
 *      SAME level as the anti-patterns themselves. This is worse than a
 *      formatting nit, because the enclosing heading is "Anti-patterns (what
 *      NOT to sound like)": Sextant's recommendation-shapes entry lists four
 *      GOOD shapes ("One pick, nothing after it."), and each was rendering as
 *      its own top-level bullet under that heading. Four rules written to shape
 *      recommendations were being read as things to avoid. Measured on the live
 *      persona: 30 stored anti-patterns rendered as 34 bullets, with 4
 *      flush-left orphan lines.
 *
 * Indenting every line after the first keeps the entry one unit. Blank lines
 * stay genuinely blank (no trailing spaces) so paragraph breaks survive.
 *
 * Single-line entries — the overwhelming majority — render byte-identically to
 * before, which is what makes this safe to apply to every persona list field.
 */
function personaBullet(text: string): string {
  const [first = '', ...rest] = text.split('\n')
  return [`- ${first}`, ...rest.map((line) => (line.trim() === '' ? '' : `  ${line}`))].join('\n')
}

/**
 * `channel` picks the channel copy (the named_person line and the casual formality line).
 * Required, with no default: there are two production callers and each has to
 * decide. composePrompt passes the conversation's channel; the classifier
 * passes 'text', because its prompt is not guest-facing and TAC-495 leaves it
 * exactly as it was.
 */
export function personaToProse(persona: BrandPersona, channel: MessageChannel | null): string {
  const sections: string[] = []

  sections.push(`## Voice and Tone\n${persona.tone}`)
  sections.push(`## How to address the guest\n${speakerFramingProse(persona, channel)}`)
  sections.push(`## Formality\n${persona.formality} — ${formalityGuidanceFor(persona.formality, channel)}`)
  sections.push(`## Length\n${persona.lengthGuide}`)
  sections.push(`## Emojis\n${persona.emojiPolicy} — ${EMOJI_GUIDANCE[persona.emojiPolicy]}`)

  if (persona.signaturePhrases.length > 0) {
    sections.push(
      `## Phrases the venue uses\n${persona.signaturePhrases.map(personaBullet).join('\n')}`,
    )
  }
  if (persona.bannedTopics.length > 0) {
    sections.push(
      `## Topics to avoid\n${persona.bannedTopics.map(personaBullet).join('\n')}`,
    )
  }
  if (persona.voiceAntiPatterns.length > 0) {
    sections.push(
      `## Anti-patterns (what NOT to sound like)\n${persona.voiceAntiPatterns.map((a) => personaBullet(a.text)).join('\n')}`,
    )
  }
  if (persona.voiceTouchstones.length > 0) {
    sections.push(
      `## Voice anchors\n${persona.voiceTouchstones.map(personaBullet).join('\n')}`,
    )
  }

  return sections.join('\n\n')
}

function formatAddress(addr: VenueInfo['address']): string {
  const parts = [addr.line1, addr.line2, `${addr.city}, ${addr.region} ${addr.postalCode}`].filter(
    (p): p is string => Boolean(p),
  )
  return parts.join(', ')
}

function formatHours(hours: VenueInfo['hours']): string | null {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
  const lines: string[] = []
  for (const day of days) {
    const value = hours[day]
    if (value) lines.push(`  - ${day[0].toUpperCase() + day.slice(1)}: ${value}`)
  }
  if (hours.notes) {
    // Notes can be multi-line (operator may write several `- **<key>:** <val>`
    // bullets, which the parser joins with \n). Indent each line under a
    // single Notes: bullet so multi-line notes don't break the outer Hours:
    // structure.
    const noteLines = hours.notes.split('\n').filter((l) => l.trim().length > 0)
    if (noteLines.length === 1) {
      lines.push(`  - Notes: ${noteLines[0]}`)
    } else if (noteLines.length > 1) {
      lines.push(`  - Notes:`)
      for (const noteLine of noteLines) {
        lines.push(`    - ${noteLine}`)
      }
    }
  }
  return lines.length > 0 ? lines.join('\n') : null
}

function formatMenuItemLine(item: MenuItem): string {
  const parts: string[] = [item.name]
  if (item.size) parts.push(item.size)
  if (item.price !== undefined) {
    parts.push(`$${item.price.toFixed(2)}`)
  } else if (item.priceNote) {
    parts.push(item.priceNote)
  }
  if (item.modifiers.length > 0) {
    parts.push(`modifiers: ${item.modifiers.join(', ')}`)
  }
  if (item.dietary.length > 0) {
    parts.push(`dietary: ${item.dietary.join(', ')}`)
  }
  return `- ${parts.join(' — ')}`
}

function compareItems(a: MenuItem, b: MenuItem): number {
  const c = a.category.localeCompare(b.category)
  if (c !== 0) return c
  return a.name.localeCompare(b.name)
}

function formatMenuItems(items: readonly MenuItem[]): string | null {
  if (items.length === 0) return null

  const onMenu = items.filter((i) => !i.isOffMenu).slice().sort(compareItems)
  const offMenu = items.filter((i) => i.isOffMenu).slice().sort(compareItems)

  const sections: string[] = []
  if (onMenu.length > 0) {
    sections.push(`On-menu:\n${onMenu.map(formatMenuItemLine).join('\n')}`)
  }
  if (offMenu.length > 0) {
    sections.push(`Off-menu (by request):\n${offMenu.map(formatMenuItemLine).join('\n')}`)
  }

  return `## Menu (structured)\n${sections.join('\n\n')}`
}

function formatAmenities(amenities: NonNullable<VenueInfo['amenities']>): string | null {
  const lines: string[] = []
  if (amenities.wifi !== undefined) lines.push(`  - WiFi: ${amenities.wifi ? 'yes' : 'no'}`)
  if (amenities.petFriendly !== undefined) lines.push(`  - Pet-friendly: ${amenities.petFriendly ? 'yes' : 'no'}`)
  if (amenities.parking) lines.push(`  - Parking: ${amenities.parking}`)
  if (amenities.seating) lines.push(`  - Seating: ${amenities.seating}`)
  if (amenities.notes) lines.push(`  - Notes: ${amenities.notes}`)
  return lines.length > 0 ? lines.join('\n') : null
}

function formatContact(contact: VenueInfo['contact']): string | null {
  const lines: string[] = []
  if (contact.publicPhone) lines.push(`  - Phone: ${contact.publicPhone}`)
  if (contact.publicEmail) lines.push(`  - Email: ${contact.publicEmail}`)
  if (contact.website) lines.push(`  - Website: ${contact.website}`)
  return lines.length > 0 ? lines.join('\n') : null
}

/**
 * TAC-301 part 2: render what the venue does and doesn't do as its OWN
 * section, not a sub-bullet.
 *
 * The capability facts were reaching the prompt before this — Le Mil's
 * "walk-in only, ordering at the counter only" sat in `amenities.notes`, one
 * indented line between parking and contact details, presented as an attribute
 * of the venue rather than a constraint on what may be offered. It was read
 * and ignored on the turn that mattered.
 *
 * Three-state rendering, each failing in the safe direction:
 *   false     explicit negative. The half that does the work — absence from a
 *             list of offerings does not stop the agent; a stated "no" does.
 *   true      positive, so a venue that DOES hold doesn't get denied.
 *   absent    nothing at all.
 *
 * The closing line is deliberately weaker than formatMechanicEligibility's
 * "the list below is the complete set". That block can claim completeness
 * because it's generated from a full table; this one is hand-curated and will
 * have gaps, and a completeness claim would turn every unmodelled real service
 * into a false denial. "Not listed is unknown, not available" gives the model
 * a don't-invent default without asserting the list is exhaustive.
 */
const SERVICE_LABELS: Record<
  keyof Omit<VenueServices, 'alsoOffers' | 'alsoDoesNotOffer'>,
  string
> = {
  aheadOrdering: 'Ordering ahead',
  holds: 'Holding or setting items aside',
  reservations: 'Reservations',
  delivery: 'Delivery',
  catering: 'Catering',
}

function formatVenueServices(services: VenueServices): string | null {
  const offered: string[] = []
  const notOffered: string[] = []

  for (const key of Object.keys(SERVICE_LABELS) as Array<keyof typeof SERVICE_LABELS>) {
    const value = services[key]
    // Strict boolean checks: `undefined` means nobody said, and must fall
    // through to NEITHER list.
    if (value === true) offered.push(SERVICE_LABELS[key])
    else if (value === false) notOffered.push(SERVICE_LABELS[key])
  }
  // Trim and drop blanks: z.array(z.string()) accepts '', which would render
  // a bare "- : available" line and still pass the emptiness guard below.
  for (const extra of services.alsoOffers) {
    const t = extra.trim()
    if (t.length > 0) offered.push(t)
  }
  for (const extra of services.alsoDoesNotOffer) {
    const t = extra.trim()
    if (t.length > 0) notOffered.push(t)
  }

  if (offered.length === 0 && notOffered.length === 0) return null

  const lines: string[] = [
    "## What this venue does and doesn't offer",
    'What this venue can and cannot do for a guest. Do not offer or confirm anything marked NOT available, however the guest asks for it, and do not propose a workaround that amounts to the same thing.',
  ]
  for (const label of offered) lines.push(`- ${label}: available`)
  for (const label of notOffered) lines.push(`- ${label}: NOT available`)
  // Absence is NOT unavailability. The earlier wording ("not listed is
  // unknown, not available") quietly re-read every unstated service as a
  // denial the moment a venue filled in one field — which is the exact
  // outcome VenueServicesSchema's docstring says must never happen, just
  // narrowed from "unconfigured venues" to "partially configured" ones. Le
  // Mil's is partially configured on day one.
  lines.push(
    'Anything not listed here has not been stated either way. Do not assume it is available, and do not tell the guest it is unavailable.',
  )
  return lines.join('\n')
}

export function venueInfoToProse(venueInfo: VenueInfo): string {
  const lines: string[] = ['## Venue facts']

  lines.push(`- Address: ${formatAddress(venueInfo.address)}`)

  const hoursBlock = formatHours(venueInfo.hours)
  if (hoursBlock) lines.push(`- Hours:\n${hoursBlock}`)

  if (venueInfo.menu.highlights.length > 0) {
    lines.push(`- Menu highlights: ${venueInfo.menu.highlights.join(', ')}`)
  }
  if (venueInfo.menu.notes) {
    lines.push(`- Menu notes: ${venueInfo.menu.notes}`)
  }
  if (venueInfo.staff.length > 0) {
    lines.push(`- Staff names: ${venueInfo.staff.join(', ')}`)
  }
  if (venueInfo.amenities) {
    const amenitiesBlock = formatAmenities(venueInfo.amenities)
    if (amenitiesBlock) lines.push(`- Amenities:\n${amenitiesBlock}`)
  }
  const contactBlock = formatContact(venueInfo.contact)
  if (contactBlock) lines.push(`- Contact:\n${contactBlock}`)

  let result = lines.join('\n')

  // Per THE-169: items = facts (structured table); notes = stories (already
  // rendered above as prose). Rendering items as their own section near the
  // menu prose gives Sonnet a clean per-item lookup surface.
  const menuItemsBlock = formatMenuItems(venueInfo.menu.items)
  if (menuItemsBlock) {
    result = `${result}\n\n${menuItemsBlock}`
  }

  if (venueInfo.services) {
    const servicesBlock = formatVenueServices(venueInfo.services)
    if (servicesBlock) result = `${result}\n\n${servicesBlock}`
  }

  if (venueInfo.currentContext.length > 0) {
    const contextSection = `## Current context\n${venueInfo.currentContext
      .map((n) => n.content)
      .join('\n\n')}`
    result = `${result}\n\n${contextSection}`
  }

  // TAC-509. ALWAYS rendered, including the empty state: the empty state is
  // what answers the threat this exists for, which is the model building a
  // plausible lemils.com/products/... out of what it knows about Shopify with
  // no link ever having appeared in its source material.
  result = `${result}\n\n${formatVenueLinks(venueInfo.links)}`

  return result
}

/**
 * The `## Links` section: the curated allowlist, plus the instruction that it
 * is exhaustive (TAC-509).
 *
 * The hard enforcement is lib/ai/url-detector.ts inside the regen loop, not
 * this prose — a draft carrying an unlisted link is held whatever the model
 * read here. This section is what makes the model get it right the first time,
 * and what gives it the labels it needs to pick the link that answers the
 * question actually asked.
 *
 * "including the https:// at the start" is from the device UAT (2026-09-21):
 * the agent wrote the right page as `lemils.com/products/le-mils-budan-bold`,
 * the way anyone writes a link in a DM, and the draft was held. The detector
 * now supplies a missing scheme so that case matches anyway, but a link the
 * model writes in full is one the guest can tap in every client, so the
 * instruction says to copy the scheme rather than leaving it to the check.
 *
 * The empty state's last sentence is load-bearing. The venue's own knowledge
 * entries say "on lemils.com", the detector never fires on a bare domain, and
 * without that sentence a blanket "no web addresses" would quietly suppress
 * phrasing the venue actually uses.
 */
export function formatVenueLinks(rawLinks: unknown): string {
  const links = parseVenueLinks(rawLinks)
  if (links.length === 0) {
    return [
      '## Links',
      'There are no links you may share. Do not put a web address in your reply.',
      'Naming the site the way the venue knowledge already does is fine.',
    ].join('\n')
  }
  const listed = links.map((l) => `- ${l.label}: ${l.url}`).join('\n')
  return [
    '## Links',
    'These are the only links you may share:',
    listed,
    '',
    'Copy a link exactly as it appears here, character for character, including the https:// at the start. Share one only when it answers what the guest actually asked. Never share a link that is not on this list, and never build one from a pattern.',
  ].join('\n')
}

export function ragChunksToProse(chunks: VoiceCorpusChunk[]): string {
  if (chunks.length === 0) return ''

  const blocks = chunks.map((c) => {
    const quoted = c.text.split('\n').map((l) => `> ${l}`).join('\n')
    return `[${c.sourceType}]\n${quoted}`
  })

  return `## Examples of how the venue actually communicates\n${blocks.join('\n\n')}`
}

// Render retrieved knowledge_corpus chunks as a `## Venue knowledge` block.
// Each chunk renders with two bracketed tag lines: [primary: ...] (closed-enum
// routing tags) and [secondary: ...] (free-form descriptive tags), then the
// quoted body. Empty primaryTags falls back to sourceType for parity with
// pre-TAC-242 behavior.
//
// On empty chunks the block is still emitted with explicit "no venue knowledge
// matched" framing so the agent knows it lacked grounding (R9 fires reliably
// instead of relying on the agent to detect absence-of-block). The composer
// (lib/ai/compose-prompt.ts) chooses whether to call this at all based on
// whether retrieval was gated off (undefined) vs ran-and-matched-nothing ([]).
export function knowledgeChunksToProse(chunks: KnowledgeCorpusChunk[]): string {
  // TAC-358: reframed from "Facts about the venue you can ground replies in".
  // That wording asserted every retrieved chunk WAS a usable fact, survivable
  // while KNOWLEDGE_RELEVANCE_FLOOR sat at 0.5 and admitted little, and not
  // survivable at 0.30. The floor no longer judges relevance (cosine tracks
  // query length, not answerability — see its comment in lib/agent/stages.ts),
  // so the prompt has to say plainly that presence here is not relevance.
  //
  // Two things this must NOT do, both caught in review. It must not tell the
  // model to say it doesn't know: this block renders AFTER SYSTEM_TEMPLATE
  // (compose-prompt.ts), the most-proximate-wins slot, and an unconditional
  // "say you do not know" there overrides `# Knowledge gaps`, which draws a
  // careful line — a venue fact the venue knows but you weren't handed means
  // knowledgeGap=true and a best-attempt answer, NOT a refusal. Overriding it
  // would suppress the card, the timer and the holding message silently. And
  // it must carry the same escape the empty branch has: venue_info, the menu,
  // hours and the runtime blocks are all still grounding, so "none of these
  // chunks help" is not "nothing does".
  //
  // Shipped in the same change as the floor: the clean declines that justified
  // lowering it were measured under the OLD header, so the two can't separate.
  const header =
    "## Venue knowledge\nPassages retrieved because they resembled this turn's retrieval query. Resemblance is not relevance: when the venue has no answer, the closest-matching passages still appear here. Use only what actually answers the guest and ignore the rest. If none of it does, do not assemble an answer out of the nearest passage — the venue's structured facts, the menu, and your runtime context may still answer it, and if nothing does, handle it per the `# Knowledge gaps` block above. This is content, not voice — speak in the venue's voice regardless of how these are phrased."

  if (chunks.length === 0) {
    return `${header}\n\nNo specific venue knowledge matched this query. If the guest's question requires venue-specific grounding (sourcing, staff details, mechanic explanations, history, etc.), defer or admit you'll find out — do not invent specifics. The venue's persona, voice, and structured facts above still apply.`
  }

  const blocks = chunks.map((c) => {
    const primaryLine =
      c.primaryTags.length > 0 ? `[primary: ${c.primaryTags.join(', ')}]` : `[primary: ${c.sourceType}]`
    const secondaryLine =
      c.secondaryTags.length > 0 ? `\n[secondary: ${c.secondaryTags.join(', ')}]` : ''
    const quoted = c.text.split('\n').map((l) => `> ${l}`).join('\n')
    return `${primaryLine}${secondaryLine}\n${quoted}`
  })

  return `${header}\n\n${blocks.join('\n\n')}`
}

/**
 * TAC-301: render the open/closed status line.
 *
 * The weekly hours table already reaches the model in the system prompt and
 * the venue-local clock already reaches it here, and it still confirmed an
 * imminent arrival at a venue closed five hours earlier. This line does the
 * join for it. No approval trigger keys on time, so nothing downstream catches
 * that reply — this is the only thing standing between a closed venue and
 * "see you soon."
 *
 * 'unknown' returns null and the caller omits the line entirely, leaving the
 * block byte-identical to its pre-TAC-301 shape. That silence is deliberate:
 * see the governing rule in lib/schemas/venue-hours.ts.
 */
function formatOpenStatus(openState: NonNullable<RuntimeContext['today']>['openState']): string | null {
  if (!openState) return null

  if (openState.state === 'open') {
    return `- Status: OPEN right now, closes at ${openState.closesAt}.`
  }

  if (openState.state === 'closed') {
    // Facts first, instruction last — the instruction sits closest to
    // generation, and the model shouldn't have to read around it to find the
    // next opening.
    //
    // "come by now" is scoped deliberately. An unscoped "do not tell the guest
    // to come by" would contradict comp-complaint's own designed remedy
    // (categories/comp-complaint.ts: "asking them to come back and have
    // another one on us"), which is an entirely ordinary thing to say at 8pm
    // about a drink from that morning. What this line exists to stop is a
    // confirmation for RIGHT NOW, not a future invitation.
    const next = openState.opensAt
      ? ` Next open ${openState.opensAt.day} at ${openState.opensAt.time}.`
      : ''
    return `- Status: CLOSED right now.${next} Do not tell the guest to come by now, and do not confirm anything for right now.`
  }

  return null
}

function formatRightNow(today: NonNullable<RuntimeContext['today']>): string {
  const lines = [
    '## Right now',
    `- Date: ${today.dayOfWeek}, ${today.isoDate}`,
    `- Time at venue: ${today.venueLocalTime} (${today.venueTimezone})`,
  ]

  const status = formatOpenStatus(today.openState)
  if (status) lines.push(status)

  return lines.join('\n')
}

// Exported so formatVisitHistory below shares the same delta vocabulary
// the recent-conversation block uses ("yesterday" / "N days ago" / etc.).
// Module-private otherwise.
export function formatTimeDelta(then: Date, now: Date): string {
  const diffMs = now.getTime() - then.getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  if (hours < 48) return 'yesterday'
  const days = Math.floor(hours / 24)
  return `${days} days ago`
}

function normalizeHistoryBody(body: string): string {
  const collapsed = body.replace(/\s*\n\s*/g, ' ').trim()
  if (collapsed.length <= MAX_HISTORY_BODY_CHARS) return collapsed
  return `${collapsed.slice(0, MAX_HISTORY_BODY_CHARS)}…`
}

// TAC-394: the bracket marker for a history line the guest never received, or
// null for one they did. Shared with the classifier's renderer
// (lib/ai/classify-message.ts) so the two cannot describe the same line
// differently. An exhaustive switch, so a new MessageDelivery value fails tsc
// here rather than rendering as if it were sent.
//
// Every marker says WHY the line never arrived, not only that it did not. A
// draft the venue decided against and a send that failed both went unread, but
// only the first was a decision, and "never sent" with no reason can nudge the
// model to raise what an operator rejected (2026-09-14 ruling).
export function historyDeliveryMarker(delivery: MessageDelivery): string | null {
  switch (delivery) {
    case 'delivered':
      return null
    case 'awaiting_review':
      return 'NOT SENT: waiting for the venue to approve it'
    case 'skipped_by_operator':
      return 'NOT SENT: the venue decided not to send it'
    case 'never_sent':
      return 'NEVER SENT: it failed to send'
  }
}

// TAC-394: renders whenever any line carries a marker. Shared with the
// classifier for the same reason as the marker itself.
export const UNSENT_HISTORY_NOTE =
  'Lines marked NOT SENT or NEVER SENT never reached the guest. They have not read them.'

function formatRecentConversation(messages: readonly RecentMessage[], now: Date): string | null {
  if (messages.length === 0) return null
  const lines = messages.map((m) => {
    const speaker = m.direction === 'inbound' ? 'guest' : 'venue'
    const delta = formatTimeDelta(m.createdAt, now)
    const body = normalizeHistoryBody(m.body)
    const marker = historyDeliveryMarker(m.delivery)
    return marker === null ? `[${speaker}, ${delta}] ${body}` : `[${speaker}, ${delta}, ${marker}] ${body}`
  })
  const block = `## Recent conversation\n${lines.join('\n')}`
  // A history with nothing unsent renders exactly as it did before TAC-394:
  // the note is appended only when a marker is present.
  //
  // Deliberately no instruction about what to do with an unsent line. v1.50.0
  // was first built with one: the reply takes the pending draft's place, so
  // offer a pending comp, hold or discount again. On the incident turn it
  // produced replies answering two things at once that kept em dashes and
  // sometimes self-rated voice fidelity 0.00, which generateStage refuses. The
  // 2026-09-14 ruling removed it. Keeping a pending obligation from being
  // overwritten is the gate's job (TAC-394 PR 2), not the prompt's.
  if (!messages.some((m) => m.delivery !== 'delivered')) return block
  return `${block}\n\n${UNSENT_HISTORY_NOTE}`
}

// TAC-244: human-readable label for a FollowupReason. Internal taxonomy
// (post_visit_day_7, cold_lapsed) gets converted to natural phrasing for the
// prompt — but the `## Follow-up context` intro tells Sonnet not to speak
// the labels back to the guest. The labels are reasoning fuel, not voice.
function followupReasonLabel(reason: FollowupReason): string {
  switch (reason) {
    case 'post_visit_day_1':
      return 'post-visit day 1'
    case 'post_visit_day_3':
      return 'post-visit day 3'
    case 'post_visit_day_7':
      return 'post-visit day 7'
    case 'post_visit_day_14':
      return 'post-visit day 14'
    case 'cold_lapsed':
      return 'cold lapsed (re-engagement)'
    // TAC-123: a perk this guest just became eligible for. The actual perk
    // detail rides in the `## Perk being unlocked` block; this label just
    // names the reason in the follow-up context list.
    case 'perk_unlock':
      return 'perk just unlocked'
  }
}

// TAC-244: render `## Follow-up context` block when the AI runtime carries
// the outbound-flow followup field. Block placement is immediately BEFORE
// `## Visit history` — intent-then-evidence (this block states *why* we're
// reaching out; visit history is the supporting detail). Multi-reason
// rendering uses Draft A's weaving rider (operator-picked 2026-06-02) framed
// positively via medium ("write the single text a thoughtful owner would
// actually send"), not a prohibitive "don't enumerate" rule — the category
// instruction carries the hard guardrail against leaking internal taxonomy
// to the guest.
function formatFollowupContext(
  followup: FollowupContext,
  now: Date,
): string | null {
  if (followup.reasons.length === 0) return null
  const reasonsLine = `Reasons: ${followup.reasons.map(followupReasonLabel).join(', ')}`
  const lines = [reasonsLine]
  if (followup.anchorVisit) {
    lines.push(`Days since last visit: ${followup.daysSinceLastVisit}`)
    const delta = formatTimeDelta(followup.anchorVisit.visitedAt, now)
    const items = followup.anchorVisit.items?.length
      ? ` — ${followup.anchorVisit.items.join(', ')}`
      : ''
    lines.push(`Last visit anchor: ${delta}${items}`)
  }
  const intro =
    'This message is an unprompted check-in from the venue — the venue is reaching out, not replying to a message the guest just sent. Use this to inform tone and what to reference.'
  const sections = ['## Follow-up context', intro, lines.join('\n')]
  if (followup.reasons.length > 1) {
    sections.push(
      "Multiple reasons apply. Write the single text a thoughtful owner would actually send — touch what's genuinely worth mentioning, lead with one and fold in the other, drop one if it doesn't fit.",
    )
  }
  return sections.join('\n')
}

// TAC-234: render the recent transactions as a bulleted list. Bracketed
// time-delta matches the ## Recent conversation block style. The intro
// line tells Sonnet how to use the data — pattern recognition for
// recommendations, NOT reciting it back at the guest (R11 reinforces).
function formatVisitHistory(
  visits: readonly Visit[],
  now: Date,
): string | null {
  if (visits.length === 0) return null
  const lines = visits.map((v) => {
    const delta = formatTimeDelta(v.visitedAt, now)
    const items = v.items.join(', ')
    return `- [${delta}] ${items}`
  })
  return [
    '## Visit history',
    "Recent transactions, most recent first. Use this to recognize patterns and offer relevant suggestions — don't recite history back at the guest.",
    lines.join('\n'),
  ].join('\n')
}

// Category gate for the Visit History block. Welcome is the first-contact
// NFC-tap reply (no prior visits to reference by definition); opt_out is a
// stop-messaging acknowledgment where prior orders aren't relevant. All
// other categories render the block when recentVisits is non-empty.
function shouldRenderVisitHistory(category: MessageCategory): boolean {
  return category !== 'welcome' && category !== 'opt_out'
}

// TAC-328: category gate for the first-touch intentions block. A qr_scan
// guest's very first message can itself be an opt-out — nothing about
// build-runtime-context.ts's created_via/expiry/prompted-keys gating knows
// the classified category (classification runs AFTER context_build in the
// inbound pipeline, so it isn't available yet at derivation time). This is
// the earliest point in the pipeline where category is actually in scope,
// mirroring shouldRenderVisitHistory's placement immediately above for the
// same category. Suppressing the whole block (rather than trusting the
// opt_out category instruction's "don't try to retain them" prose alone) is
// the point: a guest asking to stop being contacted should never share a
// prompt with goals to pursue (TAC-380: renderableIntentions suppresses this
// upstream too; this check stays as the render-time second line),
// including the TAC-329 first-touch opener paragraph nested inside the same
// block.
//
// TAC-436 added comp_complaint, and it is the structural half of ruling 1. That
// ruling licenses answering the guest and then asking one small thing, and
// without this gate the licence would reach a complaint turn: "sorry the cortado
// was cold, what should we do, also do you live nearby?". The block renders LAST
// in the user prompt where COMP_COMPLAINT_INSTRUCTIONS lives in the SYSTEM
// prompt, so on proximity the block wins — the TAC-314/329/330/338 failure
// class. The paragraph says the same thing in prose as a second line; this is
// the one that cannot be talked past. Same pair shouldRenderEmojiDirective
// already excludes, for the same reason on a different axis.
//
// Still not a claim that these two are the only categories that should ever
// suppress this block. No other category has been audited for it.
function shouldRenderOpenIntentions(category: MessageCategory): boolean {
  return category !== 'opt_out' && category !== 'comp_complaint'
}

// Voices regen-loop block. The operator's free-text critique of the
// flagged outbound is rendered as the very first block in the user prompt
// (above `## Right now`) so Sonnet treats it as the dominant signal.
// Only populated by the regen endpoint; production agent runs never pass
// this.
function formatCritiqueToIncorporate(critique: string): string {
  return [
    '## Critique to incorporate',
    'A previous attempt at this message was flagged. The operator wrote:',
    critique,
    'Take this critique seriously. Generate a new message that addresses it directly while still speaking in the venue\'s voice.',
  ].join('\n')
}

// THE-232: render the operator's note from the Command Center Follow Up
// modal as a prominent top-level block. The note is the dominant signal
// for what the message should say; surrounding runtime context (mechanics,
// visit history, recent conversation) informs how to say it. The agent
// still speaks in the venue's voice — the note is content guidance only,
// not phrasing to mimic. This guardrail is reinforced in the manual-category
// instructions.
function formatOperatorInstruction(instruction: string): string {
  return [
    '## Operator instruction',
    `The operator wants you to follow up with this guest about: ${instruction}`,
    'Draft a message that addresses this directly, in the venue\'s voice.',
  ].join('\n')
}

// TAC-296: rendered `## Guest context` block. Approximate hard cap of ~500
// tokens enforced as a character budget (≈4 chars/token). Truncation order
// when the block would exceed the budget: (1) trim observations to the
// last GUEST_CONTEXT_OBSERVATIONS_FLOOR entries; (2) if still over budget,
// drop life_context entries from the oldest first. The OBSERVATION_RENDER_LIMIT
// truncation already happened in toParsedGuestContext (last 10); this layer
// handles the further fallback to the 5-floor.
const GUEST_CONTEXT_CHAR_BUDGET = 2000
const GUEST_CONTEXT_OBSERVATIONS_FLOOR = 5

function formatGuestDetailsLines(
  details: NonNullable<ParsedGuestContext['guest_details']>,
): string[] {
  const lines: string[] = []
  if (details.first_name) lines.push(`- First name: ${details.first_name}`)
  if (details.last_name) lines.push(`- Last name: ${details.last_name}`)
  if (details.pronouns) lines.push(`- Pronouns: ${details.pronouns}`)
  if (details.date_of_birth) lines.push(`- Date of birth: ${details.date_of_birth}`)
  // TAC-300: home_base / workplace are bare strings post-normalize. Legacy
  // nested-object reads are flattened in toParsedGuestContext, so the
  // serializer only ever sees a string here.
  if (details.home_base) lines.push(`- Home base: ${details.home_base}`)
  if (details.workplace) lines.push(`- Work: ${details.workplace}`)
  return lines
}

function formatPreferencesLines(
  prefs: NonNullable<ParsedGuestContext['preferences']>,
): string[] {
  const lines: string[] = []
  if (prefs.dietary && prefs.dietary.length > 0) {
    lines.push(`- Dietary: ${prefs.dietary.join(', ')}`)
  }
  if (prefs.favorites && prefs.favorites.length > 0) {
    lines.push(`- Favorites: ${prefs.favorites.join(', ')}`)
  }
  if (prefs.dislikes && prefs.dislikes.length > 0) {
    lines.push(`- Dislikes: ${prefs.dislikes.join(', ')}`)
  }
  return lines
}

function renderGuestContextBody(context: ParsedGuestContext): string {
  const sections: string[] = []

  if (context.guest_details) {
    const lines = formatGuestDetailsLines(context.guest_details)
    if (lines.length > 0) sections.push(`Who they are:\n${lines.join('\n')}`)
  }
  if (context.preferences) {
    const lines = formatPreferencesLines(context.preferences)
    if (lines.length > 0) sections.push(`What they like:\n${lines.join('\n')}`)
  }
  if (context.life_context && context.life_context.length > 0) {
    const lines = context.life_context.map((e) => `- ${e.note}`)
    sections.push(`Life context (time-bound):\n${lines.join('\n')}`)
  }
  if (context.observations && context.observations.length > 0) {
    const lines = context.observations.map((e) => `- ${e.note}`)
    sections.push(`Observations:\n${lines.join('\n')}`)
  }

  const intro =
    "Things the guest has shared across past conversations. Use this to recognize patterns and reference what they've told you — do not introduce facts the guest hasn't mentioned."

  return `## Guest context\n${intro}\n\n${sections.join('\n\n')}`
}

function formatGuestContext(context: ParsedGuestContext): string | null {
  if (isEmptyGuestContext(context)) return null

  let rendered = renderGuestContextBody(context)
  if (rendered.length <= GUEST_CONTEXT_CHAR_BUDGET) return rendered

  // First fallback: trim observations to the floor.
  if (context.observations && context.observations.length > GUEST_CONTEXT_OBSERVATIONS_FLOOR) {
    const trimmed: ParsedGuestContext = {
      ...context,
      observations: context.observations.slice(-GUEST_CONTEXT_OBSERVATIONS_FLOOR),
    }
    rendered = renderGuestContextBody(trimmed)
    if (rendered.length <= GUEST_CONTEXT_CHAR_BUDGET) return rendered
    context = trimmed
  }

  // Second fallback: drop life_context entries from the oldest first. Entries
  // are stored most-recent-last (append order), so we slice from the end.
  if (context.life_context && context.life_context.length > 0) {
    let keepCount = context.life_context.length - 1
    while (keepCount >= 0) {
      const trimmed: ParsedGuestContext = {
        ...context,
        life_context: keepCount === 0 ? undefined : context.life_context.slice(-keepCount),
      }
      rendered = renderGuestContextBody(trimmed)
      if (rendered.length <= GUEST_CONTEXT_CHAR_BUDGET) return rendered
      keepCount -= 1
    }
  }

  // Even after both fallbacks we're over budget — return the smallest
  // rendition anyway. Voice fidelity still beats blocking the agent run on a
  // soft token budget.
  return rendered
}

// TAC-297: render open + pending_ack commitments as a `## Active commitments`
// block. Placement (between Guest context and Recent conversation) puts it
// in the reading order "who they are → what they can get → what they've
// recently bought → what we know about them as a person → what we've promised
// → what was recently said." The intro line frames it as PERMISSION to ask
// about arrival timing if it fits, NOT as a standing directive to ask every
// turn (TAC-297 plan-review call #5 — interrogation-risk mitigation). Empty
// commitments list omits the block entirely (zero tokens, no header without
// body).
//
// Per-commitment line shape: `- [type] description (id: <uuid>, code: XXXX, status: ...) — promised <delta>`
// The id is a system-internal handle for the arrivalCapture structured emission
// (referencesCommitmentId) — it is NEVER spoken to the guest. Code is omitted
// for recommendation type (no verification chip for recs). Status appears so
// the model knows whether the commitment is freshly open or already
// pending_ack (already-pending = guest already signaled, no point asking
// arrival again). Time-delta uses the same vocabulary as the Recent
// conversation block via formatTimeDelta. TAC-302: the id was missing
// through v1.17.0, so arrivalCapture.referencesCommitmentId had no value to
// reference — every arrival capture no-op'd and no commitment ever reached
// pending_ack. Added in v1.18.0.
//
// TAC-389: the intro varies on an operator-initiated decline turn, and only
// the intro — the per-line shape above is identical on both branches, because
// the id / code / status segments are what let the writer name the right
// promise whichever turn this is.
//
// Ruling 2 (2026-09-17) drops the two arrival-ask sentences on that branch.
// They are correct everywhere else and wrong here: this message is the one
// that CANCELS the promise, so inviting the guest over for it, or asking when
// they are coming in, contradicts the message being written. The ordinary
// branch keeps them byte for byte.
//
// The last sentence is retained VERBATIM on both branches. Its second half is
// the only thing standing between a rendered uuid and a guest reading one
// aloud in a text (TAC-302), and its first half is conditioned on a guest
// arrival signal, which a decline turn does not have — there is no inbound on
// this path at all, so the condition simply never fires.
//
// The two new sentences carry no em dash. The decline path already goes out of
// its way to avoid them (buildDeclineHint, handle-operator-decline.ts: Sonnet
// echoes the punctuation it is shown, and R3 forbids one in the output, so an
// echoed dash costs a regen attempt). The retained sentence's dash is
// pre-existing and renders on this path today.
function formatActiveCommitments(
  commitments: readonly ActiveCommitment[],
  now: Date,
  isOperatorDecline: boolean,
): string | null {
  if (commitments.length === 0) return null

  const lines = commitments.map((c) => {
    const segments: string[] = [`id: ${c.id}`]
    if (c.code) segments.push(`code: ${c.code}`)
    segments.push(`status: ${c.status}`)
    const delta = formatTimeDelta(new Date(c.created_at), now)
    return `- [${c.type}] ${c.description} (${segments.join(', ')}) — promised ${delta}`
  })

  // Retained verbatim on both branches — see the header note.
  const idSentence =
    'Each line carries an internal `id:` — copy that value verbatim into arrivalCapture.referencesCommitmentId when the guest signals arrival, and into cancelsCommitmentId when your reply takes that promise back. The id is system-internal: never read it aloud, never include it in your reply to the guest.'

  const intro = isOperatorDecline
    ? 'The promise this message is declining. The venue can no longer honor it, and it is the only promise listed here, so this is the one to name. ' +
      'Do not ask when the guest is coming in, and do not invite them over for it. This message cancels the promise, so an arrival ask would contradict it. ' +
      idSentence
    : 'Open promises this venue has made to this guest. ' +
      "If you're offering something new (comp / hold), include the arrival ask in the same breath ('give me a heads up when you're heading over'). " +
      "If a commitment is still open without an arrival signal, you MAY weave the ask in naturally — but never force it, never pester. Don't repeat the ask if status is already 'pending_ack' (the guest has already signaled). " +
      idSentence

  return ['## Active commitments', intro, lines.join('\n')].join('\n')
}

// TAC-308: render the outstanding knowledge-gap question as an
// `## Unanswered question` block, immediately before `## Recent conversation`
// — it is the most recent unresolved state in the thread, and it sits next to
// the history the model would otherwise mine for a promise to imitate.
//
// The modes render DIFFERENT and mutually non-contradictory instructions.
// That is the point of the discriminator: an earlier two-boolean shape had the
// block telling the model not to say it was checking on the very turn whose
// entire job is to say exactly that.
//
//   outstanding     — guest has heard nothing and will hear nothing
//                     automatically. Reply to the new message; do not promise,
//                     do not date, do not claim to be checking.
//   writing_holding — THIS generation is the holding message. Say we're on
//                     it, in the venue's voice, with no time attached and no
//                     attempt at the answer.
//
// TAC-484 DELETED a third, 'acknowledged' ("the guest already got the holding
// message"), and rewrote what's left of 'outstanding'. Both had become false.
// `mode` was derived from `pending_until !== null`, a proxy for "a holding
// message was sent" that stopped tracking it the moment a backstop catch could
// no longer arm the clock: every backstop card read as 'acknowledged' and told
// the model the guest had been told something nobody had said. 'outstanding'
// was no better, since "the system is handling that separately" is false for
// every card while the holding message is disabled.
//
// The honest signal is whether a holding message was actually SENT, and there
// isn't one to read. The only candidate is an outbound row with
// category='manual' and a reply_to_message_id pointing at the question, and
// category='manual' is shared with manual followups (triggerToCategory), which
// only fail to collide because they leave reply_to_message_id null. That is an
// undocumented coincidence, it costs a third round trip on a per-turn path,
// and it would feed a branch that is unreachable today. So the mode collapses
// to one text instead (ruled 2026-09-22).
//
// TAC-491, when it brings the holding message back for a subset of cards:
// re-add 'acknowledged' with its old text, and key it on a REAL marker that
// the send writes, not on pending_until. `tsc` will make the switch below tell
// you where to put it.
//
// The question text is rendered verbatim so the holding message can be
// specific about WHAT is outstanding without the model re-deriving it from
// conversation history.
function formatPendingQuestion(pending: PendingQuestion, now: Date): string {
  const delta = formatTimeDelta(pending.askedAt, now)
  const header = '## Unanswered question'
  const asked = `The guest asked this ${delta} and the venue still owes them an answer:\n"${pending.question}"`

  switch (pending.mode) {
    case 'writing_holding':
      return [
        header,
        asked,
        "Someone at the venue is working on it and hasn't come back yet. This message is the holding note, and it is the only thing you are writing right now.",
        "Say that you're still on it, in the venue's voice, the way a person would if they'd been asked something and hadn't chased it down yet. Keep it short.",
        'Do not attempt the answer. Do not say when the answer will come, do not name a time or a day, and do not say "soon" or "shortly" or anything else that implies a deadline. Do not apologize more than once. Do not offer anything to make up for the wait.',
      ].join('\n\n')
    case 'outstanding':
      return [
        header,
        asked,
        // The ruled text, minus its opening sentence ("An earlier question
        // from this guest is still waiting on the venue"), which the `asked`
        // line directly above already says.
        "Nothing has been sent to them about it, and nothing will be sent automatically. Don't tell them it's being looked into, don't give a time, and don't attempt the answer yourself. Reply to whatever their newest message actually asks.",
        'If their newest message is asking about this same outstanding thing, set knowledgeGap=true again rather than attempting the answer. Nothing has changed since they asked.',
      ].join('\n\n')
  }
}

// THE-170: render a deterministic eligibility block. Empty array is meaningful
// — the framing instructs Sonnet not to offer perks at all. Non-empty renders
// the allowlist with name + reward + qualification context.
// v1.24.0: `willBeReviewed` conditions the denial. It is true only when the
// turn is already certain to be routed to operator approval by its CATEGORY,
// which is knowable before generation because classification runs first. That
// certainty is what makes a comp-forward draft safe: a human sees it before
// the guest does.
//
// When false, the categorical denial below stands EXACTLY as it did in
// v1.23.0. The auto-send path is not relaxed by one word. This is the whole
// design: warmth is unlocked by the gate, not by loosening the brake.
function formatMechanicEligibility(
  mechanics: readonly EligibleMechanic[],
  willBeReviewed: boolean,
): string {
  const header = '## What this guest can access'
  if (mechanics.length === 0) {
    // "hasn't yet earned access" was earn/loyalty framing sitting in the live
    // prompt on every new-guest turn — the exact vocabulary CLAUDE.md's
    // product principles forbid ("guests do not earn things; they get
    // recognized"). Replaced with recognition framing. Kept just as
    // restrictive: the empty-list instruction is load-bearing against
    // eligibility leaks, and "of any kind" now explicitly covers remakes and
    // replacements after the 2026-08-07 incident, where the model reasoned a
    // remake was "not a perk" and offered it anyway.
    if (willBeReviewed) {
      return `${header}\nThere's nothing standing set aside for this guest yet, and no perk to unlock.\nThat does not mean you have nothing to offer. Someone at the venue reads this message and approves it before the guest ever sees it, so you can propose putting something right. Asking them to come back for another on us is the normal shape of that. Propose it plainly and let the venue decide.`
    }
    return `${header}\nNothing right now beyond the standard menu and answering questions. There's nothing set aside for this guest to be recognized with yet. Do not offer perks of any kind. Do not offer comps, remakes, replacements, or discounts either. None of those are available for this guest.`
  }
  const intro =
    'The list below is the complete set of perks, invites, and unlocks this guest is currently eligible for. Do not offer items that are not on this list. If the guest asks for something not listed, acknowledge naturally and decline without invoking the item by name.'
  const bullets = mechanics.map((m) => {
    const reward = m.rewardDescription ? ` — ${m.rewardDescription}` : ''
    const qual = m.qualification ? ` (${m.qualification})` : ''
    // TAC-212: surface the per-mechanic operator-approval flag inline so the
    // model knows committing this mechanic should set
    // requiresOperatorApproval=true on its structured output.
    const approval = m.requiresOperatorApproval
      ? ' [operator approval required: if you commit this guest to this, set requiresOperatorApproval=true]'
      : ''
    return `- ${m.name}${reward}${qual}${approval}`
  })
  const reviewedRider = willBeReviewed
    ? "\nSomeone at the venue approves this message before the guest sees it, so if putting things right calls for something beyond the list, propose it and let them decide."
    : ''
  return `${header}\n${intro}\n${bullets.join('\n')}${reviewedRider}`
}

// TAC-324: render open first-touch intentions as a `## What you're hoping to
// get to` block. Position: after `## What this guest can access`, before
// `## Follow-up context` / `## Visit history` — Sana's own goals sit with
// who-the-guest-is, not with what-was-recently-said. Only ever non-empty on
// the inbound path (build-runtime-context.ts gates it there), so this never
// co-renders with the followup-only blocks in practice — the ordering just
// keeps a single deterministic position regardless.
//
// The non-steering paragraph below is load-bearing in the same way the
// empty-mechanics framing above is: it's what turns "things Sana wants" into
// "not a checklist to work through," and doesn't get trimmed for brevity.
// "You haven't heard what they ordered yet" invites a natural moment;
// "ask what they ordered" demands one — that difference is the whole point
// of rendering these as states Sana is in, not instructions to execute.
//
// TAC-329: on a guest's true first message (firstTouchAfterQrScan, the same
// flag gating R1's carve-out in SYSTEM_TEMPLATE — reused, not redefined), an
// opener paragraph leads the block. It sets a goal ("this turn is the
// opener"), not a scripted sentence — Sonnet writes the actual greeting in
// its own words every time, so two guests scanning side by side get the same
// instruction and different output. Leads rather than appends: the
// non-steering paragraph ends "Never steer back to them," and appending
// directly after it made "them" ambiguous and framed the opener as an
// exception carved out of a prohibition rather than this turn's actual job.
//
// The paragraph is split, not unconditional: `firstTouchAfterQrScan` fires on
// ANY qr_scan guest's true first message, not just a bare greeting — a real
// question ("are you open right now?") is just as likely as "Hi Sana!". Say
// hello and identify yourself never conflicts with answering a question, so
// that half is unconditional; the first-time question is explicitly deferred
// to whichever the guest's actual message calls for, so a genuine question
// never loses to a scripted one. `firstTouchAfterQrScan` requires
// `recentMessages.length === 0`, so unlike the tracked intentions this
// condition is true exactly once — there's no later turn to defer the
// greeting itself to, only the first-time question.
//
// Tradeoff, not a side effect: the opener lives inside this function, behind
// the same `lines.length === 0` guard as the rest of the block. If the
// `guest_intention_prompts` read fails and build-runtime-context.ts's
// fail-closed posture empties `openIntentions`, the opener disappears along
// with the whole block — on exactly the turn this ticket exists to fix.
// Accepted for pilot scale; revisit if it's ever observed in the wild.
//
// TAC-330: the non-steering paragraph above is symmetric — it has no way to
// distinguish the guest raising their own topic from the guest replying to
// something Sana herself just asked. Live turn two: Sana's opener asked
// "first time in, or have you been coming around for a while?", the guest
// answered "first time!", and the restraint (correctly tuned against a
// DIFFERENT case — Sana pivoting from a parking question back to the order)
// fired anyway, because nothing told it these two situations differ.
//
// The second paragraph adds a bounded exception, appended rather than
// rewritten so the original four sentences stay byte-identical. It is
// DELIBERATELY narrower than "Sana's last message was any question" — Sana
// ends messages with questions constantly, so that condition would have
// licensed a pivot after almost any exchange, including the exact
// TAC-324 pivot the paragraph exists to prevent (plan-review caught this:
// venue asks about parking, closes with "you heading in soon?", guest
// replies "yeah, ten minutes" — that answers Sana's question but has
// nothing to do with the intention). The condition is tied to the CONTENT
// of Sana's question — did she ask the guest something about themselves
// (new vs. regular, that kind of thing) — not merely its presence. A
// logistics/timing question doesn't qualify; the first-touch opener does.
//
// Residual risk, on the record rather than assumed away (plan-review note):
// what actually separates the two cases for the model is the worked
// exemplar ("new or a regular"), not a crisp category boundary — "you
// heading in soon?" is also technically a question about the guest. A
// tighter category would need a runtime signal or would collapse back into
// the same circular "natural door" phrasing already in paragraph one, so
// this is accepted rather than solved. UAT covers the parking-shaped case
// explicitly (ticket §9) because it's the one most likely to fail.
//
// TAC-380: up to seven lines can render at once now, ordered by
// IntentionDefinition.priority (derive.ts sorts them). The one added sentence,
// "take the one listed first", is what makes that order mean something to the
// model. Without it the ranking ruled on the ticket (event-armed intentions
// first, because they perish) would be decorative.
// TAC-423 (2026-09-22). The opener states the SITUATION and then asks one
// thing: what the guest just got. The question is SCAFFOLDING, not the
// intended design, and the comment says so because the next reader will
// otherwise reasonably delete it.
//
// The intended design is that the opener states facts and the intention lines
// below carry the ask. understand_order is first in that list on this turn,
// ungated, armed by the scan itself, and its line says exactly what this
// sentence says. Two instructions for one ask is the shape this whole ticket
// is about. It was built that way and MEASURED, 20 generations per arm on the
// live config, and the intention line could not carry it:
//
//   opener asks        asks something 20/20   asks the ORDER 20/20
//   opener silent      asks something 20/20   asks the ORDER 11/20
//
// The nine misses are worse than the number. Five asked how it was, which is
// did_they_like_it, an intention NOT open on this turn (it arms on a recorded
// order and there is none), and an answer naming no item captures nothing and
// gives reportsTodaysScanVisit nothing to fire on. Four reverted to asking
// whether this was the guest's first time, which is the behaviour this ticket
// was filed to delete, with nothing in the prompt asking for it. An opener
// that reintroduces the original bug half the time is not an improvement on a
// scripted one (ruled 2026-09-22).
//
// SO: the scripted question stays until TAC-519 establishes why intentions are
// so rarely raised and fixes it. scripts/measurement/first-touch-question.ts is
// the harness that produced those numbers and is the one that should decide
// when this sentence comes out. At 55% today the intention line cannot carry
// the ask on its own.
//
// Three things left with it, each ruled:
//
//   1. The thank-you is gone. Le Mil's caps replies at "one-liners or two
//      sentences at most" and ## Length is the only authority on length, so a
//      four-act prescription into a two-sentence budget means the model drops
//      one, and the one it dropped was the warmth. Dropped here instead, so
//      the reply is a hello and one question by design. Warmth is voice.
//
//   2. The identity clause is conditional on the guest's own message not
//      naming a person, and says out loud that it beats the venue's voice
//      setting. It has to: speakerFramingProse's `owner` branch renders "Do
//      not name yourself unless the guest asks", this paragraph renders later
//      in the user prompt, and it was already overriding that silently. Le
//      Mil's prefill names the venue and not a person, so every ordinary scan
//      takes the introduce branch.
//
//   3. Present tense. "have just ordered and collected it" replaces "have
//      already ordered and have it in hand ... what it was". The recency sits
//      on the ORDER, never on the guest's whereabouts, so R1's "without
//      assuming they're still on-site" carve-out is untouched: that carve-out
//      exists because the agent once told a guest who had left that the
//      password was on the board. The tense matters beyond reading well.
//      extract-reported-order.ts reads a report with no timing cue as one
//      about today, dates it to venue-local noon and records it loosely, and
//      a loose visit blocks the post-visit followup ladder outright. This
//      wording invites an answer that carries a now-cue. It cannot guarantee
//      one, which is why the same ticket also taught the extractor that a
//      scan-day report is a receipt.
//
// The two CLAUSES that used to sit after the question are still gone, and they
// are a separate thing from the question itself. The paragraph rendered
// directly beneath says both: "take the one listed first, and only that one",
// and "Asking never changes what the reply is about ... the question goes at
// the end, in one short line, or not at all." The second of them was also the
// deadlock sentence TAC-436 deleted from that paragraph, surviving here in
// different words and so invisible to the canary guarding it. Consequence,
// ruled rather than inherited: a guest who scans AND asks something gets their
// answer plus one short question, where the old opener held the question back.
// serializers.test.ts carries a canary on this paragraph's own dropped
// wording, since the existing one could not see it.
//
// Honest note on that rationale, because the measurement did not support it:
// the deferral clause was expected to SUPPRESS the ask on a turn where the
// guest asks something of their own, and on that scenario the old opener asked
// 20/20 anyway. On this turn shape the clause was inert. TAC-436's own
// measurement was of the restraint paragraph on ordinary turns, a different
// population, and it stands; this says only that the opener's copy of it was
// doing nothing here. The clause stays out on the ruling, not on this
// evidence.
//
// TAC-495: the SMS copy is this string with no substitutions, so it is
// byte-identical by construction; the Instagram variant swaps ONE phrase, down
// from two. The old second swap existed only to turn "who they're texting"
// into "who they're messaging", and "who they've reached" is true on both
// channels, so it is deleted. Every presence phrase (scanned at pickup, just
// ordered and collected) is identical on both channels by ruling.
// channel-variants.ts has the mechanism; a phrase that stops matching throws
// at load, which is what keeps the two channels from drifting apart.
const FIRST_TOUCH_OPENER =
  "This is the guest's first message on this number, sent right after they scanned the sign at your pickup counter. They have just ordered and collected it. Say hello. If their message doesn't name a person, say who they've reached as well, even where your voice guidance would otherwise have you hold your name back. Ask what they just got."

const FIRST_TOUCH_OPENER_CHANNEL_SUBSTITUTIONS = {
  text: [],
  instagram: [
    { from: "This is the guest's first message on this number,", to: "This is the guest's first message," },
  ],
} as const satisfies Record<MessageChannel, readonly ChannelSubstitution[]>

const FIRST_TOUCH_OPENER_BY_CHANNEL: Record<MessageChannel, string> = {
  text: applyChannelSubstitutions(
    FIRST_TOUCH_OPENER,
    FIRST_TOUCH_OPENER_CHANNEL_SUBSTITUTIONS.text,
    'FIRST_TOUCH_OPENER/text',
  ),
  instagram: applyChannelSubstitutions(
    FIRST_TOUCH_OPENER,
    FIRST_TOUCH_OPENER_CHANNEL_SUBSTITUTIONS.instagram,
    'FIRST_TOUCH_OPENER/instagram',
  ),
}

/** The first-visit opener for a conversation's channel; null gets the Instagram copy. */
export function firstTouchOpenerFor(channel: MessageChannel | null): string {
  return FIRST_TOUCH_OPENER_BY_CHANNEL[copyVariantFor(channel)]
}

function formatOpenIntentions(
  lines: readonly string[],
  firstTouchAfterQrScan: boolean,
  channel: MessageChannel | null,
): string | null {
  if (lines.length === 0) return null
  const header = "## What you're hoping to get to"
  // TAC-423, ruled 2026-09-18. The opener's fallback question used to be
  // "ask whether it's their first time" — a second, independently-authored
  // instruction competing with understand_order's own line in this same
  // block, with nothing reconciling them. The QR sign is assumed to be at
  // the drink pickup counter (ruled; not made configurable, no second venue
  // yet), so the guest sending this message is standing there holding a
  // drink they already ordered. Asking whether it's their first time primes
  // curiosity about a new guest; it doesn't capture the one thing this turn
  // can capture with no other path (TAC-325's whole premise). The opener now
  // asks the same question understand_order already wants asked, so the two
  // agree instead of racing.
  //
  // TAC-436 ruling 1, approved 2026-09-17. See the block comment above for what
  // changed and why: one restraint removed, the openings named positively.
  //
  // Deliberately no em dash anywhere, where the replaced text had two. R3 bans
  // them in output and the regen loop pays for every one that survives, so the
  // prompt should not model them.
  //
  // Deliberately no emoji in the worked example either, though the ruling's own
  // example carried one: this block renders immediately before the per-message
  // emoji call, and an example with an emoji would argue with a 'none'
  // directive on roughly a quarter of turns at a frequent venue.
  const paragraph = [
    "These are things you'd like to get to, not a checklist to work through.",
    'If more than one would fit, take the one listed first, and only that one.',
    '',
    'A natural opening is ordinary and small. Any of these is one:',
    '',
    "- You've answered what they asked and the reply feels finished. One",
    '  short question on the end is fine: "we\'re open till 3 on Sundays.',
    '  you nearby?"',
    "- They've said something about themselves, however small, and asking",
    '  the obvious next thing is what anyone would do.',
    "- There's nothing they need from you in the message. They're chatting,",
    '  and a question is a fair way to keep it going.',
    '- Your own last message asked them something about themselves and this',
    "  reply answers it. You asked, so following it up isn't a pivot. That",
    '  covers this one reply only, whatever they say back.',
    '',
    'Not an opening: a message carrying an apology, bad news, or something',
    "they're unhappy about. Leave those alone entirely.",
    '',
    'Asking never changes what the reply is about. Whatever they raised is',
    'still the job, and the question goes at the end, in one short line, or',
    'not at all. Never steer the conversation toward one of these, and never',
    'raise one twice.',
    '',
    'If nothing fits, let it wait. There will be other conversations.',
  ].join('\n')
  const opener = firstTouchAfterQrScan ? `${firstTouchOpenerFor(channel)}\n\n` : ''
  return `${header}\n${opener}${lines.join('\n')}\n\n${paragraph}`
}

/**
 * TAC-362: categories where no per-message emoji permission may render.
 *
 * Mirrors shouldRenderOpenIntentions / shouldRenderVisitHistory above, and
 * exists for the same structural reason: this block lands LAST in the user
 * prompt, and a category instruction lives in the SYSTEM prompt, so on
 * proximity the block wins. That is the TAC-314/329/330/338 failure class.
 *
 * - `opt_out` is the compliance case and the reason this gate exists at all.
 *   OPT_OUT_INSTRUCTIONS asks for "respectful and final, like a person
 *   quietly nodding rather than a system reading a compliance script"; a
 *   trailing "an emoji is welcome here" would have outranked it on ~75% of
 *   opt-outs at a `frequent` venue. Same carve-out `hold_all_outbound` and
 *   POLICY_EXEMPT_CATEGORIES already give opt_out elsewhere.
 * - `comp_complaint` is the voice case: an emoji on "sorry your drink was
 *   wrong" is a defect, and permission is the wrong thing to hand the model
 *   on an apology turn.
 *
 * Both are strictly NARROWER than what shipped before this ticket — the old
 * `frequent` guidance carried a standing licence on every turn including
 * these two — so this can only reduce emoji, never add them. Scope is
 * otherwise unaudited: this is not a claim that these are the only two
 * categories that should suppress the block.
 *
 * TAC-389 adds a third suppression, and it is NOT a category, which is the
 * whole reason it needed the flag rather than another entry in the list
 * above. An operator-initiated decline renders as category 'manual', shared
 * with ordinary Command Center follow-ups (THE-232), which keep the directive.
 * The two are only distinguishable per turn, by `isOperatorDecline`.
 *
 * Same argument as `comp_complaint`, unmodified: permission is the wrong
 * thing to hand the model on an apology turn, and a decline is an apology for
 * cancelling something the venue promised. The block renders LAST in the user
 * prompt, so on proximity it beats anything the operator instruction says. At
 * a `frequent` venue it was reaching roughly three decline drafts in four.
 * Narrower again, so it can still only reduce emoji.
 */
function shouldRenderEmojiDirective(
  category: MessageCategory,
  isOperatorDecline: boolean,
): boolean {
  return (
    category !== 'opt_out' &&
    category !== 'comp_complaint' &&
    !isOperatorDecline
  )
}

/**
 * TAC-362: the per-message emoji call, rendered as the last BLOCK of the
 * user prompt — ahead of the runtime-facts tail (guest name, the inbound
 * line, guest relationship), so it is the last INSTRUCTION the model reads,
 * though not literally the last text before "Generate the message now."
 *
 * Both branches are deliberately worded, and the asymmetry is the design:
 *
 *   'none'    — a flat prohibition for THIS message. Measured 0 violations
 *               in 240 responses, which is what makes the variation real
 *               rather than requested: whatever the model would have done,
 *               a `none` turn reliably carries no emoji.
 *   'allowed' — PERMISSION, never a mandate, and capped at one. "Use an
 *               emoji here" would restore the determinism this ticket
 *               exists to remove, just at a lower rate. Because the model
 *               can decline, the realised rate sits below the probability
 *               and the failure direction is fewer emoji, never more.
 */
function formatEmojiDirective(directive: EmojiDirective): string {
  const body =
    directive === 'none'
      ? 'No emoji in this message. Write it without one.'
      : 'An emoji is welcome in this message if one genuinely fits. At most one, and only if it fits — if it does not, leave it out.'
  return `## Emoji for this message\n${body}`
}

// TAC-495: the first-touch signal line. Identical on both channels: it claims
// no number and no texting, and "scanned" is presence language, out of scope by
// ruling. Exported so tests can assert its absence by the real string rather
// than a fragment that would stop matching the day it was reworded.
//
// It is also what switches on R1's exception in SYSTEM_TEMPLATE, which applies
// "when the context says this is the guest's first message after they scanned a
// sign at the venue". Nothing structural links the two: the model matches them.
// The opener's first sentence says the same thing, so R1 still fires where the
// opener renders; on opt_out, comp_complaint and empty-intention turns this line
// is the only trigger. compose-prompt.test.ts holds the pair together.
export const FIRST_TOUCH_SIGNAL_LINE =
  "This is the guest's first message, sent after they scanned your venue's QR sign."

/**
 * `channel` picks the channel copy (today, only the first-visit opener's). It
 * defaults to null, the unknown channel, which gets the copy that asserts no
 * phone number: absence is the safe direction, which is what licenses a
 * default here (the TAC-362 emojiDirective rule). composePrompt is the only
 * production caller and always passes GenerateMessageInput.channel; a test pins
 * that it is the only one.
 */
export function runtimeToProse(
  runtime: RuntimeContext,
  category: MessageCategory,
  now: Date = new Date(),
  channel: MessageChannel | null = null,
): string {
  const blocks: string[] = []

  // Critique block sits above everything — when present it's the
  // dominant signal Sonnet should attend to. Voices regen path only.
  if (runtime.critiqueToIncorporate) {
    blocks.push(formatCritiqueToIncorporate(runtime.critiqueToIncorporate))
  }
  if (runtime.today) {
    blocks.push(formatRightNow(runtime.today))
  }
  // THE-232: Operator instruction block sits above runtime context
  // (mechanics, last visit, recent conversation) so Sonnet treats it as the
  // primary intent. Only fires when the operator typed a note in the Follow
  // Up modal — note-less manual sends and cron-triggered followups skip the
  // block.
  if (runtime.operatorInstruction) {
    blocks.push(formatOperatorInstruction(runtime.operatorInstruction))
  }
  if (runtime.mechanics !== undefined) {
    blocks.push(formatMechanicEligibility(runtime.mechanics, runtime.willBeReviewed === true))
  }
  // TAC-244: ## Follow-up context sits immediately BEFORE ## Visit history.
  // Intent-then-evidence — this block states *why* we're reaching out;
  // Visit history is the supporting detail it draws on. Only set on the
  // outbound flow (handleFollowup → buildAiRuntime derives from
  // followupTrigger). Absent on inbound runs by construction (the
  // entry-point assertion in handleInbound guarantees followupTrigger=null
  // there, so deriveFollowupContext returns undefined).
  if (runtime.followup) {
    const block = formatFollowupContext(runtime.followup, now)
    if (block) blocks.push(block)
  }
  // TAC-234: ## Visit history block sits between mechanics and recent
  // conversation. Reading order: who they are → what they can get → what
  // they've recently bought → what was recently said. Skipped at the block
  // level (not per category) for welcome and opt_out.
  if (
    runtime.recentVisits &&
    runtime.recentVisits.length > 0 &&
    shouldRenderVisitHistory(category)
  ) {
    const block = formatVisitHistory(runtime.recentVisits, now)
    if (block) blocks.push(block)
  }
  // TAC-296: ## Guest context sits between visit history and recent
  // conversation. Reading order continued: ... what they've recently bought →
  // what we know about them as a person → what was recently said. Block is
  // omitted entirely (zero tokens) when the guest has no captured context.
  // No category gate — guest context is useful for every category including
  // welcome (e.g., a NFC-tap from a known phone whose context says "vegan").
  if (runtime.guestContext) {
    const block = formatGuestContext(runtime.guestContext)
    if (block) blocks.push(block)
  }
  // TAC-297: ## Active commitments block sits between Guest context and
  // Recent conversation. Reading order continued: ... what we know about
  // them as a person → what we've promised → what was recently said.
  // Empty / undefined = block omitted entirely.
  if (runtime.activeCommitments && runtime.activeCommitments.length > 0) {
    const block = formatActiveCommitments(
      runtime.activeCommitments,
      now,
      runtime.isOperatorDecline === true,
    )
    if (block) blocks.push(block)
  }
  // TAC-308: ## Unanswered question sits immediately BEFORE ## Recent
  // conversation. Two reasons for the placement: it is the most recent
  // unresolved state in the thread, and it lands next to the history the
  // model would otherwise mine for an earlier "let me find out" to imitate.
  // undefined = nothing outstanding, block omitted entirely.
  if (runtime.pendingQuestion) {
    blocks.push(formatPendingQuestion(runtime.pendingQuestion, now))
  }
  if (runtime.recentMessages && runtime.recentMessages.length > 0) {
    const recent = formatRecentConversation(runtime.recentMessages, now)
    if (recent) blocks.push(recent)
  }

  // TAC-519: ## What you're hoping to get to renders LAST of the content blocks,
  // after ## Recent conversation and immediately before the emoji directive.
  //
  // TAC-324 put it between mechanics and visit history, on the reading that
  // Sana's own goals sit with who-the-guest-is rather than with
  // what-was-recently-said. That reading is tidy and it cost the feature its
  // entire purpose: from there the block was 3rd of 7 on an ordinary turn, with
  // ## Visit history, ## Active commitments and ## Recent conversation after it,
  // and intentions were raised on 4 of 39 real Le Mil's turns that rendered them.
  //
  // MEASURED, not reasoned. Replaying those same 39 turns with only this move
  // applied, and everything else byte-for-byte equal, took the raise rate from
  // 4/35 to 13/35 (11% -> 37%); learn_name, armed for 7 guests and asked 0 times
  // in production, was raised 4 times. The rewrite of the block's own restraint
  // paragraph was measured in the same run as a separate arm and was WORSE on
  // both populations, so it was dropped: the position was the defect, not the
  // wording. See TAC-519 for the run and the pre-registered bars.
  //
  // This is the most-proximate-wins failure class CLAUDE.md records five prior
  // fixes for (TAC-314/329/330/338/362). Nothing had measured this block's
  // position since TAC-324 chose it.
  //
  // NOT after the emoji directive, which keeps its own last-block position:
  // that one is measured (TAC-362) and demoting a measured mechanism to promote
  // this one is not a trade this ticket makes.
  if (shouldRenderOpenIntentions(category) && runtime.openIntentions && runtime.openIntentions.length > 0) {
    const block = formatOpenIntentions(
      runtime.openIntentions,
      runtime.firstTouchAfterQrScan === true,
      channel,
    )
    if (block) blocks.push(block)
  }

  // TAC-362: last block in, so it is the most-proximate instruction before
  // the generate line. Absent directive renders nothing at all, which leaves
  // the persona's standing `## Emojis` statement governing the turn — see
  // the field comment on RuntimeContext.emojiDirective for why absence is
  // the safe direction rather than a gap.
  if (
    runtime.emojiDirective &&
    shouldRenderEmojiDirective(category, runtime.isOperatorDecline === true)
  ) {
    blocks.push(formatEmojiDirective(runtime.emojiDirective))
  }

  const lines: string[] = []

  if (runtime.guestName) {
    lines.push(`Guest name: ${runtime.guestName}`)
  }

  // TAC-234: field-presence rendering. The orchestrator (handleInbound vs
  // handleFollowup) enforces mutual exclusion between inbound flow
  // (inboundMessage set) and outbound flow (perkBeingUnlocked or
  // eventBeingInvited set). Type-system enforcement is TAC-243 backlog.
  if (runtime.inboundMessage) {
    lines.push(`The guest just sent: "${runtime.inboundMessage}"`)
  }
  // TAC-324: R1 carve-out signal. This is the ONLY place createdVia/timing
  // surfaces in the prompt — without this line the model has no way to know
  // a guest arrived via QR scan, since createdVia isn't rendered anywhere
  // else. See SYSTEM_TEMPLATE's R1 for the exception this enables.
  if (runtime.firstTouchAfterQrScan) {
    lines.push(FIRST_TOUCH_SIGNAL_LINE)
  }
  if (runtime.recognition?.state) {
    lines.push(`Guest relationship: ${runtime.recognition.state}`)
  }
  if (runtime.perkBeingUnlocked) {
    lines.push(`Perk: ${runtime.perkBeingUnlocked.name}`)
    lines.push(`Why they qualified: ${runtime.perkBeingUnlocked.qualification}`)
    lines.push(`What they're being offered: ${runtime.perkBeingUnlocked.rewardDescription}`)
  }
  if (runtime.eventBeingInvited) {
    lines.push(`Event: ${runtime.eventBeingInvited.name}`)
    lines.push(`Description: ${runtime.eventBeingInvited.description}`)
    lines.push(`Date: ${runtime.eventBeingInvited.date}`)
  }

  if (runtime.additionalContext) {
    lines.push(`Additional context: ${runtime.additionalContext}`)
  }

  const tail = lines.length === 0 ? `Generate a ${category} message now.` : `${lines.join('\n')}\n\nGenerate the message now.`

  if (blocks.length === 0) return tail
  return `${blocks.join('\n\n')}\n\n${tail}`
}