import type { EligibleMechanic } from '@/lib/recognition'
import {
  type ActiveCommitment,
  type BrandPersona,
  isEmptyGuestContext,
  type MenuItem,
  type ParsedGuestContext,
  type VenueInfo,
} from '@/lib/schemas'
import type {
  FollowupContext,
  FollowupReason,
  KnowledgeCorpusChunk,
  MessageCategory,
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
      `## Anti-patterns (what NOT to sound like)\n${persona.voiceAntiPatterns.map((a) => `- ${a.text}`).join('\n')}`,
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
  const header =
    "## Venue knowledge\nFacts about the venue you can ground replies in. This is content, not voice — speak in the venue's voice regardless of how these are phrased."

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

function formatRightNow(today: NonNullable<RuntimeContext['today']>): string {
  return [
    '## Right now',
    `- Date: ${today.dayOfWeek}, ${today.isoDate}`,
    `- Time at venue: ${today.venueLocalTime} (${today.venueTimezone})`,
  ].join('\n')
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
function formatActiveCommitments(
  commitments: readonly ActiveCommitment[],
  now: Date,
): string | null {
  if (commitments.length === 0) return null

  const lines = commitments.map((c) => {
    const segments: string[] = [`id: ${c.id}`]
    if (c.code) segments.push(`code: ${c.code}`)
    segments.push(`status: ${c.status}`)
    const delta = formatTimeDelta(new Date(c.created_at), now)
    return `- [${c.type}] ${c.description} (${segments.join(', ')}) — promised ${delta}`
  })

  const intro =
    'Open promises this venue has made to this guest. ' +
    "If you're offering something new (comp / hold), include the arrival ask in the same breath ('give me a heads up when you're heading over'). " +
    "If a commitment is still open without an arrival signal, you MAY weave the ask in naturally — but never force it, never pester. Don't repeat the ask if status is already 'pending_ack' (the guest has already signaled). " +
    'Each line carries an internal `id:` — copy that value verbatim into arrivalCapture.referencesCommitmentId when the guest signals arrival. The id is system-internal: never read it aloud, never include it in your reply to the guest.'

  return ['## Active commitments', intro, lines.join('\n')].join('\n')
}

// THE-170: render a deterministic eligibility block. Empty array is meaningful
// — the framing instructs Sonnet not to offer perks at all. Non-empty renders
// the allowlist with name + reward + qualification context.
function formatMechanicEligibility(mechanics: readonly EligibleMechanic[]): string {
  const header = '## What this guest can access'
  if (mechanics.length === 0) {
    return `${header}\nNothing right now beyond the standard menu and answering questions. The guest hasn't yet earned access to perks. Do not offer perks of any kind.`
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
  return `${header}\n${intro}\n${bullets.join('\n')}`
}

export function runtimeToProse(
  runtime: RuntimeContext,
  category: MessageCategory,
  now: Date = new Date(),
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
    blocks.push(formatMechanicEligibility(runtime.mechanics))
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
    const block = formatActiveCommitments(runtime.activeCommitments, now)
    if (block) blocks.push(block)
  }
  if (runtime.recentMessages && runtime.recentMessages.length > 0) {
    const recent = formatRecentConversation(runtime.recentMessages, now)
    if (recent) blocks.push(recent)
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