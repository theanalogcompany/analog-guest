import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { APPROVAL_TRIGGERS, GENERATION_FAILED_REVIEW_REASON } from '@/lib/agent/stages'

// send.ts now imports APPROVAL_TRIGGERS from @/lib/agent/stages (so the label
// map is keyed on the source of truth rather than re-listed literals), which
// transitively loads the Voyage SDK — its ESM build trips vitest's
// directory-import resolver at module load. Same dodge as
// lib/tunables/manifest.test.ts; nothing here instantiates a Voyage client.
vi.mock('voyageai', () => ({
  VoyageAIClient: class {},
}))

import type {
  PushSentProps,
  PushTokenInvalidProps,
} from '@/lib/analytics/posthog'

import type { MessageCategory } from '@/lib/ai/types'

import type { ApnsClientResult, ApnsRequestPayload } from './apns/client'

const sendApnsRequestMock = vi.fn<
  (payload: ApnsRequestPayload) => Promise<ApnsClientResult>
>()
vi.mock('./apns/client', () => ({
  sendApnsRequest: (payload: ApnsRequestPayload) => sendApnsRequestMock(payload),
}))

const capturePushSentMock = vi.fn<(props: PushSentProps) => Promise<void>>()
const capturePushTokenInvalidMock = vi.fn<
  (props: PushTokenInvalidProps) => Promise<void>
>()
vi.mock('@/lib/analytics/posthog', () => ({
  capturePushSent: (props: PushSentProps) => capturePushSentMock(props),
  capturePushTokenInvalid: (props: PushTokenInvalidProps) =>
    capturePushTokenInvalidMock(props),
}))

// Supabase admin mock. Each `.from(table)` returns a per-table thenable
// builder so the helper can call .select / .eq / .in / .not / .update freely.
type Q = {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  in: ReturnType<typeof vi.fn>
  not: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  then: (resolve: (value: unknown) => unknown) => unknown
}

function makeQuery(result: unknown): Q {
  const q = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    not: vi.fn(),
    update: vi.fn(),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(result).then(resolve),
  }
  q.select.mockReturnValue(q)
  q.eq.mockReturnValue(q)
  q.in.mockReturnValue(q)
  q.not.mockReturnValue(q)
  q.update.mockReturnValue(q)
  return q
}

const queriesByTable: Record<string, Q[]> = {}
const fromMock = vi.fn((table: string) => {
  const queue = queriesByTable[table]
  if (!queue || queue.length === 0) {
    throw new Error(`No mocked query queued for table ${table}`)
  }
  return queue.shift()!
})

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({ from: fromMock }),
}))

// Import AFTER mocks are set.
import {
  REASON_BY_REVIEW_REASON,
  buildPushBody,
  buildPushTitle,
  sendDraftFlaggedPush,
  shouldQuoteGuest,
  shouldSendDraftFlaggedPush,
} from './send'

beforeEach(() => {
  sendApnsRequestMock.mockReset()
  capturePushSentMock.mockReset()
  capturePushSentMock.mockResolvedValue(undefined)
  capturePushTokenInvalidMock.mockReset()
  capturePushTokenInvalidMock.mockResolvedValue(undefined)
  fromMock.mockClear()
  for (const k of Object.keys(queriesByTable)) delete queriesByTable[k]
})

afterEach(() => {
  vi.clearAllMocks()
})

function queue(table: string, result: unknown): void {
  if (!queriesByTable[table]) queriesByTable[table] = []
  queriesByTable[table].push(makeQuery(result))
}

const baseInput = {
  agentRunId: 'run-1',
  venueId: 'venue-1',
  guestId: 'guest-1',
  guestFirstName: 'Alex',
  draftId: 'draft-1',
  primaryTrigger: 'model_flagged',
  // TAC-532. Required on the input, so every fixture states them too.
  guestQuestion: 'do you have oat milk?' as string | null,
  guestCategory: 'new_question' as MessageCategory | null,
}

