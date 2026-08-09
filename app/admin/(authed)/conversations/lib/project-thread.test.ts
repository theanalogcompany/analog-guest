import { describe, expect, it } from 'vitest'
import {
  type ConversationMessageRow,
  deriveResponseState,
  projectThread,
  wasDispatched,
} from './project-thread'

// TAC-316 fixture set per the ticket's Testing section: delivered rows, a
// pending_review/skipped row, a blank-body row, and a two-row split — the
// assertions run against the real projection (the layer whose behavior caused
// the ticket), nothing mocked.

let seq = 0
function row(overrides: Partial<ConversationMessageRow> = {}): ConversationMessageRow {
  seq += 1
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    body: `message ${seq}`,
    direction: 'outbound',
    created_at: new Date(Date.UTC(2026, 7, 9, 0, 0, seq)).toISOString(),
    langfuse_trace_id: null,
    reply_to_message_id: null,
    provider_message_id: null,
    category: null,
    response_review: null,
    status: 'sent',
    review_state: 'auto_sent',
    review_reason: null,
    generation_id: null,
    reaction_type: null,
    media_urls: [],
    ...overrides,
  }
}

describe('projectThread', () => {
  it('renders every row: delivered, skipped draft, blank card, and split all survive projection', () => {
    const delivered1 = row({ direction: 'inbound', status: 'received', review_state: null })
    const delivered2 = row({ status: 'delivered' })
    // The cca03314 shape: superseded pending draft, never sent.
    const skipped = row({ status: 'pending_review', review_state: 'skipped' })
    // Blank-body knowledge-gap card.
    const blank = row({
      body: '',
      status: 'pending_review',
      review_state: 'pending',
      review_reason: 'knowledge_gap',
    })
    // Two-row split sharing a generation_id.
    const gen = 'aaaaaaaa-0000-0000-0000-000000000001'
    const splitA = row({ generation_id: gen, body: 'first bubble' })
    const splitB = row({ generation_id: gen, body: 'second bubble' })

    const out = projectThread([delivered1, delivered2, skipped, blank, splitA, splitB])

    // 6 rows → 5 responses (the split merges), none dropped.
    expect(out).toHaveLength(5)
    expect(out.map((r) => r.id)).toEqual([
      delivered1.id,
      delivered2.id,
      skipped.id,
      blank.id,
      splitA.id,
    ])
  })

  it('groups a two-row split into one response with both fragments, keyed on the first bubble', () => {
    const gen = 'aaaaaaaa-0000-0000-0000-000000000002'
    const a = row({ generation_id: gen, body: 'sound good?', langfuse_trace_id: 'trace-1' })
    const b = row({ generation_id: gen, body: 'see you at 8' })
    const out = projectThread([a, b])

    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(a.id)
    expect(out[0].bubbles.map((x) => x.body)).toEqual(['sound good?', 'see you at 8'])
    expect(out[0].body).toBe('sound good?\nsee you at 8')
    expect(out[0].createdAt).toEqual(new Date(a.created_at))
    expect(out[0].langfuseTraceId).toBe('trace-1')
  })

  it('grouping is keyed, not adjacent: an inbound between two bubbles does not break the group', () => {
    const gen = 'aaaaaaaa-0000-0000-0000-000000000003'
    const a = row({ generation_id: gen, body: 'bubble one' })
    const interleaved = row({ direction: 'inbound', status: 'received', review_state: null })
    const b = row({ generation_id: gen, body: 'bubble two' })

    const out = projectThread([a, interleaved, b])
    expect(out).toHaveLength(2)
    const split = out.find((r) => r.id === a.id)
    expect(split?.bubbles.map((x) => x.body)).toEqual(['bubble one', 'bubble two'])
    const inbound = out.find((r) => r.id === interleaved.id)
    expect(inbound?.direction).toBe('inbound')
  })

  it('is input-order independent (the sibling groupIntoResponses gotcha cannot recur here)', () => {
    const gen = 'aaaaaaaa-0000-0000-0000-000000000004'
    const rows = [
      row({ direction: 'inbound', status: 'received', review_state: null }),
      row({ generation_id: gen }),
      row({ generation_id: gen }),
      row(),
    ]
    const asc = projectThread(rows)
    const desc = projectThread([...rows].reverse())
    expect(desc).toEqual(asc)
    // Output is oldest-first regardless of input order.
    const times = asc.map((r) => r.createdAt.getTime())
    expect(times).toEqual([...times].sort((x, y) => x - y))
  })

  it('null generation_id rows are each their own response (legacy/inbound/single-bubble)', () => {
    const a = row()
    const b = row()
    const out = projectThread([a, b])
    expect(out).toHaveLength(2)
  })

  it('a blank-body single row keeps its (empty) bubble and empty joined body', () => {
    const blank = row({ body: '', review_state: 'pending', status: 'pending_review' })
    const out = projectThread([blank])
    expect(out).toHaveLength(1)
    expect(out[0].bubbles).toHaveLength(1)
    expect(out[0].bubbles[0].body).toBe('')
    expect(out[0].body).toBe('')
  })

  it('blank bodies get kind-specific placeholders: blank card, reaction, media', () => {
    const card = row({
      body: '',
      status: 'pending_review',
      review_state: 'pending',
      review_reason: 'knowledge_gap',
    })
    const reaction = row({
      body: '',
      direction: 'inbound',
      status: 'received',
      review_state: null,
      reaction_type: 'love',
    })
    const media = row({
      body: '',
      direction: 'inbound',
      status: 'received',
      review_state: null,
      media_urls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    })
    const normal = row()

    const out = projectThread([card, reaction, media, normal])
    const byId = new Map(out.map((r) => [r.id, r]))
    expect(byId.get(card.id)?.bubbles[0].placeholder).toBe('no draft — blank card (knowledge_gap)')
    expect(byId.get(reaction.id)?.bubbles[0].placeholder).toBe('reaction: love')
    expect(byId.get(media.id)?.bubbles[0].placeholder).toBe('media message (2 attachments)')
    expect(byId.get(normal.id)?.bubbles[0].placeholder).toBeNull()
  })

  it('carries review/state fields through as opaque values', () => {
    const weird = row({ status: 'quarantined', review_state: 'escalated', review_reason: 'x' })
    const out = projectThread([weird])
    expect(out[0].status).toBe('quarantined')
    expect(out[0].reviewState).toBe('escalated')
    expect(out[0].reviewReason).toBe('x')
  })
})

