import { describe, expect, it } from 'vitest'

import {
  buildContextQuery,
  CONTEXT_TURNS,
  contextTurns,
  KNOWLEDGE_MERGE_RULE,
  MAX_CONTEXT_BODY_CHARS,
  mergeKnowledgeMatches,
  reachedGuest,
} from './retrieval-context'
import type { KnowledgeMatch, RuntimeContext } from './types'
import type { MessageDelivery, RecentMessage } from '@/lib/ai/types'

const NOW = new Date('2026-09-28T12:00:00Z')
const WINDOW_MS = 48 * 60 * 60 * 1000

function msg(
  direction: 'inbound' | 'outbound',
  body: string,
  opts: { delivery?: MessageDelivery; minutesAgo?: number } = {},
): RecentMessage {
  return {
    direction,
    body,
    delivery: opts.delivery ?? 'delivered',
    createdAt: new Date(NOW.getTime() - (opts.minutesAgo ?? 5) * 60_000),
  }
}

function ctxWith(
  recentMessages: RecentMessage[],
  current: string | null = 'how should i brew it',
  windowMs = WINDOW_MS,
): RuntimeContext {
  return {
    currentMessage: current === null ? null : { body: current, receivedAt: NOW },
    recentMessages,
    conversationWindowMs: windowMs,
    recognition: { computedAt: NOW },
  } as unknown as RuntimeContext
}

function match(id: string, similarity: number, corpusId = `corpus-${id}`): KnowledgeMatch {
  return {
    id,
    knowledgeCorpusId: corpusId,
    text: `text ${id}`,
    sourceType: 'manual_entry',
    confidence: 0.9,
    similarity,
    primaryTags: [],
    secondaryTags: [],
  }
}

const MERGE = { rule: 'interleave' as const, limit: 4, floor: 0.3 }

describe('reachedGuest — only what the guest actually read steers the search', () => {
  it('counts an inbound whatever its delivery value', () => {
    expect(reachedGuest(msg('inbound', 'hi', { delivery: 'never_sent' }))).toBe(true)
  })

  it.each([
    ['delivered', true],
    ['awaiting_review', false],
    ['skipped_by_operator', false],
    ['answered_outside_app', false],
    ['never_sent', false],
  ] as const)('outbound %s -> %s', (delivery, expected) => {
    expect(reachedGuest(msg('outbound', 'reply', { delivery }))).toBe(expected)
  })
})

