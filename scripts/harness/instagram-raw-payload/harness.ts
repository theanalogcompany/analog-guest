// TEMPORARY, removed with lib/messaging/instagram/raw-payload-log.ts.
//
// Both states of INSTAGRAM_LOG_RAW_PAYLOADS, and what the line holds when it
// is on. Pure: no network, no database, no model calls.
//
// The check that earns this file is "the attachment link survives redaction".
// Meta's media links carry their signature in the query string, so a
// redaction rule written against "anything signature-shaped" removes the one
// value the capture exists to read, and the line still looks complete.
//
// What that check can and cannot catch: every value shape is anchored at the
// start today, so removing the URL guard ALONE changes nothing and this still
// passes. It fails when a shape is loosened to match mid-string with the guard
// gone, which is the mistake the guard is there for.
import {
  INSTAGRAM_RAW_PAYLOAD_EVENT,
  instagramRawPayloadLine,
} from '@/lib/messaging/instagram/raw-payload-log'

const MEDIA_URL =
  'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1784100000000000&signature=AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789'
const STORY_URL =
  'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1784100000000001&signature=sha256=0123456789abcdef0123456789abcdef'
const MID = 'aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE3ODQxNDAwMDAwMDAwMDAw'
const ACCESS_TOKEN = `IGAA${'x'.repeat(60)}`
const HUB_SIGNATURE = `sha256=${'ab'.repeat(32)}`

const delivery = {
  object: 'instagram',
  entry: [
    {
      id: '17841400000000000',
      time: 1760205731000,
      messaging: [
        {
          sender: { id: '1234567890123456' },
          recipient: { id: '17841400000000000' },
          timestamp: 1760205730000,
          message: {
            mid: MID,
            text: 'is this the new one?',
            attachments: [{ type: 'image', payload: { url: MEDIA_URL } }],
            reply_to: { story: { url: STORY_URL, id: '18000000000000000' } },
          },
          // None of these belong in a real delivery. They stand for a field
          // Meta adds later.
          access_token: 'short-and-not-token-shaped',
          debug: { nested: { deeper: { xHubSignature: 'anything' } } },
          forwarded: [
            ACCESS_TOKEN,
            HUB_SIGNATURE,
            'plain text stays',
            'bearer bonds',
          ],
        },
      ],
    },
  ],
}

const on = instagramRawPayloadLine(delivery, 'true')
const parsedOn: unknown = on === null ? null : JSON.parse(on)
const text = on ?? ''

const offValues: (string | undefined)[] = [
  undefined,
  '',
  'false',
  'TRUE',
  '1',
  ' true',
]

type Check = [name: string, ok: boolean, detail: string]

const checks: Check[] = [
  ...offValues.map((value): Check => [
    `flag ${JSON.stringify(value)} logs nothing`,
    instagramRawPayloadLine(delivery, value) === null,
    'a line was produced',
  ]),
  ["flag 'true' produces a line", on !== null, 'null'],
  ['it is a single line', !text.includes('\n'), 'contains a newline'],
  [
    'it carries the event name',
    typeof parsedOn === 'object' &&
      parsedOn !== null &&
      'event' in parsedOn &&
      parsedOn.event === INSTAGRAM_RAW_PAYLOAD_EVENT,
    text.slice(0, 60),
  ],
  [
    'the attachment type is there at full depth',
    text.includes('"attachments":[{"type":"image"'),
    'attachment type not found',
  ],
  [
    'the attachment link survives, signature and all',
    text.includes(JSON.stringify(MEDIA_URL)),
    'payload.url was altered',
  ],
  [
    'the story link survives though its query is signature-shaped',
    text.includes(JSON.stringify(STORY_URL)),
    'reply_to.story.url was altered',
  ],
  ['the mid survives', text.includes(MID), 'mid was altered'],
  [
    'a token-named key is redacted whatever its value',
    text.includes('"access_token":"[redacted]"'),
    'access_token value present',
  ],
  [
    'a signature-named key is redacted four levels down',
    text.includes('"xHubSignature":"[redacted]"'),
    'nested signature value present',
  ],
  [
    'a token-shaped value is redacted under an innocent key',
    !text.includes(ACCESS_TOKEN),
    'access token present',
  ],
  [
    'a signature-shaped value is redacted under an innocent key',
    !text.includes(HUB_SIGNATURE),
    'hub signature present',
  ],
  [
    'ordinary strings beside them are untouched',
    text.includes('"plain text stays"') &&
      text.includes('"bearer bonds"') &&
      text.includes('"is this the new one?"'),
    'plain text was altered',
  ],
  [
    'a body that is not an object still produces a line',
    instagramRawPayloadLine('oat milk', 'true') ===
      `{"event":"${INSTAGRAM_RAW_PAYLOAD_EVENT}","payload":"oat milk"}`,
    String(instagramRawPayloadLine('oat milk', 'true')),
  ],
]

let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`)
}
console.log(`\n${checks.length - failed}/${checks.length}`)
process.exit(failed > 0 ? 1 : 0)
