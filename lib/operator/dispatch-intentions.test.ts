// TAC-385 PR 1. Recording the ask on the operator-approved and
// operator-edited dispatch paths.
//
// A SEPARATE FILE from dispatch-operator-outbound.test.ts, deliberately. That
// file's mock stops the chain at the optimistic state flip — its UPDATE never
// returns a claimed row, which is exactly right for the TAC-309 ordering
// assertions it exists for. Recording happens at the far END of a successful
// dispatch, so it needs the whole chain to succeed. Widening the shared mock
// would have quietly changed what those seven assertions exercise.
//
// THE LOAD-BEARING ASSERTION IS THE EDIT ONE. `sentBody` must be the
// DISPATCHED text, never the stored draft. On the approve path the two are
// equal and no assertion can separate them, so every edit fixture here uses an
// edited body that differs from `row.body` — a mutant passing `row.body` fails.
// That is the whole mechanism behind "read the ask from what was sent, not
// what was drafted": nothing diffs the bodies, the classifier simply judges the
// words that went out.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendMessageMock = vi.fn()
const recordIntentionPromptsMock = vi.fn()
const rowMaybeSingleMock = vi.fn()
const guestMaybeSingleMock = vi.fn()
const captureRecordingFailedMock = vi.fn()
/**
 * Every `select()` argument, in call order.
 *
 * NON-BEHAVIOURAL, and necessary: the mock returns the full fixture row
 * whatever the query asks for, so dropping `rendered_intentions` from the real
 * SELECT leaves every behavioural assertion in this file green while the
 * feature is inert in production. CLAUDE.md logs this exact mutant surviving in
 * TAC-377 for the same reason; heads-up-queue.test.ts uses this same technique.
 */
const selectArgs: string[] = []

/** Awaitable AND chainable: the update builder is awaited at two depths. */
function step<T>(value: T, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  }
}

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (cols?: string) => {
        if (typeof cols === 'string') selectArgs.push(cols)
        return {
        eq: () => ({
          maybeSingle: () => (table === 'guests' ? guestMaybeSingleMock() : rowMaybeSingleMock()),
          eq: () => ({ maybeSingle: () => guestMaybeSingleMock() }),
        }),
        }
      },
      update: () =>
        step(
          { error: null },
          {
            // stamp:  .update().eq()            -> awaited here
            // claim:  .update().eq().eq().select() -> awaited one level deeper
            eq: () =>
              step(
                { error: null },
                {
                  eq: () =>
                    step(
                      { error: null },
                      {
                        select: () =>
                          step({ data: [{ id: MESSAGE_ID, review_state: 'approved' }], error: null }),
                      },
                    ),
                },
              ),
          },
        ),
    }),
  }),
}))
vi.mock('@/lib/messaging/send', () => ({
  sendMessage: (...a: unknown[]) => sendMessageMock(...a),
}))
vi.mock('@/lib/guests/commitments', () => ({ createCommitmentFromPending: vi.fn() }))
vi.mock('@/lib/analytics/posthog', () => ({
  captureIntentionPromptRecordingFailed: (...a: unknown[]) => captureRecordingFailedMock(...a),
}))

// record.ts pulls classifyIntentionPrompts from @/lib/ai. Mocked so the SDK
// never loads — and so the call's ARGUMENTS are the assertion surface.
vi.mock('@/lib/agent/intentions/record', () => ({
  recordIntentionPrompts: (...a: unknown[]) => recordIntentionPromptsMock(...a),
}))

// waitUntil must actually RUN the work, or every assertion below passes
// vacuously against a promise nobody awaited.
const scheduled: Promise<unknown>[] = []
vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => {
    scheduled.push(p)
  },
}))

import { dispatchOperatorOutbound } from './dispatch-operator-outbound'

const MESSAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const VENUE_ID = '00000000-0000-0000-0000-00000000000a'
const GUEST_ID = '11111111-1111-4111-8111-111111111111'
const ANCHOR = '2026-09-14T10:00:00.000Z'

const DRAFTED = 'Ceremonial grade, from Ippodo. What did you end up getting?'
const EDITED = 'Ceremonial grade, from Ippodo.'

function row(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: MESSAGE_ID,
      venue_id: VENUE_ID,
      guest_id: GUEST_ID,
      body: DRAFTED,
      category: 'new_question',
      voice_fidelity: 0.82,
      direction: 'outbound',
      review_state: 'pending',
      created_at: new Date().toISOString(),
      pending_commitment: null,
      rendered_intentions: [{ key: 'understand_order', eligibleAt: ANCHOR }],
      ...overrides,
    },
    error: null,
  }
}

/** Drain whatever waitUntil captured, so fire-and-forget work has actually run. */
async function settle() {
  await Promise.all(scheduled)
}

