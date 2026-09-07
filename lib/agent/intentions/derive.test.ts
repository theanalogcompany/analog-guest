import { describe, expect, it } from 'vitest'
import { REPORTED_ORDER_WINDOW_DAYS } from '@/lib/agent/extract-reported-order'
import {
  INTENTION_DEFINITIONS,
  type IntentionKey,
  LEARN_FIRST_ORDER_WINDOW_DAYS,
} from './definitions'
import { applyCurrentTurnSuppression, deriveOpenIntentions, type OpenIntention } from './derive'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-06T12:00:00Z')

function keysOf(open: readonly OpenIntention[]): IntentionKey[] {
  return open.map((o) => o.key)
}

describe('LEARN_FIRST_ORDER_WINDOW_DAYS vs REPORTED_ORDER_WINDOW_DAYS', () => {
  // TAC-324 plan-review: the two windows express different things (how long
  // Sana still ASKS vs. how long TAC-323's extractor still LISTENS) and are
  // deliberately independent constants, not one imported from the other. The
  // only thing that must hold between them is this inequality — listening
  // longer than we ask is free, asking as long as we listen is the backlog
  // failure this ticket exists to prevent.
  it('never lets the ask-window outlast the listen-window', () => {
    expect(LEARN_FIRST_ORDER_WINDOW_DAYS).toBeLessThanOrEqual(REPORTED_ORDER_WINDOW_DAYS)
  })
})

describe('deriveOpenIntentions', () => {
  const guestCreatedAt = NOW

  it('returns an empty set for a guest not created via qr_scan', () => {
    const open = deriveOpenIntentions({
      createdVia: 'inbound_message',
      guestCreatedAt,
      now: NOW,
      hasQualifyingTransaction: false,
      promptedKeys: new Set(),
    })
    expect(open).toEqual([])
  })

  it('nothing done: both intentions open for a fresh qr_scan guest', () => {
    const open = deriveOpenIntentions({
      createdVia: 'qr_scan',
      guestCreatedAt,
      now: NOW,
      hasQualifyingTransaction: false,
      promptedKeys: new Set(),
    })
    expect(keysOf(open)).toEqual(['learn_first_order', 'invite_contact_save'])
  })

  it('order known: a qualifying transaction closes learn_first_order only', () => {
    const open = deriveOpenIntentions({
      createdVia: 'qr_scan',
      guestCreatedAt,
      now: NOW,
      hasQualifyingTransaction: true,
      promptedKeys: new Set(),
    })
    expect(keysOf(open)).toEqual(['invite_contact_save'])
  })

  it('prompted-not-satisfied: a prompt row closes invite_contact_save even though it can never be independently satisfied', () => {
    const open = deriveOpenIntentions({
      createdVia: 'qr_scan',
      guestCreatedAt,
      now: NOW,
      hasQualifyingTransaction: false,
      promptedKeys: new Set(['invite_contact_save']),
    })
    expect(keysOf(open)).toEqual(['learn_first_order'])
  })

  it('prompted-not-satisfied: a prompt row closes learn_first_order even without a transaction', () => {
    const open = deriveOpenIntentions({
      createdVia: 'qr_scan',
      guestCreatedAt,
      now: NOW,
      hasQualifyingTransaction: false,
      promptedKeys: new Set(['learn_first_order']),
    })
    expect(keysOf(open)).toEqual(['invite_contact_save'])
  })

  it('expired: learn_first_order closes at its window regardless of prompt state', () => {
    const now = new Date(guestCreatedAt.getTime() + (LEARN_FIRST_ORDER_WINDOW_DAYS + 1) * MS_PER_DAY)
    const open = deriveOpenIntentions({
      createdVia: 'qr_scan',
      guestCreatedAt,
      now,
      hasQualifyingTransaction: false,
      promptedKeys: new Set(),
    })
    expect(keysOf(open)).toEqual(['invite_contact_save'])
  })

  it('expired: invite_contact_save closes at its own, longer window', () => {
    const now = new Date(
      guestCreatedAt.getTime() +
        (INTENTION_DEFINITIONS.find((d) => d.key === 'invite_contact_save')!.expiresAfterMs /
          MS_PER_DAY +
          1) *
          MS_PER_DAY,
    )
    const open = deriveOpenIntentions({
      createdVia: 'qr_scan',
      guestCreatedAt,
      now,
      hasQualifyingTransaction: false,
      promptedKeys: new Set(),
    })
    expect(open).toEqual([])
  })

  it('everything closed: empty set', () => {
    const open = deriveOpenIntentions({
      createdVia: 'qr_scan',
      guestCreatedAt,
      now: NOW,
      hasQualifyingTransaction: true,
      promptedKeys: new Set(['invite_contact_save']),
    })
    expect(open).toEqual([])
  })

  // Fail-closed contract (plan-review item 5): a failed guest_intention_prompts
  // read is modeled by the caller passing the FULL key set as "prompted" —
  // this test locks that deriveOpenIntentions treats "everything prompted" as
  // "everything closed," which is what makes the fail-closed behavior work.
  it('treats a fully-populated promptedKeys set (the fail-closed input) as fully closed', () => {
    const open = deriveOpenIntentions({
      createdVia: 'qr_scan',
      guestCreatedAt,
      now: NOW,
      hasQualifyingTransaction: false,
      promptedKeys: new Set(INTENTION_DEFINITIONS.map((d) => d.key)),
    })
    expect(open).toEqual([])
  })

  it('answers days later still counts as open — expiry is the only clock, not recency', () => {
    const now = new Date(guestCreatedAt.getTime() + 2 * MS_PER_DAY)
    const open = deriveOpenIntentions({
      createdVia: 'qr_scan',
      guestCreatedAt,
      now,
      hasQualifyingTransaction: false,
      promptedKeys: new Set(),
    })
    expect(keysOf(open)).toContain('learn_first_order')
  })
})