describe('buildContextQuery', () => {
  it('puts the prior turns first and the current message LAST', () => {
    const q = buildContextQuery(
      ctxWith([msg('inbound', 'does the bhadra taste good'), msg('outbound', 'strongest we make')]),
    )
    expect(q).toBe('does the bhadra taste good\nstrongest we make\nhow should i brew it')
  })

  it('takes the LAST turns, not the first', () => {
    const q = buildContextQuery(
      ctxWith([
        msg('inbound', 'oldest', { minutesAgo: 40 }),
        msg('outbound', 'older', { minutesAgo: 30 }),
        msg('inbound', 'newer', { minutesAgo: 20 }),
        msg('outbound', 'newest', { minutesAgo: 10 }),
      ]),
    )
    expect(q).toBe('newer\nnewest\nhow should i brew it')
  })

  // The no-prior-turn guarantee. '' is the caller's signal to run ONE arm,
  // which is what makes a first message byte-identical to pre-TAC-547.
  it('returns empty when there is no prior turn at all', () => {
    expect(buildContextQuery(ctxWith([]))).toBe('')
  })

  it('returns empty when every prior turn is outside the conversation window', () => {
    const stale = msg('inbound', 'nine days ago', { minutesAgo: 9 * 24 * 60 })
    expect(buildContextQuery(ctxWith([stale]))).toBe('')
  })

  it('returns empty when the only prior turn never reached the guest', () => {
    expect(buildContextQuery(ctxWith([msg('outbound', 'held', { delivery: 'awaiting_review' })]))).toBe('')
  })

  it('returns empty when there is no current message', () => {
    expect(buildContextQuery(ctxWith([msg('inbound', 'something')], null))).toBe('')
  })

  it('drops an unsent draft but keeps a delivered turn behind it', () => {
    const q = buildContextQuery(
      ctxWith([
        msg('inbound', 'does the bhadra taste good', { minutesAgo: 20 }),
        msg('outbound', 'strongest we make', { minutesAgo: 15 }),
        msg('outbound', 'HELD DRAFT ABOUT SOMETHING ELSE', { delivery: 'awaiting_review' }),
      ]),
    )
    expect(q).toContain('strongest we make')
    expect(q).not.toContain('HELD DRAFT')
  })

  it('keeps a turn exactly at the window edge and drops one past it', () => {
    const edge = new Date(NOW.getTime() - WINDOW_MS)
    const past = new Date(NOW.getTime() - WINDOW_MS - 1000)
    expect(contextTurns(ctxWith([{ ...msg('inbound', 'edge'), createdAt: edge }]))).toHaveLength(1)
    expect(contextTurns(ctxWith([{ ...msg('inbound', 'past'), createdAt: past }]))).toHaveLength(0)
  })

  // Kills a window hardcoded to 48h, and a window zeroed at the construction
  // site: both leave every other test green. The whole reason
  // conversationWindowMs is hoisted onto the context is that ONE definition of
  // "the same conversation" is shared with the intention brake, and that is
  // worth nothing if no test can tell the field from a constant.
  it('READS the venue window rather than assuming 48h', () => {
    const twoHours = 2 * 60 * 60 * 1000
    const threeHoursAgo = msg('inbound', 'older than a 2h window', { minutesAgo: 180 })
    expect(buildContextQuery(ctxWith([threeHoursAgo]))).not.toBe('')
    expect(buildContextQuery(ctxWith([threeHoursAgo], 'how should i brew it', twoHours))).toBe('')
  })

  it('treats a zero window as admitting nothing, not everything', () => {
    expect(buildContextQuery(ctxWith([msg('inbound', 'a minute ago')], 'q', 0))).toBe('')
  })

  // Kills measuring staleness from wall-clock now rather than from the message
  // being answered. Identical in production; it is what keeps the Voices regen
  // path alive, where history is pinned to a past turn but computedAt is today.
  it('measures the window from the CURRENT MESSAGE, not from computedAt', () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000)
    const replay = {
      currentMessage: { body: 'how should i brew it', receivedAt: tenDaysAgo },
      recentMessages: [{ ...msg('inbound', 'the turn before it'), createdAt: new Date(tenDaysAgo.getTime() - 60_000) }],
      conversationWindowMs: WINDOW_MS,
      // Stamped today, as buildRuntimeContext does on every replay.
      recognition: { computedAt: NOW },
    } as unknown as RuntimeContext
    expect(buildContextQuery(replay)).toBe('the turn before it\nhow should i brew it')
  })

  it('truncates a long body to the history bound', () => {
    const long = 'x'.repeat(MAX_CONTEXT_BODY_CHARS + 50)
    const q = buildContextQuery(ctxWith([msg('inbound', long)]))
    expect(q.split('\n')[0]).toHaveLength(MAX_CONTEXT_BODY_CHARS)
  })

  it('collapses newlines so one turn stays one line', () => {
    const q = buildContextQuery(ctxWith([msg('inbound', 'line one\n  line two')]))
    expect(q.split('\n')).toEqual(['line one line two', 'how should i brew it'])
  })

  it('skips a blank-bodied history row rather than emitting an empty line', () => {
    const q = buildContextQuery(
      ctxWith([msg('inbound', 'real question', { minutesAgo: 20 }), msg('outbound', '   ')]),
    )
    expect(q).toBe('real question\nhow should i brew it')
  })

  it('honours the window parameter, so the measurement arms differ', () => {
    const ctx = ctxWith([
      msg('inbound', 'prev guest', { minutesAgo: 20 }),
      msg('outbound', 'agent reply', { minutesAgo: 10 }),
    ])
    expect(buildContextQuery(ctx, 1)).toBe('agent reply\nhow should i brew it')
    expect(buildContextQuery(ctx, 2)).toBe('prev guest\nagent reply\nhow should i brew it')
  })

  // Pinned by VALUE, like KNOWLEDGE_MERGE_RULE two lines from it in the
  // source: 2 is the measured choice (13/15 at window 1, 15/15 at 2), and
  // without this the constant can move and only a test named for something
  // else notices.
  it('uses a window of 2, the measured value', () => {
    expect(CONTEXT_TURNS).toBe(2)
  })

  it('defaults to CONTEXT_TURNS', () => {
    const ctx = ctxWith([
      msg('inbound', 'a', { minutesAgo: 30 }),
      msg('outbound', 'b', { minutesAgo: 20 }),
      msg('inbound', 'c', { minutesAgo: 10 }),
    ])
    expect(buildContextQuery(ctx)).toBe(buildContextQuery(ctx, CONTEXT_TURNS))
  })
})

