import { z } from 'zod'
import {
  type BrandPersona,
  BrandPersonaSchema,
  type VenueInfo,
  VenueInfoSchema,
} from '@/lib/schemas'

const DEFAULT_CONFIDENCE_SCORE = 0.85

export interface MechanicSpec {
  type: 'perk' | 'referral' | 'content_unlock' | 'event_invite' | 'merch'
  name: string
  description?: string
  qualification?: string
  reward_description?: string
  expiration_rule?: string
  trigger: Record<string, unknown>
  redemption?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

const MechanicSchema = z.object({
  type: z.enum(['perk', 'referral', 'content_unlock', 'event_invite', 'merch']),
  name: z.string().min(1),
  description: z.string().optional(),
  qualification: z.string().optional(),
  reward_description: z.string().optional(),
  expiration_rule: z.string().optional(),
  trigger: z.record(z.string(), z.unknown()),
  redemption: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export interface VoiceCorpusSpec {
  source_type: string
  content: string
  tags: string[]
  confidence_score: number
}

const VoiceCorpusSchema = z.object({
  source_type: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  confidence_score: z.number().min(0).max(1).default(DEFAULT_CONFIDENCE_SCORE),
})

export interface ParsedVenueSpec {
  slug: string
  name: string
  timezone: string
  brandPersona: BrandPersona
  venueInfo: VenueInfo
  mechanics: MechanicSpec[]
  voiceCorpus: VoiceCorpusSpec[]
}

function splitByHeading(markdown: string, level: 2 | 3): Array<{ title: string; content: string }> {
  const re = level === 2 ? /^##\s+(.+?)\s*$/ : /^###\s+(.+?)\s*$/
  const lines = markdown.split('\n')
  const sections: Array<{ title: string; content: string }> = []
  let current: { title: string; content: string } | null = null
  for (const line of lines) {
    const m = re.exec(line)
    if (m) {
      if (current) sections.push(current)
      current = { title: m[1], content: '' }
    } else if (current) {
      current.content += line + '\n'
    }
  }
  if (current) sections.push(current)
  return sections
}

function extractJsonBlocks(content: string): unknown[] {
  const blocks: unknown[] = []
  const re = /```json\s*\n([\s\S]*?)\n```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    try {
      blocks.push(JSON.parse(m[1]))
    } catch (e) {
      throw new Error(
        `parse-venue-spec: invalid JSON block:\n${m[1]}\n  → ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
  return blocks
}

function extractBullets(content: string): string[] {
  return content
    .split('\n')
    .filter((l) => /^\s*-\s/.test(l))
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter((s) => s.length > 0)
}

function extractKvBullets(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const re = /^\s*-\s*\*\*([^:]+):\*\*\s*(.+?)\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    result[m[1].toLowerCase()] = m[2].trim()
  }
  return result
}

// "*(none)*", "*(not provided)*", etc. → undefined
function isPlaceholder(value: string): boolean {
  const v = value.toLowerCase()
  return v.includes('*(none') || v.includes('not provided') || v === 'none'
}

// "value (some annotation)" → "value"
function stripParenAnnotation(value: string): string {
  return value.replace(/\s*\*?\(.*?\)\*?\s*$/, '').trim()
}

type HoursObject = {
  monday?: string
  tuesday?: string
  wednesday?: string
  thursday?: string
  friday?: string
  saturday?: string
  sunday?: string
  notes?: string
}

const DAY_KEY_MAP: Record<string, Exclude<keyof HoursObject, 'notes'>> = {
  mon: 'monday',
  monday: 'monday',
  tue: 'tuesday',
  tues: 'tuesday',
  tuesday: 'tuesday',
  wed: 'wednesday',
  weds: 'wednesday',
  wednesday: 'wednesday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  thursday: 'thursday',
  fri: 'friday',
  friday: 'friday',
  sat: 'saturday',
  saturday: 'saturday',
  sun: 'sunday',
  sunday: 'sunday',
}

/**
 * Parse the Hours sub-section of section 2 (Airtable intake). The format is
 * a markdown table with at minimum `| Day | Open | Close |` columns (and an
 * optional 4th `Notes` column), followed by zero or more `- **<key>:** <val>`
 * bullet lines whose key/value pairs are joined into the single `notes` field
 * VenueInfoSchema's hours block accepts.
 *
 * Per-day values are stringified as "<open> – <close>" (en dash); a 4th-column
 * per-row note becomes " (note)" appended to the range.
 */
function parseHoursFromSection2(section2Content: string): HoursObject {
  const h3s = splitByHeading(section2Content, 3)
  const hoursSection = h3s.find((s) => /^hours/i.test(s.title))
  if (!hoursSection) return {}

  const result: HoursObject = {}

  for (const line of hoursSection.content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^\|[\s|:-]+\|$/.test(trimmed)) continue // separator row
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    if (cells.length < 3) continue
    const dayLabel = cells[0].toLowerCase()
    const dayKey = DAY_KEY_MAP[dayLabel]
    if (!dayKey) continue // header row, blank, or unknown — skip
    const open = cells[1]
    const close = cells[2]
    const note = cells[3]
    let value = `${open} – ${close}`
    if (note && note.length > 0) value += ` (${note})`
    result[dayKey] = value
  }

  const noteLines: string[] = []
  const bulletRe = /^\s*-\s*\*\*([^:]+):\*\*\s*(.+?)\s*$/gm
  let bm: RegExpExecArray | null
  while ((bm = bulletRe.exec(hoursSection.content)) !== null) {
    const key = bm[1].trim()
    const value = bm[2].trim()
    noteLines.push(`${key}: ${value}`)
  }
  if (noteLines.length > 0) {
    result.notes = noteLines.join('\n')
  }
  return result
}

export function parseVenueSpec(markdown: string): ParsedVenueSpec {
  const h2s = splitByHeading(markdown, 2)
  if (h2s.length === 0) {
    throw new Error('parse-venue-spec: no H2 sections found in document')
  }

  // ── Section 1: Venue identification ──────────────────────────────────────
  const sectionIdent = h2s.find((s) => /^1\.\s*venue identification/i.test(s.title))
  if (!sectionIdent) throw new Error('parse-venue-spec: missing section "1. Venue identification"')
  const identKv = extractKvBullets(sectionIdent.content)
  const slug = identKv['slug']
  const name = identKv['name']
  const timezone = identKv['timezone'] ?? 'America/Los_Angeles'
  if (!slug) throw new Error('parse-venue-spec: section 1 missing **Slug:**')
  if (!name) throw new Error('parse-venue-spec: section 1 missing **Name:**')

  // ── Section 2: Airtable intake (informational; we mine address/contact) ──
  const sectionAirtable = h2s.find((s) => /^2\.\s*airtable intake/i.test(s.title))
  const airtableKv = sectionAirtable ? extractKvBullets(sectionAirtable.content) : {}

  // ── Section 3: brand_persona ─────────────────────────────────────────────
  const sectionPersona = h2s.find((s) => /^3\.\s*brand_persona/i.test(s.title))
  if (!sectionPersona) throw new Error('parse-venue-spec: missing section "3. brand_persona"')
  const personaBlocks = extractJsonBlocks(sectionPersona.content)
  if (personaBlocks.length === 0) {
    throw new Error('parse-venue-spec: section 3 has no ```json block')
  }
  const personaParsed = BrandPersonaSchema.safeParse(personaBlocks[0])
  if (!personaParsed.success) {
    throw new Error(`parse-venue-spec: brand_persona invalid: ${personaParsed.error.message}`)
  }
  const brandPersona = personaParsed.data

  // ── Section 4: venue_info (composite) ────────────────────────────────────
  const sectionInfo = h2s.find((s) => /^4\.\s*venue_info/i.test(s.title))
  if (!sectionInfo) throw new Error('parse-venue-spec: missing section "4. venue_info"')
  const infoH3s = splitByHeading(sectionInfo.content, 3)

  // staff: JSON array of {name, role, notes} → flatten to "name — role" strings
  const staffSection = infoH3s.find((s) => /^staff/i.test(s.title))
  let staff: string[] = []
  if (staffSection) {
    const staffBlocks = extractJsonBlocks(staffSection.content)
    if (staffBlocks.length > 0 && Array.isArray(staffBlocks[0])) {
      staff = (staffBlocks[0] as Array<Record<string, unknown>>)
        .map((s) => {
          const n = String(s.name ?? '').trim()
          const r = String(s.role ?? '').trim()
          if (!n) return ''
          return r ? `${n} — ${r}` : n
        })
        .filter((s) => s.length > 0)
    }
  }

  // amenities: JSON object matching VenueInfoSchema.amenities shape
  const amenitiesSection = infoH3s.find((s) => /^amenities/i.test(s.title))
  let amenitiesRaw: Record<string, unknown> | undefined
  if (amenitiesSection) {
    const blocks = extractJsonBlocks(amenitiesSection.content)
    if (blocks.length > 0 && typeof blocks[0] === 'object' && blocks[0] !== null) {
      amenitiesRaw = blocks[0] as Record<string, unknown>
    }
  }

  // menu.highlights: bullet list
  const menuHighlightsSection = infoH3s.find((s) => /^menu\.highlights/i.test(s.title))
  const menuHighlights = menuHighlightsSection ? extractBullets(menuHighlightsSection.content) : []

  // menu.notes: free prose
  const menuNotesSection = infoH3s.find((s) => /^menu\.notes/i.test(s.title))
  const menuNotes = menuNotesSection ? menuNotesSection.content.trim() : undefined

  // currentContext: JSON array → adapt to VenueContextNoteSchema. The fixture
  // has free-text source labels ('interview_section_9') and an expiresAt
  // field that aren't in the current schema. Coerce source → 'text' and drop
  // expiresAt for tonight; richer schema is a future extension.
  const currentContextSection = infoH3s.find((s) => /^currentcontext/i.test(s.title))
  let currentContextRaw: Array<Record<string, unknown>> = []
  if (currentContextSection) {
    const blocks = extractJsonBlocks(currentContextSection.content)
    if (blocks.length > 0 && Array.isArray(blocks[0])) {
      currentContextRaw = blocks[0] as Array<Record<string, unknown>>
    }
  }
  const currentContext = currentContextRaw
    .map((entry) => ({
      id: String(entry.id ?? ''),
      content: String(entry.content ?? ''),
      source: 'text' as const,
      addedAt: entry.addedAt ?? new Date().toISOString(),
    }))
    .filter((e) => e.id.length > 0 && e.content.length > 0)

  // Address + contact from section 2 (Airtable intake)
  const addressLine1 = airtableKv['address line 1'] ?? ''
  const addressLine2Raw = airtableKv['address line 2'] ?? ''
  const addressLine2 = isPlaceholder(addressLine2Raw) || !addressLine2Raw ? undefined : addressLine2Raw
  const city = airtableKv['city'] ?? ''
  const region = airtableKv['state'] ?? airtableKv['region'] ?? ''
  const postalCode = airtableKv['postal code'] ?? ''

  const publicPhoneRaw = airtableKv['public phone'] ?? ''
  const publicPhone = isPlaceholder(publicPhoneRaw) || !publicPhoneRaw ? undefined : stripParenAnnotation(publicPhoneRaw)
  const publicEmailRaw = airtableKv['public email'] ?? ''
  const publicEmail = isPlaceholder(publicEmailRaw) || !publicEmailRaw ? undefined : stripParenAnnotation(publicEmailRaw)
  const websiteRaw = airtableKv['website'] ?? ''
  const website = isPlaceholder(websiteRaw) || !websiteRaw ? undefined : stripParenAnnotation(websiteRaw)

  // Hours table from section 2 → VenueInfoSchema.hours shape.
  const hours = parseHoursFromSection2(sectionAirtable?.content ?? '')

  const venueInfoCandidate = {
    address: { line1: addressLine1, line2: addressLine2, city, region, postalCode },
    contact: { publicPhone, publicEmail, website },
    hours,
    menu: { highlights: menuHighlights, notes: menuNotes },
    staff,
    amenities: amenitiesRaw,
    currentContext,
  }
  const venueInfoParsed = VenueInfoSchema.safeParse(venueInfoCandidate)
  if (!venueInfoParsed.success) {
    throw new Error(`parse-venue-spec: venue_info invalid: ${venueInfoParsed.error.message}`)
  }
  const venueInfo = venueInfoParsed.data

  // ── Section 5: mechanics ─────────────────────────────────────────────────
  const sectionMechanics = h2s.find((s) => /^5\.\s*mechanics/i.test(s.title))
  if (!sectionMechanics) throw new Error('parse-venue-spec: missing section "5. mechanics"')
  const mechanicsRaw = extractJsonBlocks(sectionMechanics.content)
  const mechanics: MechanicSpec[] = []
  for (const raw of mechanicsRaw) {
    if (typeof raw !== 'object' || raw === null) continue
    // Zod's z.object strips unknown keys (incl. `min_state` per locked decision).
    const parsed = MechanicSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `parse-venue-spec: mechanic invalid: ${parsed.error.message}\nRaw: ${JSON.stringify(raw)}`,
      )
    }
    mechanics.push(parsed.data as MechanicSpec)
  }
  if (mechanics.length === 0) {
    throw new Error('parse-venue-spec: section 5 has no parseable mechanics')
  }

  // ── Section 6: voice_corpus ──────────────────────────────────────────────
  const sectionCorpus = h2s.find((s) => /^6\.\s*voice_corpus/i.test(s.title))
  if (!sectionCorpus) throw new Error('parse-venue-spec: missing section "6. voice_corpus"')
  const corpusRaw = extractJsonBlocks(sectionCorpus.content)
  const voiceCorpus: VoiceCorpusSpec[] = []
  for (const raw of corpusRaw) {
    const parsed = VoiceCorpusSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `parse-venue-spec: voice_corpus entry invalid: ${parsed.error.message}\nRaw: ${JSON.stringify(raw)}`,
      )
    }
    voiceCorpus.push(parsed.data)
  }
  if (voiceCorpus.length < 5) {
    throw new Error(
      `parse-venue-spec: need at least 5 voice_corpus entries (orchestrator requires ≥3 strong matches at retrieval); got ${voiceCorpus.length}`,
    )
  }

  return { slug, name, timezone, brandPersona, venueInfo, mechanics, voiceCorpus }
}