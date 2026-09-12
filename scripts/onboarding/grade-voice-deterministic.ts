import { splitIntoSentences } from '@/lib/agent/sentence-split'
import { matchSelfTalk } from '@/lib/ai/self-talk-detector'
import type { VenueInfo } from '@/lib/schemas/venue-info'

/**
 * TAC-347 Stage 3. Deterministic (no model) voice checks — the cheap half
 * of grading, run on every scenario regardless of the LLM grader budget.
 * Pure and import-light: the only non-local import is splitIntoSentences,
 * itself deliberately import-free (see its own module header), so this
 * stays vitest-safe with no SDK init.
 *
 * These checks are heuristic, not exhaustive NLU — false negatives are
 * possible (a violation phrased in a way the pattern doesn't catch), and
 * that's an accepted tradeoff for "built cheap": the LLM grader's voice
 * verdict is the backstop for anything these miss.
 */

// 2026-09-11 grader-accuracy fix: raised from 2 to 3 sentences (2 sentences
// was flagging normal replies), and a short sentence (under MIN_WORDS_TO_COUNT
// words — "hey.", "call 911.") no longer counts toward the limit, so a
// message built from several short beats isn't penalized the same as one
// built from several long ones. Character count is unaffected — it isn't
// gamed by short-sentence padding the way a naive sentence count is.
export const MAX_SENTENCES = 3
export const MAX_CHARS = 280
export const MIN_WORDS_TO_COUNT = 5

// 2026-09-11: safety-critical replies are exempt from the length check
// entirely — repeating an instruction for emphasis ("Call 911 right now.
// Don't wait. ... Call 911.") is correct behavior in a crisis message, not
// a voice violation, and the ordinary length bar isn't the right instrument
// to judge it. Matches ScenarioSheetRow.category for this bucket exactly.
export const SAFETY_CRITICAL_CATEGORY = 'adversarial_safety_critical'

export type DeterministicVoiceCheck =
  | 'dash'
  | 'length'
  | 'emoji_policy'
  | 'signed_name'
  | 'phone_or_link'
  | 'third_person_self'
  // TAC-355: self-correction / reasoning-leakage in the reply body, e.g.
  // "...dandelion root — actually wait, no dashes." Shares its pattern list
  // with lib/ai/self-talk-detector.ts (imported, not duplicated) so the
  // harness and the production regen path can't independently drift on what
  // counts as self-talk.
  | 'self_talk'

export interface DeterministicVoiceFinding {
  check: DeterministicVoiceCheck
  detail: string
}

export interface DeterministicVoiceInput {
  replyBody: string
  /** ScenarioSheetRow.category — used only to exempt safety_critical from the length check. */
  category: string
  emojiPolicy: 'never' | 'sparingly' | 'frequent'
  speakerFraming: 'venue' | 'named_person' | 'owner'
  speakerName?: string
  /** Phone numbers the venue actually publishes (e.g. venueInfo.contact.publicPhone). */
  knownPhones: readonly string[]
  /** Domains the venue actually publishes (website host, email domain, social handles). */
  knownDomains: readonly string[]
}

export interface DeterministicVoiceResult {
  pass: boolean
  findings: DeterministicVoiceFinding[]
}

const DASH_RE = /[—–]/ // em dash, en dash

// Broad-enough emoji detector: most emoji live in these Unicode blocks.
// Not exhaustive (flag sequences, some symbol blocks), but sufficient for a
// "did this message use emoji" check.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu

// Phone: loose US-style pattern (with or without separators/country code).
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g
// URL/domain: scheme-optional, requires a recognizable TLD.
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:\/\S*)?\b/gi

// Sign-off patterns: a trailing "- Name" / "Best, Name" / "Thanks, Name" line.
const SIGNOFF_RE = /(?:^|\n)\s*(?:[-—–]\s*[A-Z][a-z]+|(?:best|thanks|cheers|regards)[,!]?\s+[A-Z][a-z]+)\s*$/i

// Third-person indicators immediately preceding the persona's own name —
// "ask Himanshu", "check with Himanshu" — as opposed to first-person
// self-reference ("I'm Himanshu", "this is Himanshu").
const THIRD_PERSON_INDICATORS = [
  'ask',
  'check with',
  'talk to',
  'tell',
  'contact',
  'reach out to',
  'see',
  'find',
  'let',
]