beforeEach(() => {
  vi.clearAllMocks()
  scheduled.length = 0
  selectArgs.length = 0
  captureRecordingFailedMock.mockResolvedValue(undefined)
  recordIntentionPromptsMock.mockResolvedValue({
    kind: 'recorded',
    raisedKeys: ['understand_order'],
    classifierAttempts: 1,
  })
  guestMaybeSingleMock.mockResolvedValue({
    data: { phone_number: '+15555550123', opted_out_at: null },
    error: null,
  })
  sendMessageMock.mockResolvedValue({
    ok: true,
    data: { providerMessageId: 'p-1', status: 'QUEUED' },
  })
})

describe('dispatchOperatorOutbound — recording the ask (TAC-385)', () => {
  it('records on an operator-approved send', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    expect(r.ok).toBe(true)
    expect(recordIntentionPromptsMock).toHaveBeenCalledTimes(1)
    expect(recordIntentionPromptsMock.mock.calls[0][0]).toMatchObject({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      messageId: MESSAGE_ID,
      sentBody: DRAFTED,
    })
  })

  // THE ONE THAT MATTERS. A mutant passing `row.body` here fails, because
  // EDITED !== DRAFTED by construction.
  // NON-BEHAVIOURAL, and the only thing that proves the column is read FROM THE
  // ROW rather than handed over by the fixture. The mock returns the whole row
  // whatever the query asks for, so without this every test here passes against
  // a production build whose SELECT never fetches the column.
  it('SELECTs rendered_intentions from the messages row', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })

    const messagesSelect = selectArgs.find((c) => c.includes('pending_commitment'))
    expect(messagesSelect).toBeDefined()
    expect(messagesSelect).toContain('rendered_intentions')
  })

  // The stamp lands at DISPATCH time, not draft time. A draft can sit in the
  // queue for hours, and `prompted_at` is what the brake compares against
  // inbound timestamps — stamping it at row creation would age every prompt.
  it('stamps now, not the draft created_at', async () => {
    const createdAt = new Date('2026-09-10T08:00:00.000Z')
    rowMaybeSingleMock.mockResolvedValue(row({ created_at: createdAt.toISOString() }))
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    const { now } = recordIntentionPromptsMock.mock.calls[0][0]
    expect(now.getTime()).toBeGreaterThan(createdAt.getTime())
  })

  // `sendBody` is trimmed; `bodyToDispatch` (the empty-body guard's variable) is
  // not. They differ only on an untrimmed edit, so without this fixture a mutant
  // recording the untrimmed one is invisible. What is recorded must be exactly
  // what was sent.
  it('records exactly the trimmed text that reached the provider', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'edit',
      editedBody: `   ${EDITED}   `,
    })
    await settle()

    expect(recordIntentionPromptsMock.mock.calls[0][0].sentBody).toBe(EDITED)
    expect(sendMessageMock.mock.calls[0][0].body).toBe(EDITED)
  })

  // Every other fixture ends with exactly one surviving entry, so nothing else
  // proves two intentions survive parsing together.
  it('carries every surviving intention, not just the first', async () => {
    rowMaybeSingleMock.mockResolvedValue(
      row({
        rendered_intentions: [
          { key: 'understand_order', eligibleAt: ANCHOR },
          { key: 'learn_name', eligibleAt: ANCHOR },
        ],
      }),
    )
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    const { openIntentions } = recordIntentionPromptsMock.mock.calls[0][0]
    expect(openIntentions.map((o: { key: string }) => o.key)).toEqual([
      'understand_order',
      'learn_name',
    ])
  })

  // Nothing was dispatched, so nothing was asked. Today this holds positionally
  // (both already-acted returns precede step 8); the assertion is what stops a
  // refactor that hoists the parse from burning a Haiku call per duplicate tap
  // and, on a classifier double-failure, closing intentions for a send this
  // caller never made.
  it('records nothing when another operator already acted', async () => {
    rowMaybeSingleMock.mockResolvedValue(row({ review_state: 'approved' }))
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-2',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    expect(r).toMatchObject({ ok: true, outcome: 'already_acted' })
    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })

  // The other half of invariant 6. `returns ok when recording rejects` pins the
  // .catch; this pins the fire-and-forget — a Haiku round trip must never sit in
  // front of the operator's approve tap. With `await` in place of `waitUntil`
  // this hangs rather than returning.
  it('returns without waiting for the classifier', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    let release: (() => void) | undefined
    recordIntentionPromptsMock.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ kind: 'nothing_raised' })
      }),
    )

    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })

    expect(r).toMatchObject({ ok: true, outcome: 'sent' })
    expect(recordIntentionPromptsMock).toHaveBeenCalled()
    release?.()
    await settle()
  })

  // MAJOR from code review: this path only console.warn'd, on the send path
  // where a pessimistic closure is MOST likely to be wrong (the offered set came
  // from a draft the operator may have rewritten). Two Anthropic failures in a
  // row can close up to seven one-shot goals permanently; an ephemeral Vercel
  // log line is not a record of that.
  it('alerts when the classifier fails twice and everything is closed', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    recordIntentionPromptsMock.mockResolvedValue({
      kind: 'closed_pessimistically',
      closedKeys: ['understand_order'],
      classifierError: 'overloaded',
    })
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'edit',
      editedBody: EDITED,
    })
    await settle()

    expect(captureRecordingFailedMock).toHaveBeenCalledTimes(1)
    expect(captureRecordingFailedMock.mock.calls[0][0]).toMatchObject({
      agentRunId: null,
      via: 'operator_edit',
      outcome: 'closed_pessimistically',
      keys: ['understand_order'],
    })
  })

  it('alerts when the write fails, and names the approve path', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    recordIntentionPromptsMock.mockResolvedValue({
      kind: 'write_failed',
      keys: ['understand_order'],
      source: 'classified',
      error: 'pg down',
    })
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    expect(captureRecordingFailedMock.mock.calls[0][0]).toMatchObject({
      via: 'operator_approve',
      outcome: 'write_failed',
      source: 'classified',
    })
  })

  it('does not alert on an ordinary successful recording', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    expect(captureRecordingFailedMock).not.toHaveBeenCalled()
  })

  it('records the EDITED body on an edit, not the stored draft', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'edit',
      editedBody: EDITED,
    })
    await settle()

    const arg = recordIntentionPromptsMock.mock.calls[0][0]
    expect(arg.sentBody).toBe(EDITED)
    expect(arg.sentBody).not.toBe(DRAFTED)
  })

  // The operator edited the question out. Nothing here detects that — the
  // classifier is simply shown text with no question in it. This test pins the
  // INPUT that makes that work, which is the only part this layer controls.
  it('shows the classifier the text the guest actually received', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'edit',
      editedBody: EDITED,
    })
    await settle()

    const [{ sentBody }] = recordIntentionPromptsMock.mock.calls[0]
    expect(sentBody).not.toContain('What did you end up getting?')
    expect(sendMessageMock.mock.calls[0][0].body).toBe(sentBody)
  })

  it('carries the rendered eligibleAt anchor through verbatim', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    const { openIntentions } = recordIntentionPromptsMock.mock.calls[0][0]
    expect(openIntentions).toHaveLength(1)
    expect(openIntentions[0].key).toBe('understand_order')
    expect(openIntentions[0].eligibleAt.toISOString()).toBe(ANCHOR)
  })

  it('records nothing when the column is null', async () => {
    rowMaybeSingleMock.mockResolvedValue(row({ rendered_intentions: null }))
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    expect(r.ok).toBe(true)
    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })

  it('records nothing when the column is an empty array', async () => {
    rowMaybeSingleMock.mockResolvedValue(row({ rendered_intentions: [] }))
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })

  it('drops a retired key and still records its live siblings', async () => {
    rowMaybeSingleMock.mockResolvedValue(
      row({
        rendered_intentions: [
          { key: 'invite_contact_save', eligibleAt: ANCHOR },
          { key: 'learn_name', eligibleAt: ANCHOR },
        ],
      }),
    )
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    const { openIntentions } = recordIntentionPromptsMock.mock.calls[0][0]
    expect(openIntentions.map((o: { key: string }) => o.key)).toEqual(['learn_name'])
  })

  // Migration 040 renames learn_first_order to understand_order, and rows the
  // old code wrote before the post-deploy backfill re-run still carry the old
  // key. Reading it as the new one means a guest asked in that window is not
  // asked again.
  it('resolves the learn_first_order alias', async () => {
    rowMaybeSingleMock.mockResolvedValue(
      row({ rendered_intentions: [{ key: 'learn_first_order', eligibleAt: ANCHOR }] }),
    )
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    const { openIntentions } = recordIntentionPromptsMock.mock.calls[0][0]
    expect(openIntentions.map((o: { key: string }) => o.key)).toEqual(['understand_order'])
  })

  it('drops an entry whose eligibleAt cannot be parsed', async () => {
    rowMaybeSingleMock.mockResolvedValue(
      row({
        rendered_intentions: [
          { key: 'understand_order', eligibleAt: 'not-a-date' },
          { key: 'learn_name', eligibleAt: ANCHOR },
        ],
      }),
    )
    await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    const { openIntentions } = recordIntentionPromptsMock.mock.calls[0][0]
    expect(openIntentions.map((o: { key: string }) => o.key)).toEqual(['learn_name'])
  })

  it('survives a malformed payload without failing the dispatch', async () => {
    rowMaybeSingleMock.mockResolvedValue(row({ rendered_intentions: { nope: true } }))
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    expect(r.ok).toBe(true)
    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })

  // The message has already gone out. A recording failure must never turn a
  // successful dispatch into a 502.
  it('returns ok when recording rejects', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    recordIntentionPromptsMock.mockRejectedValue(new Error('haiku exploded'))
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    expect(r).toMatchObject({ ok: true, outcome: 'sent' })
  })

  // Nothing reached the guest, so nothing was asked.
  it('does not record when the provider rejects the send', async () => {
    rowMaybeSingleMock.mockResolvedValue(row())
    sendMessageMock.mockResolvedValue({ ok: false, error: 'sendblue down' })
    const r = await dispatchOperatorOutbound({
      messageId: MESSAGE_ID,
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      action: 'approve',
    })
    await settle()

    expect(r).toMatchObject({ ok: false, errorCode: 'sendblue_failed' })
    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })
})
