// TAC-582: what each webhook turns a guest's attachment into.
//
// Pure: no network, no database, no model calls. It runs the real parser and
// the real kind mapping over the payload shapes Meta sent on 2026-10-11 and
// checks the rows that would be written.
//
// WHERE THE FIXTURES COME FROM. The image, voice note, sticker/GIF and reel
// share below are the shapes captured through the temporary raw-payload log
// (PR #369), with every id and every link signature replaced. The video,
// story mention and story reply are NOT captured: they follow Meta's
// documented shapes and nothing else, and the check names say so. A real
// delivery of any of those three is the thing that can still disagree with
// this file.
//
// THE CHECKS THAT EARN THIS FILE:
//   - `mediaUrls` is exactly what it was before attachments existed. The
//     agent's media-only rule and every `media_urls` reader depend on it.
//   - a sticker is a 'gif' and a photo is an 'image', which differ only in
//     the link's host.
//   - a link that must never be fetched is refused before any request.
import {
  downloadTargetFor,
  storagePathFor,
} from '@/lib/messaging/attachments/rehost'
import {
  SENDBLUE_PROVIDER_TYPE,
  STORY_REPLY_PROVIDER_TYPE,
  initialStatusFor,
  kindFromInstagramType,
  kindFromMimeType,
  kindFromUrlExtension,
} from '@/lib/messaging/attachments/kind'
import {
  parseInstagramDelivery,
  type InstagramEvent,
} from '@/lib/messaging/instagram/parse-events'

const ACCOUNT_ID = '17841400000000000'
const GUEST_ID = '1234567890123456'
const SENT_AT = 1_760_202_753_000

const PHOTO_URL =
  'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1000000000000001&signature=REDACTED'
const VOICE_URL =
  'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1000000000000002&signature=REDACTED'
const VIDEO_URL =
  'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1000000000000003&signature=REDACTED'
const STORY_URL =
  'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1000000000000004&signature=REDACTED'
const GIF_URL = 'https://media3.giphy.com/media/v1.REDACTED/abc123/200.gif'
const REEL_URL = 'https://www.instagram.com/reel/AbCdEfGhIjK/'
const REEL_TITLE = 'the amount of times we lost him was crazy'

type RawAttachment = { type: string; payload?: Record<string, unknown> }

function delivery(
  message: Record<string, unknown>,
  echo = false,
): Record<string, unknown> {
  return {
    object: 'instagram',
    entry: [
      {
        id: ACCOUNT_ID,
        time: SENT_AT + 700,
        messaging: [
          {
            sender: { id: echo ? ACCOUNT_ID : GUEST_ID },
            recipient: { id: echo ? GUEST_ID : ACCOUNT_ID },
            timestamp: SENT_AT,
            message: echo ? { ...message, is_echo: true } : message,
          },
        ],
      },
    ],
  }
}

