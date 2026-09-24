// TAC-516: the deletion status page Meta's tester opens.
//
// It is public and holds only a bearer-ish confirmation code, so the thing
// worth pinning is how LITTLE it says.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const maybeSingleMock = vi.fn()
const eqMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }))
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({ from: () => ({ select: () => ({ eq: eqMock }) }) }),
}))

import { GET } from './route'

const CODE = 'abcdef0123456789abcdef0123456789'

function call(id: string | null): Promise<Response> {
  const url = new URL('https://webhooks.theanalog.company/api/instagram/data-deletion/status')
  if (id !== null) url.searchParams.set('id', id)
  return GET(new Request(url.toString()))
}

beforeEach(() => {
  vi.clearAllMocks()
  maybeSingleMock.mockResolvedValue({ data: { completed_at: '2026-10-01T12:00:00.000Z' }, error: null })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /api/instagram/data-deletion/status', () => {
  it('confirms a completed request as HTML', async () => {
    const res = await call(CODE)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Data deleted')
  })

  // An unknown code and a pending one must read the same, or the endpoint
  // becomes a way to discover which codes are real.
  it('reports an unknown code and a pending one identically', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null })
    const unknown = await (await call(CODE)).text()

    maybeSingleMock.mockResolvedValue({ data: { completed_at: null }, error: null })
    const pending = await (await call(CODE)).text()

    expect(unknown).toBe(pending)
  })

  it.each([
    ['missing', null],
    ['not hex', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['too short', 'abcdef'],
    ['an injection attempt', "' or 1=1--"],
  ])('refuses a %s id without querying', async (_label, id) => {
    const res = await call(id)
    expect(res.status).toBe(404)
    expect(eqMock).not.toHaveBeenCalled()
  })

  it('says nothing about the venue, the account or how many guests were affected', async () => {
    const body = await (await call(CODE)).text()
    for (const leak of ['venue', 'guest', 'account', '17841']) {
      expect(body.toLowerCase()).not.toContain(leak)
    }
  })

  it('reports a lookup failure without claiming the data is gone', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'timeout' } })
    const res = await call(CODE)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('Data deleted')
  })
})
