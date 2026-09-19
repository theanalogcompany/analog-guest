// TAC-309. Coverage for the empty-body refusal on the operator dispatch path.
//
// WHY THIS FILE EXISTS, AND WHY THE ASSERTION IS ABOUT ORDERING:
//
// Knowledge-gap cards persist with `body = ''` on purpose, so "the operator
// swipes right on a card they haven't written yet" is now an ordinary
// gesture rather than an unreachable state. Two guards stand between that
// and a blank text going to a guest, and there is NO third — the DB
// constraint people assumed was backstopping this does not fire (a blank
// draft makes `messages_has_content` evaluate to NULL, and a CHECK is
// violated only by FALSE).
//
// Of the two, `sendMessage`'s check is the universal one but it fires TOO
// LATE to protect the card: `dispatchOperatorOutbound` flips `review_state`
// to 'approved' BEFORE calling Sendblue, and that flip is what removes the
// card from the operator's queue. Failing after it strands the row —
// approved, nothing sent, no way back. So the test that matters is not "it
// returns an error" but "it returns the error WITHOUT having flipped the
// state."

import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendMessageMock = vi.fn()
const updateSpy = vi.fn()
const rowMaybeSingleMock = vi.fn()
const guestMaybeSingleMock = vi.fn()
// What the optimistic flip's select returns. Default: no row, i.e. another
// caller won, which is all the TAC-309 tests need (they assert on the flip
// being attempted, not on what follows). TAC-469's tests set a claimed row.
const claimResultMock = vi.fn(() => ({ data: null as unknown, error: null }))

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            table === 'guests' ? guestMaybeSingleMock() : rowMaybeSingleMock(),
          eq: () => ({ maybeSingle: () => guestMaybeSingleMock() }),
        }),
      }),
      // The UPDATE is the state flip. Recording the call IS the assertion:
      // on a refusal it must never happen, and on a real body it must.
      update: (payload: Record<string, unknown>) => {
        updateSpy(payload)
        return {
          eq: () => ({
            eq: () => ({
              select: () => {
                const result = claimResultMock()
                return {
                  maybeSingle: async () => ({ data: null, error: null }),
                  then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
                }
              },
            }),
          }),
        }
      },
    }),
  }),
}))
vi.mock('@/lib/messaging/send', () => ({
  sendMessage: (...a: unknown[]) => sendMessageMock(...a),
}))
vi.mock('@/lib/guests/commitments', () => ({ createCommitmentFromPending: vi.fn() }))
// TAC-469: the Instagram arm's database and Meta calls, mocked; their own
// behaviour is dispatch-instagram-outbound.test.ts's. This file pins where the
// arm sits relative to the flip.
const prepareInstagramMock = vi.fn()
const sendInstagramMock = vi.fn()
const settleFailedMock = vi.fn()
const stampInstagramMock = vi.fn()
vi.mock('./dispatch-instagram-outbound', () => ({
  prepareInstagramOperatorSend: (...a: unknown[]) => prepareInstagramMock(...a),
  sendInstagramOperatorText: (...a: unknown[]) => sendInstagramMock(...a),
  settleFailedInstagramOperatorSend: (...a: unknown[]) => settleFailedMock(...a),
  stampInstagramOperatorSend: (...a: unknown[]) => stampInstagramMock(...a),
}))
vi.mock('@/lib/schemas', () => ({
  PendingCommitmentSchema: { safeParse: () => ({ success: false }) },
}))

import { dispatchOperatorOutbound } from './dispatch-operator-outbound'

const MESSAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const VENUE_ID = '00000000-0000-0000-0000-00000000000a'
const GUEST_ID = '11111111-1111-4111-8111-111111111111'

function row(body: string) {
  return {
    data: {
      id: MESSAGE_ID,
      venue_id: VENUE_ID,
      guest_id: GUEST_ID,
      body,
      category: 'new_question',
      voice_fidelity: null,
      direction: 'outbound',
      review_state: 'pending',
      created_at: new Date().toISOString(),
      pending_commitment: null,
      // TAC-469: every row has a channel; this card is a text conversation's.
      channel: 'text',
    },
    error: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  claimResultMock.mockReturnValue({ data: null, error: null })
  guestMaybeSingleMock.mockResolvedValue({
    data: { phone_number: '+15555550123', opted_out_at: null },
    error: null,
  })
  sendMessageMock.mockResolvedValue({
    ok: true,
    data: { providerMessageId: 'p-1', status: 'QUEUED' },
  })
})