function withAttachments(
  mid: string,
  attachments: RawAttachment[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { mid, attachments, ...extra }
}

function only(parsed: InstagramEvent[]): InstagramEvent {
  if (parsed.length !== 1) {
    throw new Error(`expected one event, got ${parsed.length}`)
  }
  return parsed[0]
}

type Row = {
  kind: string
  status: string
  providerType: string | null
  url: string | null
  title: string | null
}

type Parsed = { kind: string; mediaUrls: string[]; rows: Row[] }

function parse(message: Record<string, unknown>, echo = false): Parsed {
  const event = only(parseInstagramDelivery(delivery(message, echo)))
  if (event.kind !== 'message' && event.kind !== 'echo') {
    return { kind: event.kind, mediaUrls: [], rows: [] }
  }
  return {
    kind: event.kind,
    mediaUrls: event.mediaUrls,
    rows: event.attachments.map((a) => ({
      kind: a.kind,
      status: initialStatusFor(a.kind, a.url),
      providerType: a.providerType,
      url: a.url,
      title: a.title,
    })),
  }
}

const photo = parse(
  withAttachments('mid.photo', [
    { type: 'image', payload: { url: PHOTO_URL } },
  ]),
)
const voice = parse(
  withAttachments('mid.voice', [
    { type: 'audio', payload: { url: VOICE_URL } },
  ]),
)
const sticker = parse(
  withAttachments('mid.gif', [{ type: 'image', payload: { url: GIF_URL } }]),
)
const reel = parse(
  withAttachments('mid.reel', [
    {
      type: 'ig_reel',
      payload: {
        reel_video_id: '1000000000000009',
        title: REEL_TITLE,
        url: REEL_URL,
      },
    },
  ]),
)
const video = parse(
  withAttachments('mid.video', [
    { type: 'video', payload: { url: VIDEO_URL } },
  ]),
)
const storyMention = parse(
  withAttachments('mid.mention', [
    { type: 'story_mention', payload: { url: STORY_URL } },
  ]),
)
const storyReply = parse({
  mid: 'mid.reply',
  text: 'love this',
  reply_to: { story: { url: STORY_URL, id: '1000000000000010' } },
})
const captioned = parse(
  withAttachments(
    'mid.captioned',
    [
      { type: 'image', payload: { url: PHOTO_URL } },
      { type: 'image', payload: { url: GIF_URL } },
    ],
    { text: 'look at this' },
  ),
)
const linkless = parse(
  withAttachments('mid.linkless', [{ type: 'image' }], { text: 'hi' }),
)
const newType = parse(
  withAttachments('mid.new', [
    { type: 'something_meta_added', payload: { url: PHOTO_URL } },
  ]),
)
const staffPhoto = parse(
  withAttachments('mid.echo', [{ type: 'image', payload: { url: PHOTO_URL } }]),
  true,
)
const plainText = parse({ mid: 'mid.text', text: 'what time do you open' })

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function row(
  kind: string,
  status: string,
  providerType: string | null,
  url: string | null,
  title: string | null = null,
): Row {
  return { kind, status, providerType, url, title }
}

type Check = [name: string, ok: boolean, detail: string]

function rowsCheck(name: string, got: Parsed, expected: Row[]): Check {
  return [name, same(got.rows, expected), JSON.stringify(got.rows)]
}

const SENDBLUE_PHOTO =
  'https://storage.googleapis.com/inbound-file-store/abc.jpeg'
const SENDBLUE_VOICE =
  'https://storage.googleapis.com/inbound-file-store/abc.caf'
const SENDBLUE_BARE = 'https://storage.googleapis.com/inbound-file-store/abc'

const checks: Check[] = [
  // --- Instagram, captured shapes -----------------------------------------
  rowsCheck('captured: a photo is one pending image', photo, [
    row('image', 'pending', 'image', PHOTO_URL),
  ]),
  rowsCheck('captured: a voice note is one pending audio', voice, [
    row('audio', 'pending', 'audio', VOICE_URL),
  ]),
  rowsCheck(
    'captured: a sticker or GIF is a ready gif, not an image',
    sticker,
    [row('gif', 'ready', 'image', GIF_URL)],
  ),
  rowsCheck('captured: a reel share is link_only and keeps its caption', reel, [
    row('share', 'link_only', 'ig_reel', REEL_URL, REEL_TITLE),
  ]),

  // --- Instagram, documented shapes (not captured) ------------------------
  rowsCheck('documented: a video is one pending video', video, [
    row('video', 'pending', 'video', VIDEO_URL),
  ]),
  rowsCheck(
    'documented: a story mention is link_only, never pending',
    storyMention,
    [row('story_mention', 'link_only', 'story_mention', STORY_URL)],
  ),
  rowsCheck('documented: a story reply is one story_reply row', storyReply, [
    row('story_reply', 'link_only', STORY_REPLY_PROVIDER_TYPE, STORY_URL),
  ]),
  [
    'documented: the story a guest replied to is NOT in mediaUrls',
    same(storyReply.mediaUrls, []),
    JSON.stringify(storyReply.mediaUrls),
  ],

  // --- mediaUrls is unchanged ---------------------------------------------
  [
    'mediaUrls for a photo is exactly its link',
    same(photo.mediaUrls, [PHOTO_URL]),
    JSON.stringify(photo.mediaUrls),
  ],
  [
    'mediaUrls for a reel share is still its link, as before',
    same(reel.mediaUrls, [REEL_URL]),
    JSON.stringify(reel.mediaUrls),
  ],
  [
    'mediaUrls keeps delivery order across two attachments',
    same(captioned.mediaUrls, [PHOTO_URL, GIF_URL]),
    JSON.stringify(captioned.mediaUrls),
  ],
  rowsCheck('two attachments are two rows in delivery order', captioned, [
    row('image', 'pending', 'image', PHOTO_URL),
    row('gif', 'ready', 'image', GIF_URL),
  ]),
  [
    'a text message has no attachments and no media links',
    plainText.rows.length === 0 && plainText.mediaUrls.length === 0,
    JSON.stringify(plainText),
  ],

  // --- edges ---------------------------------------------------------------
  rowsCheck('an attachment with no link is kept as a failed row', linkless, [
    row('image', 'failed', 'image', null),
  ]),
  [
    'an attachment with no link adds nothing to mediaUrls',
    same(linkless.mediaUrls, []),
    JSON.stringify(linkless.mediaUrls),
  ],
  rowsCheck('a type Meta adds later is unknown and keeps its name', newType, [
    row('unknown', 'pending', 'something_meta_added', PHOTO_URL),
  ]),
  [
    'a photo staff sent from the app is an echo with the same row',
    staffPhoto.kind === 'echo' &&
      same(staffPhoto.rows, [row('image', 'pending', 'image', PHOTO_URL)]),
    JSON.stringify(staffPhoto),
  ],
  ...(['reel', 'share', 'ig_post'] as const).map((type): Check => [
    `Meta's "${type}" is a share`,
    kindFromInstagramType(type, REEL_URL) === 'share',
    kindFromInstagramType(type, REEL_URL),
  ]),

  // --- Sendblue ------------------------------------------------------------
  [
    'sendblue: a .jpeg link is an image',
    kindFromUrlExtension(SENDBLUE_PHOTO) === 'image',
    kindFromUrlExtension(SENDBLUE_PHOTO),
  ],
  [
    'sendblue: a .caf voice memo is audio',
    kindFromUrlExtension(SENDBLUE_VOICE) === 'audio',
    kindFromUrlExtension(SENDBLUE_VOICE),
  ],
  [
    'sendblue: a link with no extension is unknown and still pending',
    kindFromUrlExtension(SENDBLUE_BARE) === 'unknown' &&
      initialStatusFor('unknown', SENDBLUE_BARE) === 'pending',
    kindFromUrlExtension(SENDBLUE_BARE),
  ],
  [
    'sendblue: a GIF that is not on giphy is re-hosted, not served as it is',
    initialStatusFor('gif', 'https://storage.googleapis.com/x/abc.gif') ===
      'pending',
    initialStatusFor('gif', 'https://storage.googleapis.com/x/abc.gif'),
  ],

  // --- what the download settles ------------------------------------------
  ...(
    [
      ['image/jpeg', 'image'],
      ['image/gif', 'gif'],
      ['video/mp4', 'video'],
      ['audio/mp4; codecs=mp4a', 'audio'],
      ['application/pdf', 'file'],
      ['application/octet-stream', 'unknown'],
    ] as const
  ).map(([mime, kind]): Check => [
    `a downloaded ${mime} is ${kind}`,
    kindFromMimeType(mime) === kind,
    kindFromMimeType(mime),
  ]),

  // --- links that must never be fetched ------------------------------------
  [
    "Meta's CDN link is fetched",
    downloadTargetFor(PHOTO_URL, 'image').ok,
    'refused',
  ],
  [
    'an Instagram attachment on any other host is refused',
    same(downloadTargetFor('https://example.com/a.jpg', 'image'), {
      ok: false,
      reason: 'host_not_allowed',
      host: 'example.com',
    }),
    JSON.stringify(downloadTargetFor('https://example.com/a.jpg', 'image')),
  ],
  [
    'a host that only ENDS like a CDN name without the dot is refused',
    !downloadTargetFor('https://evilfbsbx.com/a.jpg', 'image').ok,
    'fetched',
  ],
  [
    'a Sendblue link on a public host is fetched',
    downloadTargetFor(SENDBLUE_PHOTO, SENDBLUE_PROVIDER_TYPE).ok,
    'refused',
  ],
  ...(
    [
      'http://storage.googleapis.com/a.jpg',
      'https://127.0.0.1/a.jpg',
      'https://localhost/a.jpg',
      'https://[::1]/a.jpg',
      'https://metadata.internal/a.jpg',
      'not a url',
    ] as const
  ).map((url): Check => [
    `a Sendblue link to ${url} is refused`,
    !downloadTargetFor(url, SENDBLUE_PROVIDER_TYPE).ok,
    'fetched',
  ]),

  // --- where the copy goes --------------------------------------------------
  [
    'the storage path is venue/guest/message/attachment',
    storagePathFor({ venueId: 'v', guestId: 'g', messageId: 'm', id: 'a' }) ===
      'v/g/m/a',
    storagePathFor({ venueId: 'v', guestId: 'g', messageId: 'm', id: 'a' }),
  ],
]

let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`)
}
console.log(`\n${checks.length - failed}/${checks.length}`)
process.exit(failed > 0 ? 1 : 0)