describe('shouldSendDraftFlaggedPush', () => {
  it('returns true for model_flagged, comp_regex_backstop, fidelity_below_auto_send_floor', () => {
    expect(shouldSendDraftFlaggedPush('model_flagged')).toBe(true)
    expect(shouldSendDraftFlaggedPush('comp_regex_backstop')).toBe(true)
    expect(shouldSendDraftFlaggedPush('fidelity_below_auto_send_floor')).toBe(true)
  })

  it('returns false for previous_pending_held (regen of already-pushed draft)', () => {
    expect(shouldSendDraftFlaggedPush('previous_pending_held')).toBe(false)
  })

  // INVERTED. This assertion previously read:
  //
  //   it('returns false for unknown triggers (future-add safety)', ...)
  //     expect(shouldSendDraftFlaggedPush('something_new')).toBe(false)
  //
  // It was labelled "future-add safety" but encoded the exact opposite: an
  // allow-list that DROPS anything it doesn't recognize. When ff653be added
  // commitment_type_gated and 0c1515c added hold_all_outbound, both were
  // "unknown triggers" and both were silently discarded — with this test
  // green, asserting the behavior as intended. The suite did not merely miss
  // the regression; it locked it in.
  //
  // Fail-open is the correct default: a push the operator can dismiss beats a
  // queued draft they are never told about. Exhaustiveness now lives in
  // push-policy.ts's `satisfies Record<ApprovalTrigger, PushDecision>`, which
  // fails tsc rather than deferring to a runtime default.
  it('returns true for unknown triggers (fail-open — see push-policy.ts)', () => {
    expect(shouldSendDraftFlaggedPush('something_new')).toBe(true)
  })

  it('pushes the two triggers that regressed (commitment_type_gated, hold_all_outbound)', () => {
    expect(shouldSendDraftFlaggedPush('commitment_type_gated')).toBe(true)
    expect(shouldSendDraftFlaggedPush('hold_all_outbound')).toBe(true)
  })
})

