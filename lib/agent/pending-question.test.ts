// TAC-364: the repo's first test for this module.
//
// The thing under test is the PostgREST `.or()` filter string, and it is worth
// being precise about why it needs a test at all and why this is the shape of
// one.
//
// Until TAC-364 the review_reason legs were hand-listed here and hand-listed
// again in `isKnowledgeGapCard`, and they DRIFTED: this query carried one value
// where the predicate carried two, so a `knowledge_gap_backstop` card whose
// clock had already fired was recognized by the predicate and invisible to this
// query — the `## Unanswered question` block silently vanished for that guest
// while the card still sat in the operator's queue. The comment at the query
// claimed the two mirrored each other the whole time.
//
// The key-set half of that is now fixed structurally: both sites read one
// exported `KNOWLEDGE_GAP_CARD_REVIEW_REASONS`. But the fix replaced a literal
// string with a CONSTRUCTED one, and every mutation inside the construction
// survives silently: a `.join(' ')`, a dropped `.`, `eq` → `neq` all produce a
// filter that Postgres either rejects or matches nothing, and the symptom is
// the exact one this ticket is fixing.
//
// So the assertion is on the filter STRING, not on behaviour. A behavioural
// test cannot reach this — the filter is evaluated by Postgres, and any mock
// that stands in for Postgres is asserting its own opinion of the query rather
// than the query. Same technique, and the same reasoning, as
// `heads-up-queue.test.ts` capturing its `select()` argument and
// `handle-operator-decline.test.ts` asserting an import set.
//
// The fail-open posture is covered too, because it is load-bearing: a DB
// hiccup here costs one prompt block, and failing the agent run instead would
// be a far larger outage for something that is a nudge, not a guardrail.

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Importing `./stages` for KNOWLEDGE_GAP_CARD_REVIEW_REASONS pulls the Voyage
// SDK in transitively, and vitest's ESM resolver trips on its directory
// import at module load — the documented trap in CLAUDE.md §"Module split for
// testability". Same stub `lib/tunables/manifest.test.ts` uses for the same
// reason. Mocking the constant instead would defeat the point: the second test
// below exists to compare this filter against the REAL shared array.
vi.mock('voyageai', () => ({
  VoyageAIClient: class {},
}))

const orMock = vi.fn()
// TAC-394: every order()/limit() call on the card query, in call order.
const cardChainCalls: unknown[][] = []
const cardMaybeSingle = vi.fn()
const inboundMaybeSingle = vi.fn()

// Table-aware: this module makes TWO round trips against `messages` — the card
// lookup (filtered, `.or()`) and then the inbound it replies to (by id). A
// single undifferentiated chain would answer both with the same row, which is
// a mock contradicting production rather than standing in for it.
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const cardChain = {
        select: () => cardChain,
        eq: () => cardChain,
        or: (filter: string) => {
          orMock(filter)
          return cardChain
        },
        order: (column: string, opts: unknown) => {
          cardChainCalls.push(['order', column, opts])
          return cardChain
        },
        limit: (n: number) => {
          cardChainCalls.push(['limit', n])
          return cardChain
        },
        maybeSingle: () => cardMaybeSingle(),
      }
      const inboundChain = {
        select: () => inboundChain,
        eq: () => inboundChain,
        maybeSingle: () => inboundMaybeSingle(),
      }
      // The card query is the only one that calls `.or()`; the inbound lookup
      // is a bare `.eq('id')`. Route on whether `.or()` has been reached yet.
      return orMock.mock.calls.length === 0 ? cardChain : inboundChain
    },
  }),
}))

import { findPendingQuestion, loadInboundQuestion } from './pending-question'
import { KNOWLEDGE_GAP_CARD_REVIEW_REASONS } from './stages'

const VENUE = '00000000-0000-0000-0000-0000000000aa'
const GUEST = '00000000-0000-0000-0000-0000000000bb'

beforeEach(() => {
  orMock.mockReset()
  cardChainCalls.length = 0
  cardMaybeSingle.mockReset()
  inboundMaybeSingle.mockReset()
  cardMaybeSingle.mockResolvedValue({ data: null, error: null })
  inboundMaybeSingle.mockResolvedValue({ data: null, error: null })
})

