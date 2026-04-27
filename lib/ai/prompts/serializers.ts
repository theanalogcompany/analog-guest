import type { BrandPersona, VenueInfo } from '@/lib/schemas'
import type { MessageCategory, RuntimeContext, VoiceCorpusChunk } from '../types'

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
  if (hours.notes) lines.push(`  - Notes: ${hours.notes}`)
  return lines.length > 0 ? lines.join('\n') : null
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

export function runtimeToProse(runtime: RuntimeContext, category: MessageCategory): string {
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

  if (lines.length === 0) {
    return `Generate a ${category} message now.`
  }

  return `${lines.join('\n')}\n\nGenerate the message now.`
}