describe('buildPushTitle / buildPushBody (TAC-532)', () => {
  it('puts guest and reason in the title and the guest question in the body', () => {
    expect(buildPushTitle('Alex', 'knowledge_gap', 'new_question')).toBe(
      'Alex: needs an answer',
    )
    expect(buildPushBody('do you have oat milk for the latte?', 'new_question')).toBe(
      '"do you have oat milk for the latte?"',
    )
  })

  // THE REGRESSION THIS TICKET IS. Three cards were waiting for one guest on
  // 2026-09-23, all three knowledge_gap, and every push read the identical
  // "Reply to Alex — needs an answer". The reason cannot tell them apart
  // because the reason is the thing they share.
  it('gives three same-trigger cards for one guest three different bodies', () => {
    const questions = [
      'do you have oat milk?',
      'are you doing anything for november?',
      'do you have a loyalty card?',
    ]
    const bodies = questions.map((q) => buildPushBody(q, 'new_question'))
    expect(new Set(bodies).size).toBe(3)
    for (const [i, body] of bodies.entries()) {
      expect(body).toContain(questions[i] as string)
    }
    // The titles are IDENTICAL and that is correct: the title carries the
    // reason, which genuinely is the same for all three. The body is what
    // distinguishes them, which is the whole point of the split.
    const titles = questions.map(() => buildPushTitle('Alex', 'knowledge_gap', 'new_question'))
    expect(new Set(titles).size).toBe(1)
  })

  describe('comp_complaint never reaches a lock screen (ruled 2026-09-23)', () => {
    it('takes the complaint title and drops the quote', () => {
      expect(buildPushTitle('Alex', 'knowledge_gap', 'comp_complaint')).toBe(
        'Alex: something went wrong',
      )
      expect(buildPushBody('my cortado was cold and the guy was rude', 'comp_complaint')).toBe(
        'Complaint waiting for review',
      )
    })

    // The load-bearing case. comp_complaint routes to a comp-forward draft, so
    // the commonest complaint card's primaryTrigger is commitment_type_gated,
    // which ranks 1st in PRIMARY_TRIGGER_PRIORITY while the complaint trigger
    // ranks 22nd of 23. A suppression keyed on the TRIGGER would leak the quote
    // here, which is exactly backwards.
    it('suppresses on the category even when the trigger is not a complaint trigger', () => {
      const body = buildPushBody('my cortado was cold', 'comp_complaint')
      expect(body).not.toContain('cortado')
      expect(buildPushTitle('Alex', 'commitment_type_gated', 'comp_complaint')).toBe(
        'Alex: something went wrong',
      )
    })

    it('still quotes the guest when the same trigger fires on a non-complaint', () => {
      expect(buildPushBody('my cortado was cold', 'new_question')).toBe(
        '"my cortado was cold"',
      )
    })
  })

  // A null category means classification did not complete. We cannot then
  // establish the message was not a complaint, so the safe direction is to
  // suppress. The crash-card call site reaches exactly this state.
  it('suppresses the quote when the category is unresolved', () => {
    expect(shouldQuoteGuest(null)).toBe(false)
    expect(buildPushBody('my cortado was cold', null)).toBe('Draft ready to review')
    expect(buildPushBody('my cortado was cold', null)).not.toContain('cortado')
  })

  it('falls back when there is no guest message (followups)', () => {
    expect(buildPushBody(null, 'follow_up')).toBe('Draft ready to review')
    expect(buildPushBody('   ', 'follow_up')).toBe('Draft ready to review')
  })

  it('collapses whitespace so a multi-line inbound renders as one run', () => {
    expect(buildPushBody('do you have\n\noat   milk?', 'new_question')).toBe(
      '"do you have oat milk?"',
    )
  })

  it('falls back to "A guest" when the first name is missing', () => {
    expect(buildPushTitle(null, 'knowledge_gap', 'new_question')).toBe(
      'A guest: needs an answer',
    )
    expect(buildPushTitle('   ', 'knowledge_gap', 'new_question')).toBe(
      'A guest: needs an answer',
    )
  })

  describe('truncation keeps the distinguishing part', () => {
    it('trims a long question at a word boundary, inside budget', () => {
      const long =
        'hi there I was wondering whether you happen to have any oat milk left today or whether you have run out again like last week'
      const body = buildPushBody(long, 'new_question')
      expect(body.length).toBeLessThanOrEqual(110)
      expect(body.startsWith('"hi there I was wondering')).toBe(true)
      expect(body.endsWith('…"')).toBe(true)
      // The real word-boundary property: the kept text is a prefix of the
      // original that stops exactly where a space follows. (An earlier version
      // asserted /\w…"$/ did NOT match, which no correct implementation can
      // satisfy: cutting at a space and trimming always leaves a word
      // character before the ellipsis.)
      const inner = body.slice(1, -2)
      expect(long.startsWith(inner)).toBe(true)
      expect(long[inner.length]).toBe(' ')
    })

    it('still trims a single pathological word rather than emptying the body', () => {
      const body = buildPushBody('a'.repeat(300), 'new_question')
      expect(body.length).toBeLessThanOrEqual(110)
      expect(body.length).toBeGreaterThan(50)
    })

    it('trims the NAME and keeps the reason whole when the title is over budget', () => {
      const title = buildPushTitle('Christopherbartholomew-Fitzwilliam', 'knowledge_gap', 'new_question')
      expect(title.length).toBeLessThanOrEqual(40)
      expect(title.endsWith(': needs an answer')).toBe(true)
    })
  })

  describe('the approved copy set', () => {
    // Runs EVERY key rather than naming a few, so a phrase added later cannot
    // skip these rules. Same shape as queue.test.ts's label-map sweep.
    const reasons = Object.entries(REASON_BY_REVIEW_REASON)

    it('covers every approval trigger plus the two extra review reasons', () => {
      for (const trigger of Object.values(APPROVAL_TRIGGERS)) {
        expect(Object.keys(REASON_BY_REVIEW_REASON)).toContain(trigger)
      }
      expect(Object.keys(REASON_BY_REVIEW_REASON)).toContain(GENERATION_FAILED_REVIEW_REASON)
      expect(Object.keys(REASON_BY_REVIEW_REASON)).toContain('instagram_send_failed')
    })

    it('carries no em dash or en dash in any phrase, title or fallback body', () => {
      for (const [key, phrase] of reasons) {
        expect(phrase, key).not.toMatch(/[–—]/)
        expect(buildPushTitle('Alex', key, 'new_question'), key).not.toMatch(/[–—]/)
      }
      expect(buildPushTitle('Alex', 'knowledge_gap', 'comp_complaint')).not.toMatch(/[–—]/)
      for (const body of [
        buildPushBody(null, 'follow_up'),
        buildPushBody('x', 'comp_complaint'),
      ]) {
        expect(body).not.toMatch(/[–—]/)
      }
    })

    it('fits the title budget for every phrase, with a long name', () => {
      for (const [key] of reasons) {
        const title = buildPushTitle('Christopherbartholomew', key, 'new_question')
        expect(title.length, `${key}: ${title}`).toBeLessThanOrEqual(40)
      }
    })

    it('never renders an empty reason', () => {
      for (const [key, phrase] of reasons) {
        expect(phrase.trim().length, key).toBeGreaterThan(0)
      }
    })
  })

  // send.ts carries 'instagram_send_failed' as a literal rather than importing
  // the constant, because importing it would pull Instagram's outbound modules
  // into the SHARED draft push (TAC-469 rule 1). Source-level binding is what
  // stops the two drifting, the same technique review-state.test.ts uses
  // against migration 056.
  it('binds its instagram_send_failed literal to the constant that defines it', () => {
    const owner = readFileSync(
      join(__dirname, '..', 'agent', 'dispatch-instagram-reply.ts'),
      'utf8',
    )
    expect(owner).toContain("INSTAGRAM_SEND_FAILED_REVIEW_REASON = 'instagram_send_failed'")
    const mine = readFileSync(join(__dirname, 'send.ts'), 'utf8')
    expect(mine).toContain("const INSTAGRAM_SEND_FAILED_REASON = 'instagram_send_failed'")
  })
})

