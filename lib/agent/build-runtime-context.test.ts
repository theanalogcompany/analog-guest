import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// buildRuntimeContext has no behavioural harness: every orchestrator test mocks
// it, and running it for real needs a database. That left TAC-380's brake input
// unguarded at its one call site. resolveInboundHistoryFrom has its own tests in
// intentions/derive.test.ts, but those prove nothing if this file stops calling
// it or passes the wrong caps.
//
// Source-level, the same technique as lib/ui/token-bridge.test.ts and TAC-366's
// filterByRelevance import check. It catches a removed or rewired call. It does
// not catch a wrong value that still matches these shapes.
describe('buildRuntimeContext: brake history horizon (TAC-380)', () => {
  const src = readFileSync(join(__dirname, 'build-runtime-context.ts'), 'utf-8')
  const callStart = src.indexOf('resolveInboundHistoryFrom({')
  const call = src.slice(callStart, src.indexOf('})', callStart))

  it('derives inboundHistoryFrom through resolveInboundHistoryFrom', () => {
    expect(src).toMatch(/const inboundHistoryFrom = resolveInboundHistoryFrom\(\{/)
  })

  it('passes the caps and cutoff the history query itself uses', () => {
    expect(call).toContain('recentMessages,')
    expect(call).toContain('responseCap: MAX_HISTORY_MESSAGES,')
    expect(call).toContain('rowsFetched: messagesResult.data?.length ?? 0,')
    expect(call).toContain('rowCap: MAX_HISTORY_MESSAGES * MAX_BUBBLES_PER_RESPONSE,')
    expect(call).toContain('historyCutoff: new Date(historyCutoffIso),')
    // And the history query really is bounded by that row cap and cutoff.
    expect(src).toContain('.limit(MAX_HISTORY_MESSAGES * MAX_BUBBLES_PER_RESPONSE)')
    expect(src).toContain(".gte('created_at', historyCutoffIso)")
  })

  it('hands the result to the derivation', () => {
    expect(src).toMatch(/deriveOpenIntentions\(\{[\s\S]*?\n\s+inboundHistoryFrom,\n/)
  })
})

// did_they_like_it arms off the NEWEST askable order, read from the visit-history
// rows. Same reason as above for testing at the source: nothing runs this file
// for real.
describe('buildRuntimeContext: recorded-order arming input (TAC-380)', () => {
  const src = readFileSync(join(__dirname, 'build-runtime-context.ts'), 'utf-8')

  // Parsed visits, not raw rows: the model can only ask how an order went when
  // the order appears in ## Visit history, which is built from recentVisits.
  it('derives recordedOrderTimes from the parsed visit history and hands them to the derivation', () => {
    expect(src).toMatch(/const recordedOrderTimes = recentVisits\.map\(\(v\) => v\.visitedAt\)/)
    expect(src).toMatch(/deriveOpenIntentions\(\{[\s\S]*?\n\s+recordedOrderTimes,\n/)
  })

  // The cap keeps the newest orders only while the query sorts newest first.
  // Sorted oldest first it would keep the oldest 20, and a regular's newest
  // order would never arm anything.
  it('loads visit history newest first', () => {
    const query = src.slice(src.indexOf(".from('transactions')"))
    expect(query.slice(0, query.indexOf('.limit('))).toContain(".order('occurred_at', { ascending: false })")
  })

  // The hold reads recommendation updated_at, which a TAC-318 dedup bumps. The
  // block is pinned whole: without the type filter a comp's updates would hold
  // the intention, and without the .ok guard it would read a failed result.
  it('hands recommendation updated_at to the derivation for the mid-conversation hold', () => {
    const start = src.indexOf('const openRecommendationTouchedTimes =')
    expect(start).toBeGreaterThan(-1)
    const block = src.slice(start, src.indexOf('\n\n', start))
    expect(block).toContain('(activeCommitmentsResult.ok ? activeCommitmentsResult.data : [])')
    expect(block).toContain(".filter((row) => row.type === 'recommendation')")
    expect(block).toContain('.map((row) => new Date(row.updated_at))')
    expect(src).toMatch(/deriveOpenIntentions\(\{[\s\S]*?\n\s+openRecommendationTouchedTimes,\n/)
  })

  // Fail closed, as the read at build-runtime-context.ts:203 does: a failed commitments
  // read holds the intention rather than silently lifting the hold.
  it('tells the derivation when the open recommendations could not be read', () => {
    expect(src).toMatch(
      /deriveOpenIntentions\(\{[\s\S]*?\n\s+openRecommendationsUnreadable: !activeCommitmentsResult\.ok,\n/,
    )
  })
})