describe('findPendingQuestion — the card filter (TAC-364)', () => {
  it('builds one leg per gap-card review_reason, plus the clock leg', async () => {
    await findPendingQuestion(VENUE, GUEST)
    expect(orMock).toHaveBeenCalledTimes(1)
    // Transcribed as a literal rather than rebuilt from the constant: a test
    // that constructs the expected string the same way the source does would
    // pass against any construction at all, including a broken one.
    expect(orMock.mock.calls[0][0]).toBe(
      'pending_until.not.is.null,' +
        'review_reason.eq.knowledge_gap,' +
        'review_reason.eq.knowledge_gap_backstop,' +
        'review_reason.eq.generation_failed',
    )
  })

  it('covers every value isKnowledgeGapCard accepts', async () => {
    // The drift guard. The literal above is what actually pins the syntax;
    // this pins the SET, so a value added to the shared array without the
    // literal being updated fails here with a message naming the missing one.
    await findPendingQuestion(VENUE, GUEST)
    const filter = orMock.mock.calls[0][0] as string
    for (const reason of KNOWLEDGE_GAP_CARD_REVIEW_REASONS) {
      expect(filter).toContain(`review_reason.eq.${reason}`)
    }
    // Exactly one leg per reason, plus the pending_until leg — catches a
    // duplicated or stray leg that `toContain` alone would wave through.
    expect(filter.split(',')).toHaveLength(KNOWLEDGE_GAP_CARD_REVIEW_REASONS.length + 1)
  })

  it('keeps the clock leg first, so a card with a co-fired label still matches', async () => {
    // `pending_until.not.is.null` is what catches a gap card whose
    // review_reason was won by a co-firing trigger (a comp commitment on the
    // same turn). Losing it would make the filter label-only, which is the
    // narrower of the two conditions isKnowledgeGapCard ORs together.
    await findPendingQuestion(VENUE, GUEST)
    expect((orMock.mock.calls[0][0] as string).startsWith('pending_until.not.is.null,')).toBe(
      true,
    )
  })
})

describe('findPendingQuestion — fail-open (TAC-308)', () => {
  it('returns null rather than throwing when the card lookup errors', async () => {
    cardMaybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(findPendingQuestion(VENUE, GUEST)).resolves.toBeNull()
  })

  it('returns null when no card is pending', async () => {
    await expect(findPendingQuestion(VENUE, GUEST)).resolves.toBeNull()
  })

  it('returns null when the card has no linked inbound', async () => {
    // A card with nothing in reply_to_message_id has no question to render,
    // which is different from a DB failure but degrades the same way.
    cardMaybeSingle.mockResolvedValue({
      data: {
        id: 'card-1',
        reply_to_message_id: null,
        pending_until: '2026-09-14T00:00:00Z',
        review_reason: 'knowledge_gap',
      },
      error: null,
    })
    await expect(findPendingQuestion(VENUE, GUEST)).resolves.toBeNull()
  })
})

// TAC-484: before this, ANY non-empty inbound body qualified as "the
// question" a card holds, so a card replying to a plain statement still
// rendered "the venue still owes them an answer" as settled fact. The
// 2026-09-18 incident's inbound is the fixture below.
describe('findPendingQuestion — the linked inbound must read as a question (TAC-484)', () => {
  it('returns null when the linked inbound is a statement, not a question', async () => {
    cardMaybeSingle.mockResolvedValue({
      data: {
        id: 'card-1',
        reply_to_message_id: 'inbound-1',
        // NULL, because TAC-484 stopped a backstop catch arming the clock at
        // all. This fixture carried a timestamp until code review: harmless to
        // the assertion, but a row state the same ticket made unreachable, and
        // a fixture modelling an impossible row is what migration 046's entry
        // is about.
        pending_until: null,
        review_reason: 'knowledge_gap_backstop',
      },
      error: null,
    })
    inboundMaybeSingle.mockResolvedValue({
      data: {
        id: 'inbound-1',
        // The literal TAC-484 incident body.
        body: 'oh and i got the pink panther yesterday',
        created_at: '2026-09-18T15:40:00Z',
        provider_message_id: 'p1',
      },
      error: null,
    })
    await expect(findPendingQuestion(VENUE, GUEST)).resolves.toBeNull()
  })

  it('still returns the question when the linked inbound reads as one', async () => {
    cardMaybeSingle.mockResolvedValue({
      data: {
        id: 'card-1',
        reply_to_message_id: 'inbound-1',
        pending_until: '2026-09-18T15:47:37Z',
        review_reason: 'knowledge_gap',
      },
      error: null,
    })
    inboundMaybeSingle.mockResolvedValue({
      data: {
        id: 'inbound-1',
        body: 'what grade is the matcha?',
        created_at: '2026-09-18T15:40:00Z',
        provider_message_id: 'p1',
      },
      error: null,
    })
    const result = await findPendingQuestion(VENUE, GUEST)
    expect(result?.question.question).toBe('what grade is the matcha?')
  })
})