describe('mergeKnowledgeMatches', () => {
  it('dedupes by CHUNK id, not corpus id, so two chunks of one entry both survive', () => {
    // The TAC-500 trap: `id` is the knowledge_embeddings row, and one corpus
    // entry can legitimately return several. Collapsing by corpus id drops a
    // chunk's TEXT, which is a regression against the control.
    const a = [match('chunk-1', 0.9, 'same-entry'), match('chunk-2', 0.8, 'same-entry')]
    const out = mergeKnowledgeMatches([a, []], MERGE)
    expect(out.map((r) => r.id)).toEqual(['chunk-1', 'chunk-2'])
    // Both chunks, one entry. Collapsing by corpus id would return one row
    // and silently lose the other chunk's text.
    expect(out).toHaveLength(2)
    expect(new Set(out.map((r) => r.knowledgeCorpusId))).toEqual(new Set(['same-entry']))
  })

  it('keeps the BEST score for an entry seen in both arms', () => {
    const out = mergeKnowledgeMatches([[match('x', 0.4)], [match('x', 0.85)]], MERGE)
    expect(out).toHaveLength(1)
    expect(out[0].similarity).toBe(0.85)
  })

  it('keeps the best score whichever arm carried it', () => {
    const out = mergeKnowledgeMatches([[match('x', 0.85)], [match('x', 0.4)]], MERGE)
    expect(out[0].similarity).toBe(0.85)
  })

  // The structural half of the no-lost-result claim.
  it('interleave ALWAYS keeps the control arm top two, however high the other arm scores', () => {
    const control = [match('a0', 0.40), match('a1', 0.39), match('a2', 0.38), match('a3', 0.37)]
    const contextual = [match('b0', 0.99), match('b1', 0.98), match('b2', 0.97), match('b3', 0.96)]
    const out = mergeKnowledgeMatches([control, contextual], MERGE)
    expect(out.map((r) => r.id)).toEqual(['a0', 'b0', 'a1', 'b1'])
  })

  it('best-score does NOT keep them — the rule TAC-547 measured and rejected', () => {
    const control = [match('a0', 0.40), match('a1', 0.39)]
    const contextual = [match('b0', 0.99), match('b1', 0.98), match('b2', 0.97), match('b3', 0.96)]
    const out = mergeKnowledgeMatches([control, contextual], { ...MERGE, rule: 'best-score' })
    expect(out.map((r) => r.id)).toEqual(['b0', 'b1', 'b2', 'b3'])
  })

  it('applies the top-k AFTER the merge, not per arm', () => {
    const a = [match('a0', 0.9), match('a1', 0.8)]
    const b = [match('b0', 0.7), match('b1', 0.6)]
    expect(mergeKnowledgeMatches([a, b], MERGE)).toHaveLength(4)
    expect(mergeKnowledgeMatches([a, b], { ...MERGE, limit: 2 }).map((r) => r.id)).toEqual(['a0', 'b0'])
  })

  it('applies the floor AFTER the merge', () => {
    // Deliberately fed RAW rows. Through retrieveKnowledgeStage both arms
    // arrive pre-filtered and this can change nothing — see the note on
    // mergeKnowledgeMatches. It guards a caller passing unfiltered rows.
    const out = mergeKnowledgeMatches([[match('keep', 0.5), match('drop', 0.1)], []], MERGE)
    expect(out.map((r) => r.id)).toEqual(['keep'])
  })

  it('does not let a sub-floor row in one arm suppress its above-floor score in the other', () => {
    const out = mergeKnowledgeMatches([[match('x', 0.1)], [match('x', 0.55)]], MERGE)
    expect(out.map((r) => r.id)).toEqual(['x'])
  })

  it('is a no-op on a single arm, which is what the no-prior-turn path relies on', () => {
    const only = [match('a', 0.9), match('b', 0.8)]
    expect(mergeKnowledgeMatches([only, []], MERGE).map((r) => r.id)).toEqual(['a', 'b'])
  })

  // Four in one arm, none in the other: the only shape that separates a
  // post-merge top-k from a per-arm slice of limit/2, and the degradation
  // guarantee in its own right — an empty contextual arm must leave the
  // control's FULL slate standing, not half of it.
  it('keeps the whole control slate when the contextual arm is empty', () => {
    const control = [match('a0', 0.9), match('a1', 0.8), match('a2', 0.7), match('a3', 0.6)]
    const out = mergeKnowledgeMatches([control, []], MERGE)
    expect(out.map((r) => r.id)).toEqual(['a0', 'a1', 'a2', 'a3'])
  })


  it('handles arms of different lengths without emitting holes', () => {
    const out = mergeKnowledgeMatches([[match('a0', 0.9)], [match('b0', 0.8), match('b1', 0.7)]], MERGE)
    expect(out.map((r) => r.id)).toEqual(['a0', 'b0', 'b1'])
  })

  it('ships interleave', () => {
    expect(KNOWLEDGE_MERGE_RULE).toBe('interleave')
  })

  // The top-two guarantee holds only while there are at least three slots.
  // KNOWLEDGE_RETRIEVE_LIMIT is an editable tunable, so the condition is
  // pinned rather than left implied by the prose.
  it('loses the control arm A1 at limit 2, which is why the guarantee names limit >= 3', () => {
    const control = [match('a0', 0.4), match('a1', 0.39)]
    const contextual = [match('b0', 0.99)]
    expect(
      mergeKnowledgeMatches([control, contextual], { ...MERGE, limit: 2 }).map((r) => r.id),
    ).toEqual(['a0', 'b0'])
    expect(
      mergeKnowledgeMatches([control, contextual], { ...MERGE, limit: 3 }).map((r) => r.id),
    ).toEqual(['a0', 'b0', 'a1'])
  })
})