/** Sentence count for the length check — short (under MIN_WORDS_TO_COUNT-word) sentences don't count. */
function extractCountedSentences(body: string): number {
  return splitIntoSentences(body).filter((s) => s.trim().split(/\s+/).filter(Boolean).length >= MIN_WORDS_TO_COUNT).length
}

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase()
}

export function gradeVoiceDeterministic(input: DeterministicVoiceInput): DeterministicVoiceResult {
  const { replyBody } = input

  // 2026-09-11 owner decision: safety-critical scenarios skip the voice
  // check ENTIRELY, not just the length sub-check — clarity wins in an
  // emergency, and no voice rule (dash, emoji, sign-off, third-person
  // self-reference) should be able to fail a reply that correctly tells a
  // guest to call 911 or 988.
  if (input.category === SAFETY_CRITICAL_CATEGORY) {
    return { pass: true, findings: [] }
  }

  const findings: DeterministicVoiceFinding[] = []

  if (DASH_RE.test(replyBody)) {
    findings.push({ check: 'dash', detail: 'reply contains an em or en dash' })
  }

  const selfTalk = matchSelfTalk(replyBody)
  if (selfTalk.matched) {
    findings.push({
      check: 'self_talk',
      detail: `reply contains self-correction or a reference to the agent's own rules/instructions (pattern: ${selfTalk.pattern})`,
    })
  }

  const sentenceCount = extractCountedSentences(replyBody)
  if (sentenceCount > MAX_SENTENCES || replyBody.length > MAX_CHARS) {
    findings.push({
      check: 'length',
      detail: `${sentenceCount} sentence(s) of ${MIN_WORDS_TO_COUNT}+ words, ${replyBody.length} char(s) (limits: ${MAX_SENTENCES} sentences / ${MAX_CHARS} chars)`,
    })
  }

  const emojiMatches = replyBody.match(EMOJI_RE) ?? []
  const emojiLimit = input.emojiPolicy === 'never' ? 0 : input.emojiPolicy === 'sparingly' ? 1 : Infinity
  if (emojiMatches.length > emojiLimit) {
    findings.push({
      check: 'emoji_policy',
      detail: `${emojiMatches.length} emoji (policy: ${input.emojiPolicy}, limit: ${emojiLimit === Infinity ? 'none' : emojiLimit})`,
    })
  }

  if (SIGNOFF_RE.test(replyBody)) {
    findings.push({ check: 'signed_name', detail: 'reply ends with an email-style signature line' })
  }

  const phoneMatches = replyBody.match(PHONE_RE) ?? []
  const unknownPhones = phoneMatches.filter(
    (p) => !input.knownPhones.some((known) => known.replace(/\D/g, '').endsWith(p.replace(/\D/g, ''))),
  )
  if (unknownPhones.length > 0) {
    findings.push({ check: 'phone_or_link', detail: `phone number(s) not in venue data: ${unknownPhones.join(', ')}` })
  }
  const urlMatches = [...replyBody.matchAll(URL_RE)].map((m) => normalizeDomain(m[0]))
  const unknownDomains = [...new Set(urlMatches)].filter(
    (d) => !input.knownDomains.some((known) => normalizeDomain(known) === d),
  )
  if (unknownDomains.length > 0) {
    findings.push({ check: 'phone_or_link', detail: `link(s)/domain(s) not in venue data: ${unknownDomains.join(', ')}` })
  }

  if (input.speakerFraming === 'named_person' && input.speakerName) {
    const name = input.speakerName
    const thirdPersonRe = new RegExp(
      `(?:${THIRD_PERSON_INDICATORS.map((w) => w.replace(/\s+/g, '\\s+')).join('|')})\\s+(?:with\\s+)?${name}\\b`,
      'i',
    )
    if (thirdPersonRe.test(replyBody)) {
      findings.push({
        check: 'third_person_self',
        detail: `persona ("${name}") referred to in third person, e.g. "check with ${name}"`,
      })
    }
  }

  return { pass: findings.length === 0, findings }
}

/** Known-good phone/domain data pulled from venue_info, for the phone_or_link check. */
export function extractKnownContactData(venueInfo: VenueInfo): { phones: string[]; domains: string[] } {
  const phones: string[] = []
  const domains: string[] = []
  if (venueInfo.contact.publicPhone) phones.push(venueInfo.contact.publicPhone)
  if (venueInfo.contact.website) domains.push(venueInfo.contact.website)
  if (venueInfo.contact.publicEmail) {
    const domain = venueInfo.contact.publicEmail.split('@')[1]
    if (domain) domains.push(domain)
  }
  return { phones, domains }
}
