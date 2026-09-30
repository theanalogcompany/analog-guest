// Tests for the Jev classification arm. All network is faked through the
// `deps` parameter (env + fetchImpl) - global fetch is never touched. Pins:
// the happy-path mapping, both sides of both noul thresholds, one distinct
// errorCode per failure path, the exact request shape, the drift guard tying
// this module's category keys to the Haiku schema enum, and the
// loyalty-language ban on everything sent to the vendor.
import { describe, expect, it, vi } from 'vitest'
// Relative imports — vitest doesn't pick up Next's `@/*` alias under our setup.
import {
  CLASSIFIER_CATEGORIES,
  CLASSIFY_JEV_PROMPT_VERSION,
  classifyMessageViaJev,
  JEV_CATEGORY_CRITERIA,
  TYPESAFE_SYSTEMONE_URL,
  type JevClassifyState,
} from './classify-message-jev'
import { ClassifiedMessageSchema } from './classify-message'

const VALID_KEY = 'apikey_' + 'a'.repeat(60)
const ENV = { JEV_API_KEY: VALID_KEY }

const STATE: JevClassifyState = { inbound_message: 'sounds good, see you then' }

function jevBody(overrides?: {
  crisisNoul?: number
  correctsNoul?: number
  choice?: string
  probabilities?: Record<string, number>
}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      category: {
        type: 'choice',
        choice: overrides?.choice ?? 'reply',
        confidence: 0.9,
        probabilities: overrides?.probabilities ?? { reply: 0.9, new_question: 0.1 },
      },
      crisis: { type: 'noul', noul: overrides?.crisisNoul ?? 0.01 },
      corrects_pending: { type: 'noul', noul: overrides?.correctsNoul ?? 0.05 },
    },
  }
}

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('classifyMessageViaJev — happy path', () => {
  it('maps a clean 200 into a ClassifyMessageResult', async () => {
    const r = await classifyMessageViaJev(STATE, { env: ENV, fetchImpl: fakeFetch(jevBody()) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.category).toBe('reply')
    expect(r.data.classifierConfidence).toBe(0.9)
    expect(r.data.crisisSafety).toBe(false)
    expect(r.data.correctsPendingReply).toBe(false)
    expect(r.data.promptVersion).toBe(CLASSIFY_JEV_PROMPT_VERSION)
    // Reasoning is the observability surface: it names the actual model
    // version that answered and the runner-up category.
    expect(r.data.reasoning).toContain('jev-1.13.0')
    expect(r.data.reasoning).toContain('new_question')
  })
})

describe('classifyMessageViaJev — noul thresholds, both sides', () => {
  // The asymmetry is the design: crisis flips true LOW (prefer-true rule),
  // corrects_pending flips true HIGH (prefer-false rule). Literal values on
  // purpose, so swapping the two constants in source fails here.
  it('flags crisisSafety at exactly 0.2', async () => {
    const r = await classifyMessageViaJev(STATE, {
      env: ENV,
      fetchImpl: fakeFetch(jevBody({ crisisNoul: 0.2 })),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.crisisSafety).toBe(true)
  })

  it('does not flag crisisSafety at 0.19', async () => {
    const r = await classifyMessageViaJev(STATE, {
      env: ENV,
      fetchImpl: fakeFetch(jevBody({ crisisNoul: 0.19 })),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.crisisSafety).toBe(false)
  })

  it('sets correctsPendingReply at exactly 0.75', async () => {
    const r = await classifyMessageViaJev(STATE, {
      env: ENV,
      fetchImpl: fakeFetch(jevBody({ correctsNoul: 0.75 })),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.correctsPendingReply).toBe(true)
  })

  it('does not set correctsPendingReply at 0.74', async () => {
    const r = await classifyMessageViaJev(STATE, {
      env: ENV,
      fetchImpl: fakeFetch(jevBody({ correctsNoul: 0.74 })),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.correctsPendingReply).toBe(false)
  })
})

describe('classifyMessageViaJev — failure paths, one errorCode each', () => {
  it('returns jev_env_missing and never fetches when the key is absent', async () => {
    const fetchImpl = fakeFetch(jevBody())
    const r = await classifyMessageViaJev(STATE, { env: {}, fetchImpl })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('jev_env_missing')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns jev_env_missing and never fetches when the key is malformed', async () => {
    const fetchImpl = fakeFetch(jevBody())
    const r = await classifyMessageViaJev(STATE, {
      env: { JEV_API_KEY: 'not-an-apikey' },
      fetchImpl,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('jev_env_missing')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns jev_http_429 on a 429, carrying the status in the code', async () => {
    const r = await classifyMessageViaJev(STATE, {
      env: ENV,
      fetchImpl: fakeFetch({ anything: true }, 429),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('jev_http_429')
  })

  it('returns jev_bad_response on an unparseable body', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json at all', { status: 200 }))
    const r = await classifyMessageViaJev(STATE, { env: ENV, fetchImpl })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('jev_bad_response')
  })

  it('returns jev_bad_response on a schema-mismatched body', async () => {
    const r = await classifyMessageViaJev(STATE, {
      env: ENV,
      fetchImpl: fakeFetch({ model: 'jev-1.13.0', answers: { category: { type: 'choice' } } }),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('jev_bad_response')
  })

  it('returns jev_timeout when fetch rejects with a TimeoutError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })
    })
    const r = await classifyMessageViaJev(STATE, { env: ENV, fetchImpl })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('jev_timeout')
  })

  it('returns jev_network when fetch rejects with a generic error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const r = await classifyMessageViaJev(STATE, { env: ENV, fetchImpl })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('jev_network')
  })

  it('returns jev_bad_category when the choice is outside the enum, not an unknown reply', async () => {
    const r = await classifyMessageViaJev(STATE, {
      env: ENV,
      fetchImpl: fakeFetch(jevBody({ choice: 'welcome', probabilities: { welcome: 0.9, reply: 0.1 } })),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('jev_bad_category')
  })
})

// Capture what actually went over the wire. Snapshot inside the mock: the
// recorded body string is immutable, so no live-reference trap here.
async function captureRequest(state: JevClassifyState) {
  let captured: { url: string; init: RequestInit } | null = null
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} }
    return new Response(JSON.stringify(jevBody()), { status: 200 })
  })
  const r = await classifyMessageViaJev(state, { env: ENV, fetchImpl: fetchImpl as typeof fetch })
  expect(r.ok).toBe(true)
  expect(captured).not.toBeNull()
  const { url, init } = captured! as { url: string; init: RequestInit }
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> }
}

describe('classifyMessageViaJev — request shape', () => {
  const FULL_STATE: JevClassifyState = {
    venue_context: 'a cafe on a corner',
    recent_conversation: '[guest, 5 minutes ago] hi',
    guest_relationship: 'regular',
    inbound_message: 'actually make that oat milk',
    inbound_message_full_for_crisis_check: 'actually make that oat milk, full text',
  }

  it('posts the jev-latest model, the three typed questions, and the state verbatim', async () => {
    const { url, body } = await captureRequest(FULL_STATE)
    expect(url).toBe(TYPESAFE_SYSTEMONE_URL)
    expect(body.model).toBe('jev-latest')
    const questions = body.questions as Record<string, { type: string; criteria?: unknown }>
    expect(questions.category.type).toBe('choice')
    expect(questions.category.criteria).toEqual(JEV_CATEGORY_CRITERIA)
    expect(questions.crisis.type).toBe('noul')
    expect(questions.corrects_pending.type).toBe('noul')
    // Verbatim: the state block is the contract that both arms judge
    // identical inputs. toEqual, not toMatchObject - a dropped field is the bug.
    expect(body.state).toEqual(FULL_STATE)
  })

  it('sends the env key as a Bearer token', async () => {
    const { init } = await captureRequest(STATE)
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${VALID_KEY}`)
    expect(headers['Content-Type']).toBe('application/json')
  })

  /**
   * The jev-v1.1.0 change, pinned because it has ALREADY been lost once: a
   * mutation-pass restore reverted the criteria while the version comment
   * survived, leaving a changelog claiming a behaviour the wire did not
   * carry. Without these criteria, jev-1.13.0 measured the ambiguous
   * "I want to end it soon" at crisis p(yes)=0.06 (a false negative the
   * eval ceiling failed); with them, 0.70.
   */
  it('sends true/false criteria on the crisis noul carrying the prefer-true asymmetry (jev-v1.1.0)', async () => {
    const { body } = await captureRequest(STATE)
    const questions = body.questions as Record<string, { criteria?: { true?: string; false?: string } }>
    expect(questions.crisis.criteria?.true).toContain('genuinely ambiguous')
    expect(questions.crisis.criteria?.false).toContain(
      'only choose false when the innocuous reading is the only plausible one',
    )
  })
})

describe('classifyMessageViaJev — drift guard against the Haiku enum', () => {
  // The whole point of this file per the module header: the Jev criteria are
  // a PARALLEL COPY of the Haiku prompt's semantics, and this is what stops
  // the three lists drifting apart silently.
  const haikuOptions = ClassifiedMessageSchema.shape.category.options.slice().sort()

  it('JEV_CATEGORY_CRITERIA keys exactly equal the Haiku schema enum options', () => {
    expect(Object.keys(JEV_CATEGORY_CRITERIA).sort()).toEqual(haikuOptions)
  })

  it('CLASSIFIER_CATEGORIES exactly equals the Haiku schema enum options', () => {
    expect(CLASSIFIER_CATEGORIES.slice().sort()).toEqual(haikuOptions)
  })
})

describe('classifyMessageViaJev — loyalty-language ban (product principle)', () => {
  // "Recognition, not loyalty": no loyalty-program language in anything this
  // repo emits, including instructions sent to a vendor. Word-boundary
  // regexes so 'learn' and 'pointed' cannot false-positive; 'points' plural
  // only, because the crisis instruction legitimately says "does not see the
  // point of continuing" and singular 'point' is not program language. The
  // perk_inquiry criterion talks about perks and RECOGNITION, deliberately -
  // the Haiku prompt's 'recognition tiers' phrasing was not carried over.
  const BANNED = [/\bpoints\b/i, /\brewards?\b/i, /\btiers?\b/i, /\bearn(s|ed|ing)?\b/i]

  it('no category criterion uses loyalty-program language', () => {
    const values = Object.values(JEV_CATEGORY_CRITERIA)
    expect(values.length).toBe(13) // guard the guard: the scan saw the full set
    for (const text of values) {
      for (const banned of BANNED) {
        expect(text).not.toMatch(banned)
      }
    }
  })

  it('perk_inquiry frames the question as recognition, not tiers', () => {
    expect(JEV_CATEGORY_CRITERIA.perk_inquiry).toContain('recognition')
    expect(JEV_CATEGORY_CRITERIA.perk_inquiry).toContain('what they unlock')
  })

  it('none of the three instruction strings sent over the wire uses loyalty-program language', async () => {
    const { body } = await captureRequest(STATE)
    const questions = body.questions as Record<string, { instructions: string }>
    const instructions = [
      questions.category.instructions,
      questions.crisis.instructions,
      questions.corrects_pending.instructions,
    ]
    for (const text of instructions) {
      expect(text.length).toBeGreaterThan(0) // guard the guard: not scanning undefined
      for (const banned of BANNED) {
        expect(text).not.toMatch(banned)
      }
    }
  })
})
