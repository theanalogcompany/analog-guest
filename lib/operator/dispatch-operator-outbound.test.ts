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
              select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
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
    },
    error: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
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