describe('deriveResponseState', () => {
  it('normal for dispatched rows: received/sending/sent/delivered with dispatched review states', () => {
    expect(deriveResponseState({ status: 'received', reviewState: null }).kind).toBe('normal')
    expect(deriveResponseState({ status: 'sent', reviewState: 'auto_sent' }).kind).toBe('normal')
    expect(deriveResponseState({ status: 'delivered', reviewState: 'approved' }).kind).toBe('normal')
    expect(deriveResponseState({ status: 'sent', reviewState: 'edited' }).kind).toBe('normal')
    // 'sending' is a real code-written status (Sendblue QUEUED via the status
    // webhook), and out-of-order callbacks can leave a delivered row there
    // permanently — it traveled, so it renders normal and counts in stats.
    expect(deriveResponseState({ status: 'sending', reviewState: 'auto_sent' }).kind).toBe('normal')
  })

  it('skipped drafts are never-sent — superseded', () => {
    expect(deriveResponseState({ status: 'pending_review', reviewState: 'skipped' })).toEqual({
      kind: 'annotated',
      label: 'never sent — superseded',
    })
  })

  it('pending drafts are pending review; a stranded dispatch is NOT mislabeled as pending', () => {
    expect(deriveResponseState({ status: 'pending_review', reviewState: 'pending' })).toEqual({
      kind: 'annotated',
      label: 'pending review',
    })
    // The v1 failure-recovery gap: operator approved, Sendblue dispatch threw,
    // row stranded at pending_review/approved. The queue no longer surfaces
    // it, so this viewer is the only place an operator can spot it — the
    // truthful literal beats a "pending review" label promising someone else
    // will handle it.
    expect(deriveResponseState({ status: 'pending_review', reviewState: 'approved' })).toEqual({
      kind: 'annotated',
      label: 'status=pending_review · review_state=approved',
    })
  })

  it('failed sends are labeled', () => {
    expect(deriveResponseState({ status: 'failed', reviewState: 'approved' })).toEqual({
      kind: 'annotated',
      label: 'failed to send',
    })
  })

  it('unknown values render as literal text instead of throwing or hiding the row', () => {
    expect(deriveResponseState({ status: 'quarantined', reviewState: null })).toEqual({
      kind: 'annotated',
      label: 'status=quarantined · review_state=null',
    })
    expect(deriveResponseState({ status: 'sent', reviewState: 'escalated' })).toEqual({
      kind: 'annotated',
      label: 'status=sent · review_state=escalated',
    })
  })
})

describe('wasDispatched', () => {
  it('true only for the normal dispatched path — the safe direction for stats is exclusion', () => {
    expect(wasDispatched({ status: 'delivered', reviewState: 'auto_sent' })).toBe(true)
    expect(wasDispatched({ status: 'received', reviewState: null })).toBe(true)
    expect(wasDispatched({ status: 'sending', reviewState: 'auto_sent' })).toBe(true)
    expect(wasDispatched({ status: 'pending_review', reviewState: 'skipped' })).toBe(false)
    expect(wasDispatched({ status: 'pending_review', reviewState: 'pending' })).toBe(false)
    expect(wasDispatched({ status: 'failed', reviewState: 'approved' })).toBe(false)
    // Unknown values count as not-dispatched: a response rate should never be
    // deflated or inflated by rows we can't classify.
    expect(wasDispatched({ status: 'quarantined', reviewState: null })).toBe(false)
  })
})