describe('dispatchOperatorOutbound — empty-body refusal (TAC-309)', () => {
  it('refuses to approve a blank knowledge-gap card', async () => {
    rowMaybeSingleMock.mockResolvedValue(row(''))
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    expect(r).toMatchObject({ ok: false, errorCode: 'empty_body' })
  })

  // THE ORDERING ASSERTION. If the refusal happened after the flip, the card
  // would already be gone from the queue and unrecoverable.
  it('refuses BEFORE flipping review_state, so the card stays queued', async () => {
    rowMaybeSingleMock.mockResolvedValue(row(''))
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('never reaches the provider', async () => {
    rowMaybeSingleMock.mockResolvedValue(row(''))
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  // Matches the send-layer guard, which is trimmed. A lone space is not an
  // answer and must not reach a guest as one.
  it('refuses a whitespace-only stored body', async () => {
    rowMaybeSingleMock.mockResolvedValue(row('   '))
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    expect(r).toMatchObject({ ok: false, errorCode: 'empty_body' })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  // An operator clearing the field and sending is refused too — by the
  // pre-existing trimmed `invalid_input` check at the top of the function,
  // which fires even earlier (before any DB read). Asserting the actual code
  // rather than the one TAC-309 added: two refusals at different depths is
  // correct, and pinning the wrong one here would make a future reader think
  // the empty_body guard covers a case it never sees.
  it('refuses a whitespace-only edit before touching the database', async () => {
    rowMaybeSingleMock.mockResolvedValue(row('the stored draft'))
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'edit',
      editedBody: '   ',
    })
    expect(r).toMatchObject({ ok: false, errorCode: 'invalid_input' })
    expect(rowMaybeSingleMock).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  // The guard must not over-fire. These assert it lets a real body THROUGH to
  // the state flip — deliberately stopping there rather than mocking the whole
  // Sendblue chain, because reaching the flip is exactly the boundary this
  // guard controls and the rest is other tests' business.
  it('lets an edit that fills in a blank card through to the flip', async () => {
    rowMaybeSingleMock.mockResolvedValue(row(''))
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'edit',
      editedBody: 'ceremonial grade, from Ippodo',
    })
    expect(r.ok === false && r.errorCode === 'empty_body').toBe(false)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('lets an ordinary prefilled approval through to the flip', async () => {
    rowMaybeSingleMock.mockResolvedValue(row('yeah, oat and almond'))
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    expect(r.ok === false && r.errorCode === 'empty_body').toBe(false)
    expect(updateSpy).toHaveBeenCalled()
  })
})

// TAC-467. A guest who came in on Instagram has no phone number, and this path
// can only send by text. sendMessage refuses a null recipient too, but after
// the flip, which strands the card the same way the empty-body case above
// would. So, as there, the assertion that matters is the ordering.
describe('dispatchOperatorOutbound — guest with no phone (TAC-467)', () => {
  beforeEach(() => {
    guestMaybeSingleMock.mockResolvedValue({
      data: { phone_number: null, opted_out_at: null },
      error: null,
    })
    rowMaybeSingleMock.mockResolvedValue(row('we open at 7'))
  })

  it('refuses with no_phone_number', async () => {
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    expect(r).toMatchObject({ ok: false, errorCode: 'no_phone_number' })
  })

  it('refuses BEFORE flipping review_state, so the card stays queued', async () => {
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'edit',
      editedBody: 'we open at 7',
    })
    expect(updateSpy).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it('still refuses an opted-out guest as opted_out', async () => {
    guestMaybeSingleMock.mockResolvedValue({
      data: { phone_number: null, opted_out_at: '2026-09-01T00:00:00Z' },
      error: null,
    })
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    expect(r).toMatchObject({ ok: false, errorCode: 'opted_out' })
  })
})

// TAC-469: an Instagram card goes through the Instagram arm, with its checks
// before the flip (so a refused card stays queued) and the card put back when
// Meta definitely refused the send.
describe('dispatchOperatorOutbound: an Instagram card (TAC-469)', () => {
  const TARGET = { accountId: 'acct', recipientId: 'igsid', token: 'tok' }
  const instagramRow = (body = 'Open until 3') => {
    const r = row(body)
    return { ...r, data: { ...r.data, channel: 'instagram' } }
  }
  const approve = () =>
    dispatchOperatorOutbound({ messageId: MESSAGE_ID, operatorId: 'op-1', allowedVenueIds: [VENUE_ID], action: 'approve' })

  beforeEach(() => {
    claimResultMock.mockReturnValue({ data: [{ id: MESSAGE_ID, review_state: 'approved' }], error: null })
    guestMaybeSingleMock.mockResolvedValue({ data: { phone_number: null, opted_out_at: null }, error: null })
    prepareInstagramMock.mockResolvedValue({ ok: true, target: TARGET })
    sendInstagramMock.mockResolvedValue({ ok: true, mid: 'mid-1' })
    stampInstagramMock.mockResolvedValue({ ok: true, folded: false })
    settleFailedMock.mockResolvedValue('Instagram refused this send (window_closed). The card is back in the queue.')
  })

  it('sends over Instagram, never Sendblue, and returns the mid', async () => {
    rowMaybeSingleMock.mockResolvedValue(instagramRow())
    const r = await approve()
    expect(r).toMatchObject({ ok: true, outcome: 'sent', providerMessageId: 'mid-1' })
    expect(sendInstagramMock).toHaveBeenCalledWith(TARGET, 'Open until 3')
    expect(stampInstagramMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: MESSAGE_ID, venueId: VENUE_ID, guestId: GUEST_ID, mid: 'mid-1' }),
    )
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it('does not refuse an Instagram guest for having no phone number', async () => {
    rowMaybeSingleMock.mockResolvedValue(instagramRow())
    expect((await approve()).ok).toBe(true)
  })

  it('refuses a card outside the 24-hour window BEFORE the flip, so it stays queued', async () => {
    rowMaybeSingleMock.mockResolvedValue(instagramRow())
    prepareInstagramMock.mockResolvedValue({ ok: false, errorCode: 'instagram_window_closed', error: 'closed' })
    const r = await approve()
    expect(r).toEqual({ ok: false, errorCode: 'instagram_window_closed', error: 'closed' })
    expect(updateSpy).not.toHaveBeenCalled()
    expect(sendInstagramMock).not.toHaveBeenCalled()
  })

  it('checks the EDITED text against the cap and sends it verbatim', async () => {
    rowMaybeSingleMock.mockResolvedValue(instagramRow('draft'))
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'edit',
      editedBody: '  Open until 4 today  ',
    })
    expect(prepareInstagramMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: 'Open until 4 today' }))
    expect(sendInstagramMock).toHaveBeenCalledWith(TARGET, 'Open until 4 today')
  })

  it('hands a failed send to the Instagram arm to settle (put back or not), with what was flipped', async () => {
    rowMaybeSingleMock.mockResolvedValue(instagramRow())
    sendInstagramMock.mockResolvedValue({ ok: false, kind: 'window_closed', failure: null })
    const r = await approve()
    expect(r).toEqual({
      ok: false,
      errorCode: 'instagram_send_failed',
      error: 'Instagram refused this send (window_closed). The card is back in the queue.',
    })
    expect(settleFailedMock).toHaveBeenCalledWith(expect.anything(), {
      messageId: MESSAGE_ID,
      flippedTo: 'approved',
      kind: 'window_closed',
    })
    expect(stampInstagramMock).not.toHaveBeenCalled()
  })

  it('refuses a card with an unknown channel before the flip: nothing routes on it', async () => {
    const r0 = row('Open until 3')
    rowMaybeSingleMock.mockResolvedValue({ ...r0, data: { ...r0.data, channel: 'carrier-pigeon' } })
    const r = await approve()
    expect(r).toMatchObject({ ok: false, errorCode: 'channel_unresolved' })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a text card never touches the Instagram arm', async () => {
    guestMaybeSingleMock.mockResolvedValue({ data: { phone_number: '+15555550123', opted_out_at: null }, error: null })
    rowMaybeSingleMock.mockResolvedValue(row('Open until 3'))
    await approve()
    expect(prepareInstagramMock).not.toHaveBeenCalled()
    expect(sendInstagramMock).not.toHaveBeenCalled()
    expect(sendMessageMock).toHaveBeenCalled()
  })
})