// `loadInboundQuestion` is called on its own here, with no preceding `.or()`
// call — the shared mock's card/inbound routing keys on whether `.or()` has
// been reached yet (see the mock setup above), so with a fresh, reset orMock
// a standalone call routes to the card chain. Its `.select().eq().maybeSingle()`
// shape is identical either way, so `cardMaybeSingle` is what to seed here.
describe('loadInboundQuestion — question gate (TAC-484)', () => {
  it('returns null for a non-empty body that does not read as a question', async () => {
    cardMaybeSingle.mockResolvedValue({
      data: {
        id: 'inbound-1',
        body: 'oh and i got the pink panther yesterday',
        created_at: '2026-09-18T15:40:00Z',
        provider_message_id: 'p1',
      },
      error: null,
    })
    await expect(loadInboundQuestion('inbound-1')).resolves.toBeNull()
  })

  it('returns the question for a body that reads as one', async () => {
    cardMaybeSingle.mockResolvedValue({
      data: {
        id: 'inbound-1',
        body: 'do you have oat milk?',
        created_at: '2026-09-18T15:40:00Z',
        provider_message_id: 'p1',
      },
      error: null,
    })
    const result = await loadInboundQuestion('inbound-1')
    expect(result?.question).toBe('do you have oat milk?')
  })
})

describe('findPendingQuestion — two knowledge-gap cards (TAC-394)', () => {
  // A guest can hold a gap card in each slot (migration 041). Without ORDER BY
  // Postgres may return either, so the rendered question could change from one
  // turn to the next. The behavioural half (oldest card wins against a
  // newest-first table) is in two-pending-slots.test.ts, which runs this query
  // against an in-memory table.
  it('orders by created_at ascending, BEFORE limiting to one row', async () => {
    await findPendingQuestion(VENUE, GUEST)
    expect(cardChainCalls).toEqual([
      ['order', 'created_at', { ascending: true }],
      ['limit', 1],
    ])
  })
})

// TAC-484. `mode` had NO assertion anywhere in the repo before this block,
// which is how it came to assert something false without anything noticing.
//
// It used to be `pending_until !== null ? 'outstanding' : 'acknowledged'` — a
// proxy for "has a holding message gone out", because the timer's CAS claim
// cleared the column as it sent one. Commit 3 stopped a backstop catch arming
// the clock at all, so that column went null-from-birth on those cards and the
// proxy inverted: the block told the model "the guest has already been told the
// venue is looking into it" on a card where nothing had been sent.
//
// These pin the derivation by its INPUTS rather than by the rendered text, so
// they fail if anyone reintroduces a conditional here, whatever it renders.
describe('findPendingQuestion — mode no longer keys on the clock (TAC-484)', () => {
  function cardWith(pendingUntil: string | null, reviewReason: string) {
    cardMaybeSingle.mockResolvedValue({
      data: {
        id: 'card-1',
        reply_to_message_id: 'inbound-1',
        pending_until: pendingUntil,
        review_reason: reviewReason,
      },
      error: null,
    })
    inboundMaybeSingle.mockResolvedValue({
      data: {
        id: 'inbound-1',
        body: 'what grade is the matcha?',
        created_at: '2026-09-18T15:40:00Z',
        provider_message_id: 'p1',
      },
      error: null,
    })
  }

  // The regression this ticket introduced and then closed. A backstop card on a
  // genuine question: clock null, because it can never arm one now.
  it("a backstop card with no clock is 'outstanding', never 'acknowledged'", async () => {
    cardWith(null, 'knowledge_gap_backstop')
    const loaded = await findPendingQuestion(VENUE, GUEST)
    expect(loaded?.question.mode).toBe('outstanding')
  })

  // The other half: the same answer whatever the column says. Without this, a
  // conditional keyed the other way round would pass the test above.
  it("a self-reported card WITH a running clock is also 'outstanding'", async () => {
    cardWith('2026-09-18T15:46:00Z', 'knowledge_gap')
    const loaded = await findPendingQuestion(VENUE, GUEST)
    expect(loaded?.question.mode).toBe('outstanding')
  })

  it('never emits the retired acknowledged mode, on either clock state', async () => {
    for (const clock of [null, '2026-09-18T15:46:00Z']) {
      cardWith(clock, 'knowledge_gap')
      const loaded = await findPendingQuestion(VENUE, GUEST)
      expect(loaded?.question.mode).not.toBe('acknowledged')
    }
  })
})