function firstCallProps<T>(mock: { mock: { calls: T[][] } }): T {
  const calls = mock.mock.calls
  if (calls.length === 0) throw new Error('mock was not called')
  const args = calls[0]
  if (args === undefined || args.length === 0) {
    throw new Error('first call had no args')
  }
  return args[0] as T
}

describe('sendDraftFlaggedPush', () => {
  it('skips entirely when primaryTrigger is filtered out', async () => {
    await sendDraftFlaggedPush({ ...baseInput, primaryTrigger: 'previous_pending_held' })
    expect(fromMock).not.toHaveBeenCalled()
    expect(sendApnsRequestMock).not.toHaveBeenCalled()
    expect(capturePushSentMock).not.toHaveBeenCalled()
  })

  it('no-ops silently when no operators have a registered token for the venue', async () => {
    queue('operator_venues', { data: [], error: null })
    await sendDraftFlaggedPush(baseInput)
    expect(sendApnsRequestMock).not.toHaveBeenCalled()
    expect(capturePushSentMock).not.toHaveBeenCalled()
  })

  // The 200 path previously logged only the badge, so a UAT run could not
  // tell "APNs accepted it" from "we never reached APNs" without waiting on
  // PostHog. Status/reason/apnsId must be on EVERY response line.
  it('logs status, reason and apnsId on a 200 — not just on failures', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-1' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 3, error: null })
    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 200, reason: null, apnsId: 'A1B2C3D4-0000-1111-2222-333344445555' },
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await sendDraftFlaggedPush(baseInput)
      const responseLine = logSpy.mock.calls.find((c) => c[0] === '[apns] apns response')
      expect(responseLine, 'expected an [apns] apns response log on the 200 path').toBeDefined()
      expect(responseLine?.[1]).toMatchObject({
        status: 200,
        reason: null,
        apnsId: 'A1B2C3D4-0000-1111-2222-333344445555',
        operatorId: 'op-1',
      })
    } finally {
      logSpy.mockRestore()
    }
  })

  it('sends a push with the contracted payload shape on 200', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-1' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 3, error: null })

    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 200, reason: null, apnsId: null },
    })

    await sendDraftFlaggedPush(baseInput)

    expect(sendApnsRequestMock).toHaveBeenCalledTimes(1)
    const arg = sendApnsRequestMock.mock.calls[0]?.[0]
    expect(arg).toBeDefined()
    if (!arg) return
    expect(arg.deviceToken).toBe('tok-1')
    // TAC-532 changed both strings deliberately: the title carries guest and
    // reason, the body carries the guest's own question. The custom data
    // fields are untouched, which is what the operator app actually parses.
    expect(arg.body).toEqual({
      aps: {
        alert: { title: 'Alex: needs review', body: '"do you have oat milk?"' },
        badge: 3,
        sound: 'default',
      },
      draftId: 'draft-1',
      guestId: 'guest-1',
      operatorId: 'op-1',
    })

    expect(capturePushSentMock).toHaveBeenCalledTimes(1)
    const props = firstCallProps(capturePushSentMock)
    expect(props).toMatchObject({
      ok: true,
      status: 200,
      operatorId: 'op-1',
      badge: 3,
      error: null,
      errorDetail: null,
    })
  })

  // TAC-532 rebuilt this test (SR-3). It used to assert that the serialized
  // payload carried no "inboundBody"/"draftBody" KEYS. It never planted guest
  // text and checked for its absence, so guest text interpolated into
  // aps.alert.body as a plain string passed it — which is precisely the change
  // this ticket makes, and precisely what the test was named to guard. A test
  // that cannot fail on the thing it is named for is decoration.
  describe('payload privacy (TAC-532)', () => {
    const PLANTED = 'zzq-planted-guest-text-zzq'

    function arrangeOneOperator(): void {
      queue('operator_venues', {
        data: [{ operator: { id: 'op-1', apns_device_token: 'tok-1' } }],
        error: null,
      })
      queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
      queue('messages', { count: 1, error: null })
      sendApnsRequestMock.mockResolvedValueOnce({
        ok: true,
        response: { status: 200, reason: null, apnsId: null },
      })
    }

    function sentPayload(): { aps: { alert: { title: string; body: string } } } {
      const arg = sendApnsRequestMock.mock.calls[0]?.[0]
      if (arg === undefined) throw new Error('no push was sent')
      return arg.body as { aps: { alert: { title: string; body: string } } }
    }

    it('carries the planted guest question in the body on an ordinary card', async () => {
      arrangeOneOperator()
      await sendDraftFlaggedPush({
        ...baseInput,
        guestQuestion: PLANTED,
        guestCategory: 'new_question',
      })
      const payload = sentPayload()
      expect(payload.aps.alert.body).toContain(PLANTED)
      // The title stays categorical whatever the body does.
      expect(payload.aps.alert.title).not.toContain(PLANTED)
      expect(payload.aps.alert.title).toBe('Alex: needs review')
    })

    it('keeps the planted guest text out of the ENTIRE payload on a complaint', async () => {
      arrangeOneOperator()
      await sendDraftFlaggedPush({
        ...baseInput,
        guestQuestion: PLANTED,
        guestCategory: 'comp_complaint',
      })
      // The whole serialized payload, not just the fields we remembered to look
      // at. This is the assertion the old test should have made.
      expect(JSON.stringify(sentPayload())).not.toContain(PLANTED)
    })

    it('keeps the planted guest text out of the payload when the category is unresolved', async () => {
      arrangeOneOperator()
      await sendDraftFlaggedPush({
        ...baseInput,
        guestQuestion: PLANTED,
        guestCategory: null,
      })
      expect(JSON.stringify(sentPayload())).not.toContain(PLANTED)
    })

    it('never carries a draft body or a message-content field, and stays in budget', async () => {
      arrangeOneOperator()
      await sendDraftFlaggedPush(baseInput)
      const payload = sentPayload()
      const serialized = JSON.stringify(payload)
      for (const key of ['inboundBody', 'generatedBody', 'message', 'draftBody']) {
        expect(serialized.toLowerCase()).not.toContain(`"${key.toLowerCase()}":`)
      }
      expect(payload.aps.alert.title.length).toBeLessThanOrEqual(40)
      expect(payload.aps.alert.body.length).toBeLessThanOrEqual(110)
    })
  })

  it('on 410 Gone nulls the operator token and fires push.token_invalid + push.sent ok=false', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-expired' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 2, error: null })
    queue('operators', { data: null, error: null }) // the nulling UPDATE

    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 410, reason: 'Unregistered', apnsId: null },
    })

    await sendDraftFlaggedPush(baseInput)

    expect(fromMock).toHaveBeenCalledWith('operators')

    expect(capturePushTokenInvalidMock).toHaveBeenCalledTimes(1)
    const invalidProps = firstCallProps(capturePushTokenInvalidMock)
    expect(invalidProps).toMatchObject({
      operatorId: 'op-1',
      status: 410,
      reason: 'Unregistered',
    })

    expect(capturePushSentMock).toHaveBeenCalledTimes(1)
    const sentProps = firstCallProps(capturePushSentMock)
    expect(sentProps).toMatchObject({ ok: false, status: 410 })
  })

  it("on 400 BadDeviceToken also nulls the token (Apple's second way of saying \"token dead\")", async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-bad' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 0, error: null })
    queue('operators', { data: null, error: null })

    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 400, reason: 'BadDeviceToken', apnsId: null },
    })

    await sendDraftFlaggedPush(baseInput)

    expect(capturePushTokenInvalidMock).toHaveBeenCalledTimes(1)
    const props = firstCallProps(capturePushTokenInvalidMock)
    expect(props.status).toBe(400)
    expect(props.reason).toBe('BadDeviceToken')
  })

  it('does NOT null the token on 400 with a different reason (e.g. PayloadEmpty)', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-1' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 1, error: null })

    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 400, reason: 'PayloadEmpty', apnsId: null },
    })

    await sendDraftFlaggedPush(baseInput)

    expect(capturePushTokenInvalidMock).not.toHaveBeenCalled()
    expect(capturePushSentMock).toHaveBeenCalledTimes(1)
    expect(firstCallProps(capturePushSentMock)).toMatchObject({ ok: false, status: 400 })
  })

  it('on transport failure fires push.sent ok=false with status=null', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-1' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 1, error: null })

    sendApnsRequestMock.mockResolvedValueOnce({
      ok: false,
      error: 'connection_failed',
      detail: 'ECONNRESET',
    })

    await sendDraftFlaggedPush(baseInput)

    expect(capturePushTokenInvalidMock).not.toHaveBeenCalled()
    expect(capturePushSentMock).toHaveBeenCalledTimes(1)
    const props = firstCallProps(capturePushSentMock)
    expect(props).toMatchObject({
      ok: false,
      status: null,
      error: 'connection_failed',
      errorDetail: 'ECONNRESET',
    })
  })

  it('fans out across multiple operators registered for the same venue', async () => {
    queue('operator_venues', {
      data: [
        { operator: { id: 'op-1', apns_device_token: 'tok-1' } },
        { operator: { id: 'op-2', apns_device_token: 'tok-2' } },
      ],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 1, error: null })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 1, error: null })

    sendApnsRequestMock
      .mockResolvedValueOnce({ ok: true, response: { status: 200, reason: null, apnsId: null } })
      .mockResolvedValueOnce({ ok: true, response: { status: 200, reason: null, apnsId: null } })

    await sendDraftFlaggedPush(baseInput)

    expect(sendApnsRequestMock).toHaveBeenCalledTimes(2)
    expect(capturePushSentMock).toHaveBeenCalledTimes(2)
    const operatorIds = capturePushSentMock.mock.calls
      .map((c) => c[0]?.operatorId)
      .filter((x): x is string => Boolean(x))
    expect(new Set(operatorIds)).toEqual(new Set(['op-1', 'op-2']))
  })
})

describe('sendDraftFlaggedPush — generation_failed context (TAC-364)', () => {
  // The crash card is BLANK. An operator who opens it on the strength of an
  // unlabelled "Reply to Sam" finds nothing to read and no statement of what
  // happened — so this card needs its context clause more than most, not less.
  // Until TAC-364 it borrowed knowledge_gap's 'needs an answer' by borrowing
  // its review_reason; splitting the reason without adding a label here would
  // have made the push quietly less informative than before.
  it("labels the push rather than degrading to a bare name", () => {
    const title = buildPushTitle('Sam', GENERATION_FAILED_REVIEW_REASON, 'new_question')
    expect(title).toContain("couldn't write it")
    expect(title).not.toBe('Sam')
  })

  // TAC-532: the title is categorical. The BODY may now carry the guest's own
  // question, which is the point of the ticket, so the guarantee moved from
  // "the whole push is categorical" to "the title is, and the body is gated".
  it('keeps the title categorical, with no guest text and no draft body', () => {
    const title = buildPushTitle('Sam', GENERATION_FAILED_REVIEW_REASON, 'new_question')
    expect(title).toBe("Sam: couldn't write it")
  })
})