describe('applyCurrentTurnSuppression', () => {
  const menuItems = [{ name: 'Gibraltar / Cortado' }, { name: 'Almond Croissant' }]
  const bothOpen: OpenIntention[] = [
    { key: 'learn_first_order', promptLine: "You haven't heard what this guest ordered yet." },
    { key: 'invite_contact_save', promptLine: "You haven't told them to save your number." },
  ]

  it('passes the set through unchanged when there is no current inbound (followup path)', () => {
    const result = applyCurrentTurnSuppression(bothOpen, null, menuItems)
    expect(result).toEqual(bothOpen)
  })

  it('passes the set through unchanged when the inbound mentions no menu item', () => {
    const result = applyCurrentTurnSuppression(bothOpen, 'is there parking nearby?', menuItems)
    expect(result).toEqual(bothOpen)
  })

  it('drops learn_first_order when the inbound names a menu item, leaving invite_contact_save', () => {
    const result = applyCurrentTurnSuppression(bothOpen, 'i got an oat cortado', menuItems)
    expect(result.map((o) => o.key)).toEqual(['invite_contact_save'])
  })

  it('is a no-op when learn_first_order was already closed (not in the input set)', () => {
    const onlyInvite: OpenIntention[] = [
      { key: 'invite_contact_save', promptLine: "You haven't told them to save your number." },
    ]
    const result = applyCurrentTurnSuppression(onlyInvite, 'i got an oat cortado', menuItems)
    expect(result).toEqual(onlyInvite)
  })

  it('does not mutate the input array', () => {
    const copy = [...bothOpen]
    applyCurrentTurnSuppression(bothOpen, 'i got an oat cortado', menuItems)
    expect(bothOpen).toEqual(copy)
  })
})

// TAC-326: regression corpus at the level where the production symptom
// actually appeared — the real, unmocked bodyMentionsMenuItem (this file
// imports applyCurrentTurnSuppression, which imports bodyMentionsMenuItem
// directly from lib/agent/extract-reported-order.ts; nothing here stubs it
// out), not just the isolated unit. This is the corpus that would have
// caught the production bug, not merely the fix.
describe('applyCurrentTurnSuppression — real-word-collision regression corpus (TAC-326)', () => {
  const bothOpen: OpenIntention[] = [
    { key: 'learn_first_order', promptLine: "You haven't heard what this guest ordered yet." },
    { key: 'invite_contact_save', promptLine: "You haven't told them to save your number." },
  ]

  it('"Hi Sana!" against a menu containing San Pellegrino does not suppress learn_first_order (the production symptom)', () => {
    const menu = [{ name: 'San Pellegrino' }]
    const result = applyCurrentTurnSuppression(bothOpen, 'Hi Sana!', menu)
    expect(result.map((o) => o.key)).toContain('learn_first_order')
  })

  it('"nice, thanks" against a menu containing Hibiscus Ice Tea does not suppress learn_first_order (the realistic recurring trigger)', () => {
    const menu = [{ name: 'Hibiscus Ice Tea' }]
    const result = applyCurrentTurnSuppression(bothOpen, 'nice, thanks', menu)
    expect(result.map((o) => o.key)).toContain('learn_first_order')
  })

  // Known gap, NOT a pass: "san" is a genuinely, correctly-boundaried
  // standalone word in "San Francisco" — there's no boundary violation for
  // bodyContainsWord to catch, unlike the Sana/nice cases above. Closing
  // this needs a distinctiveness/granularity model for multi-word menu
  // names (does "san" alone mean "San Pellegrino"?), not a matching-
  // precision fix, and is deliberately deferred per TAC-326's plan. Accepted
  // because suppression is turn-scoped: this costs one turn's rendering, not
  // the intention itself — learn_first_order derives open again on the next
  // turn that doesn't also collide.
  //
  // If you're tempted to make this test pass, the tempting fixes are NOT a
  // loosened boundary check (bodyContainsWord is already correct here — the
  // match IS correctly boundaried) but one of: requiring the full menu-name
  // phrase, requiring >=2 significant words for multi-word names, or raising
  // the standalone-match length floor above 3. Each of those was checked
  // against the existing suite during TAC-326's plan review and each breaks
  // an existing, deliberately-shipped single-word match: "ginger" alone must
  // still match "Wild Wonder Peach Ginger" (bodyMentionsMenuItem's own test
  // suite), "cortado" alone must still match the slash-alternate-names
  // "Gibraltar / Cortado", and "v60" is exactly 3 characters so any raised
  // floor that excludes "san" excludes it too. Don't add one of these three
  // without re-opening TAC-326's granularity discussion first. This test
  // asserts CURRENT behavior so a future change to the matcher that
  // accidentally starts passing this gets noticed and re-evaluated
  // deliberately, not silently.
  it('a "San Francisco" mention against a menu containing San Pellegrino still suppresses learn_first_order today (known, deferred gap)', () => {
    const menu = [{ name: 'San Pellegrino' }]
    const result = applyCurrentTurnSuppression(bothOpen, 'anyone been to San Francisco', menu)
    expect(result.map((o) => o.key)).not.toContain('learn_first_order')
  })
})
