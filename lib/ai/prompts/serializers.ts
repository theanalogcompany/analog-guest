import type { BrandPersona, MenuItem, VenueInfo } from '@/lib/schemas'
import type { MessageCategory, RecentMessage, RuntimeContext, VoiceCorpusChunk } from '../types'

const MAX_HISTORY_BODY_CHARS = 200

const FORMALITY_GUIDANCE: Record<BrandPersona['formality'], string> = {
  casual: 'Use contractions; lowercase starts are fine; write the way you would text a friend.',
  warm: 'Conversational and friendly. Contractions are fine. Avoid stiffness, but stay clear and complete.',
  formal: 'Complete sentences and proper capitalization. No slang. Polite but never stiff.',
}

const EMOJI_GUIDANCE: Record<BrandPersona['emojiPolicy'], string> = {
  never: 'Do not use emoji.',
  sparingly: 'You may use one emoji occasionally — only when it genuinely fits the tone. Default to none.',
  frequent: "Emoji are part of this venue's voice. Use them where they feel natural, but do not stuff them.",
}

function speakerFramingProse(persona: BrandPersona): string {
  switch (persona.speakerFraming) {
    case 'venue':
      return 'Speak as the venue itself ("we"). Do not sign messages with a personal name.'
    case 'named_person':
      return `Sign messages as ${persona.speakerName ?? '[name missing]'}. You are texting on the venue's behalf as that named person.`
    case 'owner':
      return 'Speak as the owner of the venue, in first person. Do not name yourself unless the guest asks.'
  }
}

export function personaToProse(persona: BrandPersona): string {
  const sections: string[] = []

  sections.push(`## Voice and Tone\n${persona.tone}`)
  sections.push(`## How to address the guest\n${speakerFramingProse(persona)}`)
  sections.push(`## Formality\n${persona.formality} — ${FORMALITY_GUIDANCE[persona.formality]}`)
  sections.push(`## Length\n${persona.lengthGuide}`)
  sections.push(`## Emojis\n${persona.emojiPolicy} — ${EMOJI_GUIDANCE[persona.emojiPolicy]}`)

  if (persona.signaturePhrases.length > 0) {
    sections.push(
      `## Phrases the venue uses\n${persona.signaturePhrases.map((p) => `- ${p}`).join('\n')}`,
    )
  }
  if (persona.bannedTopics.length > 0) {
    sections.push(
      `## Topics to avoid\n${persona.bannedTopics.map((t) => `- ${t}`).join('\n')}`,
    )
  }
  if (persona.voiceAntiPatterns.length > 0) {
    sections.push(
      `## Anti-patterns (what NOT to sound like)\n${persona.voiceAntiPatterns.map((a) => `- ${a}`).join('\n')}`,
    )
  }
  if (persona.voiceTouchstones.length > 0) {
    sections.push(
      `## Voice anchors\n${persona.voiceTouchstones.map((v) => `- ${v}`).join('\n')}`,
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

  if (venueInfo.currentContext.length > 0) {
    const contextSection = `## Current context\n${venueInfo.currentContext
      .map((n) => n.content)
      .join('\n\n')}`
    result = `${result}\n\n${contextSection}`
  }

  return result
}

export function ragChunksToProse(chunks: VoiceCorpusChunk[]): string {
  if (chunks.length === 0) return ''

  const blocks = chunks.map((c) => {
    const quoted = c.text.split('\n').map((l) => `> ${l}`).join('\n')
    return `[${c.sourceType}]\n${quoted}`
  })

  return `## Examples of how the venue actually communicates\n${blocks.join('\n\n')}`
}

function formatRightNow(today: NonNullable<RuntimeContext['today']>): string {
  return [
    '## Right now',
    `- Date: ${today.dayOfWeek}, ${today.isoDate}`,
    `- Time at venue: ${today.venueLocalTime} (${today.venueTimezone})`,
  ].join('\n')
}

function formatTimeDelta(then: Date, now: Date): string {
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

function formatRecentConversation(messages: readonly RecentMessage[], now: Date): string | null {
  if (messages.length === 0) return null
  const lines = messages.map((m) => {
    const speaker = m.direction === 'inbound' ? 'guest' : 'venue'
    const delta = formatTimeDelta(m.createdAt, now)
    const body = normalizeHistoryBody(m.body)
    return `[${speaker}, ${delta}] ${body}`
  })
  return `## Recent conversation\n${lines.join('\n')}`
}

export function runtimeToProse(
  runtime: RuntimeContext,
  category: MessageCategory,
  now: Date = new Date(),
): string {
  const blocks: string[] = []

  if (runtime.today) {
    blocks.push(formatRightNow(runtime.today))
  }
  if (runtime.recentMessages && runtime.recentMessages.length > 0) {
    const recent = formatRecentConversation(runtime.recentMessages, now)
    if (recent) blocks.push(recent)
  }

  const lines: string[] = []

  if (runtime.guestName) {
    lines.push(`Guest name: ${runtime.guestName}`)
  }

  switch (category) {
    case 'welcome':
      break
    case 'follow_up':
      if (runtime.lastVisitDate) lines.push(`Last visit: ${runtime.lastVisitDate}`)
      if (runtime.daysSinceLastVisit !== undefined) {
        lines.push(`Days since last visit: ${runtime.daysSinceLastVisit}`)
      }
      break
    case 'reply':
      if (runtime.inboundMessage) lines.push(`The guest just sent: "${runtime.inboundMessage}"`)
      if (runtime.lastVisitDate) lines.push(`Last visit: ${runtime.lastVisitDate}`)
      if (runtime.daysSinceLastVisit !== undefined) {
        lines.push(`Days since last visit: ${runtime.daysSinceLastVisit}`)
      }
      break
    case 'new_question':
      if (runtime.inboundMessage) lines.push(`The guest just asked: "${runtime.inboundMessage}"`)
      break
    case 'opt_out':
      if (runtime.inboundMessage) {
        lines.push(`The guest sent (opt-out request): "${runtime.inboundMessage}"`)
      }
      break
    case 'perk_unlock':
      if (runtime.perkBeingUnlocked) {
        lines.push(`Perk: ${runtime.perkBeingUnlocked.name}`)
        lines.push(`Why they qualified: ${runtime.perkBeingUnlocked.qualification}`)
        lines.push(`What they're being offered: ${runtime.perkBeingUnlocked.rewardDescription}`)
      }
      break
    case 'event_invite':
      if (runtime.eventBeingInvited) {
        lines.push(`Event: ${runtime.eventBeingInvited.name}`)
        lines.push(`Description: ${runtime.eventBeingInvited.description}`)
        lines.push(`Date: ${runtime.eventBeingInvited.date}`)
      }
      break
    case 'manual':
      break
    case 'acknowledgment':
      if (runtime.inboundMessage) {
        lines.push(`The guest just sent: "${runtime.inboundMessage}"`)
      }
      break
  }

  if (runtime.additionalContext) {
    lines.push(`Additional context: ${runtime.additionalContext}`)
  }

  const tail = lines.length === 0 ? `Generate a ${category} message now.` : `${lines.join('\n')}\n\nGenerate the message now.`

  if (blocks.length === 0) return tail
  return `${blocks.join('\n\n')}\n\n${tail}`
}