// TAC-516: Meta's data-deletion callback. Meta tests this endpoint directly,
// so the response shape is as load-bearing as the deletion itself.

import { createHmac } from 'node:crypto'

import { formatWithOptions } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deleteMock = vi.fn()
vi.mock('@/lib/messaging/instagram/delete-venue-data', () => ({
  deleteInstagramVenueData: (...a: unknown[]) => deleteMock(...a),
}))

const unmatchedMock = vi.fn()
vi.mock('@/lib/analytics/posthog', () => ({
  captureInstagramDeletionUnmatchedAccount: (...a: unknown[]) => unmatchedMock(...a),
}))

const insertMock = vi.fn()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert: (row: unknown) => insertMock(row) }) }),
}))

import { POST } from './route'

const SECRET = 'app-secret-value'
const ACCOUNT_ID = '17841479626987104'
const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const CODE = 'abcdef0123456789abcdef0123456789'
const ORIGINAL = { ...process.env }

function signedRequest(payload: unknown, secret = SECRET): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url')
  return `${signature}.${payloadB64}`
}

function call(body: string | null): Promise<Response> {
  const form = new FormData()
  if (body !== null) form.set('signed_request', body)
  return POST(
    new Request('https://webhooks.theanalog.company/api/instagram/data-deletion', {
      method: 'POST',
      body: form,
    }),
  )
}

const logged: unknown[][] = []
// JSON.stringify renders a Headers, an Error or a URLSearchParams as {},
// so it would report a leak through any of them as clean (TAC-458). This
// renders what console actually prints, with every limit lifted.
function loggedText(): string {
  return logged
    .map((args) =>
      formatWithOptions(
        { depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity, breakLength: Infinity },
        ...args,
      ),
    )
    .join('\n')
}
beforeEach(() => {
  vi.clearAllMocks()
  logged.length = 0
  process.env.INSTAGRAM_APP_SECRET = SECRET
  process.env.INSTAGRAM_OAUTH_REDIRECT_URL = 'https://webhooks.theanalog.company/api/instagram/callback'
  deleteMock.mockResolvedValue({
    ok: true,
    venueId: VENUE_ID,
    guestsAffected: 3,
    confirmationCode: CODE,
  })
  insertMock.mockResolvedValue({ error: null })
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      logged.push(a)
    })
  }
})

afterEach(() => {
  process.env = { ...ORIGINAL }
  vi.restoreAllMocks()
})

describe('POST /api/instagram/data-deletion', () => {
  // Meta's required shape. Getting this wrong fails App Review.
  it('answers in the shape Meta requires', async () => {
    const res = await call(signedRequest({ user_id: ACCOUNT_ID }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['confirmation_code', 'url'])
    expect(body.confirmation_code).toBe(CODE)
    expect(body.url).toBe(
      `https://webhooks.theanalog.company/api/instagram/data-deletion/status?id=${CODE}`,
    )
  })

  // Ruling 2: it deletes. "We recorded your request" was the rejected option.
  it('actually redacts, for the account Meta named', async () => {
    await call(signedRequest({ user_id: ACCOUNT_ID }))
    expect(deleteMock).toHaveBeenCalledWith(expect.anything(), ACCOUNT_ID)
  })

  // The receipt is alongside the deletion, not instead of it.
  it('records the request with what it touched', async () => {
    await call(signedRequest({ user_id: ACCOUNT_ID }))
    const [row] = insertMock.mock.calls[0] as [Record<string, unknown>]
    expect(row).toMatchObject({
      confirmation_code: CODE,
      instagram_account_id: ACCOUNT_ID,
      venue_id: VENUE_ID,
      guests_affected: 3,
    })
    expect(row.completed_at).not.toBeNull()
  })

  // A failed redaction still owes the requester a code, and the receipt must
  // record that it did NOT complete rather than leaving no trace.
  it('records an incomplete request when the redaction fails, and still answers in shape', async () => {
    deleteMock.mockResolvedValue({ ok: false, error: 'write conflict', confirmationCode: CODE })
    const res = await call(signedRequest({ user_id: ACCOUNT_ID }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ confirmation_code: CODE })

    const [row] = insertMock.mock.calls[0] as [Record<string, unknown>]
    expect(row.completed_at).toBeNull()
    expect(loggedText()).toContain('instagram_data_deletion_failed')
  })

  // Legitimate on its own, and also what a wrong id assumption looks like.
  it('alerts when the account matched no venue', async () => {
    deleteMock.mockResolvedValue({ ok: true, venueId: null, guestsAffected: 0, confirmationCode: CODE })
    const res = await call(signedRequest({ user_id: 'unknown' }))
    expect(res.status).toBe(200)
    expect(unmatchedMock).toHaveBeenCalledWith({ confirmationCode: CODE })
  })

  it('does not alert when a venue matched', async () => {
    await call(signedRequest({ user_id: ACCOUNT_ID }))
    expect(unmatchedMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a forged signature', () => signedRequest({ user_id: ACCOUNT_ID }, 'wrong-secret')],
    ['a malformed value', () => 'garbage'],
  ])('refuses %s with 403 and deletes nothing', async (_label, make) => {
    const res = await call(make())
    expect(res.status).toBe(403)
    expect(deleteMock).not.toHaveBeenCalled()
    expect(insertMock).not.toHaveBeenCalled()
  })

  it('refuses every delivery when the app secret is unset', async () => {
    delete process.env.INSTAGRAM_APP_SECRET
    const res = await call(signedRequest({ user_id: ACCOUNT_ID }, ''))
    expect(res.status).toBe(403)
    expect(deleteMock).not.toHaveBeenCalled()
  })

  // A failed receipt must not cost Meta its answer: the data is already gone.
  it('still answers in shape when the receipt cannot be written', async () => {
    insertMock.mockResolvedValue({ error: { message: 'insert failed' } })
    const res = await call(signedRequest({ user_id: ACCOUNT_ID }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ confirmation_code: CODE })
    expect(loggedText()).toContain('instagram_data_deletion_unrecorded')
  })

  it('never logs the signed request or the secret', async () => {
    const signed = signedRequest({ user_id: ACCOUNT_ID }, 'wrong-secret')
    await call(signed)
    const rendered = loggedText()
    expect(rendered).not.toContain(signed)
    expect(rendered).not.toContain(SECRET)
  })
})
