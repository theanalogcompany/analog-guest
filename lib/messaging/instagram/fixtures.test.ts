// Real Instagram webhook deliveries, captured on 2026-09-17 (TAC-458), with
// identifiers and text replaced. fixtures/README.md says what was replaced and
// how. The assertions in the first block are the behavioural findings the
// fixtures exist to record: if Meta's payloads are ever re-captured and one of
// these stops holding, the handler that relies on it needs to change too.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { summarizeInstagramPayload } from './summarize-payload'

const FIXTURE_NAMES = ['message', 'echo', 'read'] as const
type FixtureName = (typeof FIXTURE_NAMES)[number]

function raw(name: FixtureName): string {
  return readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8')
}

type Item = Record<string, unknown> & {
  sender: { id: string }
  recipient: { id: string }
}

function firstItem(name: FixtureName): { entryId: string; item: Item } {
  const parsed = JSON.parse(raw(name)) as {
    entry: Array<{ id: string; messaging: Item[] }>
  }
  const entry = parsed.entry[0]
  const item = entry?.messaging[0]
  if (!entry || !item) throw new Error(`fixture ${name} has no messaging item`)
  return { entryId: entry.id, item }
}

/**
 * A mid's body, decoded to `['', account id, thread id, item id]`. After a
 * fixed 34-character header, the rest is base64 whose `==` padding Meta writes
 * as `ZDZD`. Anything else fails loudly rather than decoding short.
 */
function decodeMid(mid: string): string[] {
  if (!mid.endsWith('ZDZD')) throw new Error(`unexpected mid padding: ${mid.slice(-8)}`)
  return Buffer.from(`${mid.slice(34, -4)}==`, 'base64').toString('ascii').split(':')
}

describe('recorded Instagram payloads: what Meta sends', () => {
  // Staff replying by hand in the Instagram app produce an echo, so a handler
  // will see the venue's own outbound messages on the `messages` field.
  // Direction is marked explicitly, not left to be inferred. `is_echo` marks
  // the venue's side, not a person: replies the agent sends through the API
  // most likely arrive as echoes too (not yet captured), so it cannot tell
  // staff from the agent.
  it('marks a reply typed in the Instagram app as is_echo, with sender and recipient reversed', () => {
    const { entryId, item } = firstItem('echo')
    const message = item.message as Record<string, unknown>
    expect(message.is_echo).toBe(true)
    expect(item.sender.id).toBe(entryId)
    expect(item.recipient.id).not.toBe(entryId)
  })

  it('carries no is_echo on a guest message, which the venue receives', () => {
    const { entryId, item } = firstItem('message')
    expect(item.message).not.toHaveProperty('is_echo')
    expect(item.recipient.id).toBe(entryId)
    expect(item.sender.id).not.toBe(entryId)
  })

  // `messaging_seen` is the SUBSCRIPTION field name only. The payload key is
  // `read`, and it names one message: read state is per message, not per
  // thread. The one captured read points at the venue's echoed reply.
  it('delivers a read receipt under `read`, naming the one message that was read', () => {
    const { item } = firstItem('read')
    expect(item).toHaveProperty('read')
    expect(item).not.toHaveProperty('messaging_seen')
    const read = item.read as { mid: string }
    const echo = firstItem('echo').item.message as { mid: string }
    expect(read.mid).toBe(echo.mid)
  })

  // Identifier formats. The account id is 17 digits. Both guest IGSIDs seen
  // on 2026-09-17 (this one, and the postback's, not committed) were 16, so an
  // account id and a guest id are not the same length and a validator for one
  // must not be reused for the other. Two samples do not show that every
  // IGSID is 16 digits, so the guest id is pinned to digits only.
  it('uses digit-string ids, 17 digits for the account', () => {
    for (const name of FIXTURE_NAMES) {
      const { entryId, item } = firstItem(name)
      expect(entryId).toMatch(/^\d{17}$/)
      const guest = item.sender.id === entryId ? item.recipient.id : item.sender.id
      expect(guest).toMatch(/^\d+$/)
    }
  })

  // A mid is not an opaque random token: it encodes the account id, a thread
  // id shared by the whole conversation, and a per-message item id. That is
  // why the fixtures replace mids as well as the plain ids.
  it('encodes the account id and a per-conversation thread id inside every mid', () => {
    const message = firstItem('message')
    const echo = firstItem('echo')
    const [, msgAccount, msgThread, msgItem] = decodeMid((message.item.message as { mid: string }).mid)
    const [, echoAccount, echoThread, echoItem] = decodeMid((echo.item.message as { mid: string }).mid)

    expect(msgAccount).toBe(message.entryId)
    expect(echoAccount).toBe(echo.entryId)
    expect(msgThread).toMatch(/^\d{39}$/)
    expect(echoThread).toBe(msgThread)
    expect(msgItem).toMatch(/^\d{35}$/)
    expect(echoItem).toMatch(/^\d{35}$/)
    expect(echoItem).not.toBe(msgItem)
  })
})

describe('summarizeInstagramPayload on recorded payloads', () => {
  // An echo summarizes exactly like an inbound message, because `is_echo`
  // lives inside `message` and the summary records only the item's keys. The
  // shape log cannot tell a guest's message from a staff reply. Recorded, not
  // changed: the event line is pinned as-is by TAC-458.
  it.each([
    ['message', ['message']],
    ['echo', ['message']],
    ['read', ['read']],
  ] as const)('reports the %s delivery as %j', (name, types) => {
    const summary = summarizeInstagramPayload(JSON.parse(raw(name)))
    expect(summary.object).toBe('instagram')
    expect(summary.entryCount).toBe(1)
    expect(summary.events).toEqual([{ time: expect.any(Number), types }])
  })

  it.each(FIXTURE_NAMES)('keeps every id, mid and text of the %s delivery out of the summary', (name) => {
    const body = raw(name)
    const serialized = JSON.stringify(summarizeInstagramPayload(JSON.parse(body)))
    const values = [...body.matchAll(/"(?:id|mid|text)":"([^"]+)"/g)].map((m) => m[1])
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) expect(serialized).not.toContain(value)
  })
})
