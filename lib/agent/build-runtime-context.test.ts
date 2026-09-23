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

// TAC-394: nothing runs buildRuntimeContext for real under test, and a
// Supabase mock ignores its select() argument, so the history query's columns
// are pinned at the source. Dropping one would make every row read as its
// defaults in deriveDelivery with no test failing anywhere else.
describe('buildRuntimeContext: history delivery (TAC-394)', () => {
  const src = readFileSync(join(__dirname, 'build-runtime-context.ts'), 'utf-8')
  const query = src.slice(
    src.indexOf('let messagesQuery = supabase'),
    src.indexOf('const visitHistoryCutoffIso', src.indexOf('let messagesQuery = supabase')),
  )

  it('selects the columns deriveDelivery reads', () => {
    expect(query.length).toBeGreaterThan(0)
    for (const column of ['status', 'review_state']) {
      expect(query).toMatch(new RegExp(`\\.select\\('[^']*\\b${column}\\b`))
    }
  })

  // Excluding unsent rows was considered and ruled out: a pending comp the
  // model cannot see is one it offers again (TAC-398).
  it('does not filter the history query on delivery', () => {
    expect(query).toContain('historyEndIso')
    expect(query).not.toMatch(/\.(eq|neq|in|not|is|filter|or|match)\([^)]*\b(status|review_state)\b/)
  })

  // A filter on the rows before grouping, or chained after it, is the same
  // exclusion by another route, and the query-side assertion above cannot see
  // either. So the grouping statement is pinned whole: its argument is the raw
  // query result, nothing is chained after the call, and the raw rows reach no
  // other code that could drop some first. A first version matched only the
  // literal `recentMessages.filter(` and passed both of those mutants.
  it('groups the raw history rows and returns them without filtering', () => {
    expect(src).toContain(
      '  const recentMessages: RecentMessage[] = groupIntoResponses(\n' +
        '    messagesResult.data ?? [],\n' +
        '    MAX_HISTORY_MESSAGES,\n' +
        '  )\n\n',
    )
    // The call above, and the rowsFetched count in the trace span.
    expect([...src.matchAll(/messagesResult\.data\b/g)]).toHaveLength(2)
    const filters = [...src.matchAll(/recentMessages\.filter\(/g)]
    expect(filters).toHaveLength(1)
    // The one allowed filter reads inbound timestamps for the intention brake.
    expect(src.slice(filters[0]!.index!, filters[0]!.index! + 80)).toContain("m.direction === 'inbound'")
    const returned = src.slice(src.indexOf('  return {\n    agentRunId: input.agentRunId,'))
    expect(returned.length).toBeGreaterThan(0)
    expect(returned).toMatch(/\n\s+recentMessages,\n/)
  })
})

// TAC-436 ruling 3: how "a visit is confirmed" is resolved. Source-level for the
// same reason as the block above — nothing runs buildRuntimeContext for real —
// and the last assertion is the audit's own finding pinned as a guard.
describe('buildRuntimeContext: visit_confirmed resolution (TAC-436)', () => {
  const src = readFileSync(join(__dirname, 'build-runtime-context.ts'), 'utf-8')
  const blockStart = src.indexOf('const confirmedVisitTimes = [')
  const block = src.slice(blockStart, src.indexOf(']', blockStart))

  it('resolves it from QR enrollment and the earliest acknowledged arrival', () => {
    expect(src).toContain('findEarliestAcknowledgedArrival({')
    expect(block).toContain("guest.createdVia === 'qr_scan' ? guest.createdAt : null")
    expect(block).toContain('acknowledgedArrivalResult.ok ? acknowledgedArrivalResult.data : null')
  })

  it('takes the EARLIEST of the confirmed visits', () => {
    // Math.max would renew the ask on every later visit, for an intention that
    // deliberately never re-arms.
    expect(src).toMatch(/new Date\(Math\.min\(\.\.\.confirmedVisitTimes\.map\(/)
  })

  it('hands it to the derivation', () => {
    expect(src).toMatch(/deriveOpenIntentions\(\{[\s\S]*?\n\s+visitConfirmedAt,\n/)
  })

  // THE FINDING, AS A GUARD. guests.last_visit_at reads like the obvious source
  // for "a visit is confirmed" and is inert: all three of its writers run
  // downstream of a transaction row, and a transaction SATISFIES
  // understand_order, so arming on it would close the intention in the same
  // breath it opened it. Anyone widening this resolution reaches for it first.
  //
  // BOTH SPELLINGS. The column is last_visit_at and the loaded field is
  // lastVisitAt; a guard written against one only is the source-level trap
  // CLAUDE.md logs, and a mutant using the camelCase field walked straight past
  // the first version of this test.
  it('does NOT resolve a confirmed visit from last_visit_at', () => {
    const lastVisit = /last_?[Vv]isit/
    expect(block).not.toMatch(lastVisit)
    const call = src.slice(
      src.indexOf('findEarliestAcknowledgedArrival({'),
      src.indexOf('const confirmedVisitTimes'),
    )
    expect(call).not.toMatch(lastVisit)
  })
})

// TAC-518: a scan on THIS TURN is a confirmed visit. Source-level for the same
// reason as the block above — nothing runs buildRuntimeContext for real — and
// the behavioural half is already covered: derive.test.ts proves what arming
// does with a given visitConfirmedAt, so what is untested without these is
// only whether this file computes the right one.
describe('buildRuntimeContext: a scan on this turn confirms a visit (TAC-518)', () => {
  const src = readFileSync(join(__dirname, 'build-runtime-context.ts'), 'utf-8')
  const resolution = src.slice(
    src.indexOf('const earliestConfirmedVisit ='),
    src.indexOf('// Arms got_the_recommendation'),
  )

  it('reads the turn scan through the shared predicate', () => {
    expect(resolution).toContain('isScanReferral(input.currentMessage?.referralSource)')
  })

  // The anchor is the row's own receipt time. `now` would move it later on a
  // retried or delayed webhook, and the guest was at the counter when the
  // message arrived, not when we got round to it.
  it('anchors on the message receipt time, not now', () => {
    expect(resolution).toContain('input.currentMessage?.receivedAt')
    expect(resolution).not.toMatch(/scanAt\s*=\s*[^\n]*\bnew Date\(\)/)
  })

  // The whole point is a LATER anchor than the historical sources, so the scan
  // must not be reduced with them. Joining confirmedVisitTimes would put it
  // through Math.min and a returning scanner would keep their old, expired
  // anchor — the defect this ticket exists to fix, reintroduced silently.
  it('overrides the earliest-wins reduction rather than joining it', () => {
    expect(resolution).toContain('const visitConfirmedAt = scanAt ?? earliestConfirmedVisit')
    const list = src.slice(src.indexOf('const confirmedVisitTimes = ['), src.indexOf('const earliestConfirmedVisit'))
    expect(list).not.toContain('referralSource')
    expect(list).not.toContain('scanAt')
  })

  // TAC-436's rule for the two historical sources is untouched. A mutant that
  // "simplifies" by making the scan just another candidate passes the test
  // above only if this one still holds too.
  it('leaves the historical earliest-wins reduction intact', () => {
    expect(src).toMatch(/new Date\(Math\.min\(\.\.\.confirmedVisitTimes\.map\(/)
  })
})

// TAC-495: the conversation's channel, which picks the prompt copy. Source-level
// for the same reason as the blocks above. The rule itself is tested in
// conversation-channel.test.ts; these check this file feeds it the right
// inputs and returns its answer, which no behavioural test can reach.
describe('buildRuntimeContext: conversation channel (TAC-495)', () => {
  const src = readFileSync(join(__dirname, 'build-runtime-context.ts'), 'utf-8')
  const callStart = src.indexOf('resolveConversationChannel({')
  const call = src.slice(callStart, src.indexOf('})', callStart))

  // Without the column, every guest would read as having no Instagram ID and
  // an Instagram guest with no inbound message would resolve as unknown.
  it('selects instagram_scoped_id with the guest', () => {
    const guestQuery = src.slice(src.indexOf(".from('guests')"))
    expect(guestQuery.slice(0, guestQuery.indexOf('.eq('))).toMatch(/\binstagram_scoped_id\b/)
  })

  it('resolves from the inbound message and the guest identifiers', () => {
    expect(callStart).toBeGreaterThan(-1)
    // A message whose channel is missing resolves as unparseable (null),
    // never as "no inbound message" (undefined).
    expect(src).toContain(
      'const inboundChannel = input.currentMessage ? (input.currentMessage.channel ?? null) : undefined',
    )
    expect(call).toContain('inboundChannel,')
    expect(call).toContain('hasPhone,')
    expect(call).toContain('hasInstagramId,')
    // typeof, never `!== null`: an undefined (a column dropped from the
    // select) must read as absent, not as a phone number.
    expect(src).toContain("const hasPhone = typeof guestRow.phone_number === 'string'")
    expect(src).toContain("const hasInstagramId = typeof guestRow.instagram_scoped_id === 'string'")
  })

  it('returns the resolved channel on the context', () => {
    expect(src).toContain('conversationChannel: channelResolution.channel,')
  })

  // An Instagram-only venue has no messaging number, and Le Mil's becomes one
  // when its number is deleted. The precondition must use the channel, so the
  // channel has to be resolved before it runs.
  it('requires the venue messaging number only when the channel needs it, after resolving the channel', () => {
    expect(src).toContain(
      'if (!venueRow.messaging_phone_number && venueMessagingNumberRequired(channelResolution.channel)) {',
    )
    expect(src.indexOf('resolveConversationChannel({')).toBeLessThan(
      src.indexOf('venueMessagingNumberRequired(channelResolution.channel)'),
    )
    // No other check on the number may remain that would throw regardless.
    expect(src.match(/!venueRow\.messaging_phone_number\b/g)).toHaveLength(1)
  })

  // The Instagram ID is only tested for presence. It must not ride on the
  // context, a log line or anything else, where it would reach prompts, traces
  // and Vercel logs. So the column is named twice in this file (the select and
  // the presence check) and read once, whatever a leak would be spelled.
  it('keeps the Instagram ID itself out of the context and the logs', () => {
    expect(src).not.toMatch(/instagramScopedId\s*:/)
    expect(src.match(/guestRow\.instagram_scoped_id\b/g)).toHaveLength(1)
    expect(src.match(/\binstagram_scoped_id\b/g)).toHaveLength(2)
    expect(src).toContain("const hasInstagramId = typeof guestRow.instagram_scoped_id === 'string'")
  })

  // The warning is the only place an unresolved channel shows up, and its main
  // cause is migration 048's 'text' default on an Instagram row.
  it('warns, with the reason, whenever the channel is unresolved', () => {
    const start = src.indexOf('if (channelResolution.channel === null) {\n    console.warn(')
    expect(start).toBeGreaterThan(-1)
    const warn = src.slice(start, src.indexOf('})', start))
    expect(warn).toContain('conversation channel unresolved')
    expect(warn).toContain('reason: channelResolution.unresolvedReason,')
    // Not the row itself, which would log the Instagram ID and the phone
    // number without naming either column.
    expect(warn).not.toMatch(/\bguestRow\b(?!\.)/)
    expect(warn).not.toMatch(/\bguestRow\./)
    // And not under any other name or shape either: every line of the call is
    // pinned, so a new key, a quoted key, a spread (...guestResult.data logs
    // the whole row) or an extra argument before the object fails here.
    const call = warn.slice(warn.indexOf('console.warn('))
    const lines = call
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    expect(lines).toEqual([
      "console.warn('[agent] buildRuntimeContext: conversation channel unresolved, using the copy that asserts no phone number', {",
      'agentRunId: input.agentRunId,',
      'venueId: input.venueId,',
      'guestId: input.guestId,',
      'inboundMessageId: input.currentMessage?.id ?? null,',
      'inboundChannel,',
      'hasPhone,',
      'hasInstagramId,',
      'reason: channelResolution.unresolvedReason,',
    ])
  })

  // TAC-469 pre-flight: the warning alone was a log line nobody watches. Now
  // that sends route on the channel, an unresolved one is a reply that can't be
  // routed, so it relays to Slack. Pinned line by line like the warning, for
  // the same reason: the guest row must never ride along.
  it('raises the Slack-relayed event, with the same fields as the warning, whenever the channel is unresolved', () => {
    const block = src.slice(
      src.indexOf('if (channelResolution.channel === null) {\n    console.warn('),
      src.indexOf('// TAC-495: a venue\'s messaging phone number is required'),
    )
    const start = block.indexOf('await captureConversationChannelUnresolved({')
    expect(start).toBeGreaterThan(-1)
    const lines = block
      .slice(start, block.indexOf('})', start))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    expect(lines).toEqual([
      'await captureConversationChannelUnresolved({',
      'agentRunId: input.agentRunId,',
      'venueId: input.venueId,',
      'guestId: input.guestId,',
      'inboundMessageId: input.currentMessage?.id ?? null,',
      'inboundChannel,',
      'hasPhone,',
      'hasInstagramId,',
      'reason: channelResolution.unresolvedReason ?? null,',
    ])
  })

  // TAC-469: a guest with both identifiers follows the channel they last
  // messaged on. Read only when there is no inbound message and the guest has
  // both, so no other run pays for the query.
  it('reads the last inbound channel only for a guest with both identifiers and no inbound message', () => {
    expect(src).toContain(
      'inboundChannel === undefined && hasPhone && hasInstagramId\n      ? await loadLastInboundChannel(input.venueId, input.guestId, supabase)\n      : undefined',
    )
    expect(call).toContain('lastInboundChannel,')
  })

  // A number-less venue with an unresolvable conversation must not blame the
  // number alone.
  it('names an unresolved channel in the missing-number error', () => {
    expect(src).toContain(
      "? ` (and this conversation's channel is unresolved: ${channelResolution.unresolvedReason})`",
    )
  })
})
