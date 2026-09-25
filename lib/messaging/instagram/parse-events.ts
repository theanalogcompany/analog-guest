// TAC-468: turn a verified Instagram webhook delivery into typed events.
//
// Pure. The route verifies the signature and parses the JSON; this decides
// what each item in the delivery IS, and handle-events.ts decides what to save.
// Kept apart so the rules here are tested against Meta's recorded payloads
// (fixtures/) without a database.
//
// Meta batches: one delivery holds `entry[]`, and each entry holds a
// `messaging[]` array (or `changes[]` / `standby[]` for fields this handler
// does not handle). Events come back in delivery order, one per item, so a
// guest's message and the venue's reply keep their order.
//
// Four kinds are handled, told apart by the item's own keys and never by
// guessing from sender and recipient:
//   message   `message` present, no `is_echo`: the guest wrote to the venue.
//   echo      `message.is_echo === true`: the venue account sent it, by ANY
//             means. Staff typing in the Instagram app, and (from TAC-469) the
//             agent's own API sends. Sender and recipient are reversed.
//   postback  `postback`: an icebreaker tap. Its `mid` is INSIDE `postback`.
//   read      `read`: a read receipt. The key is `read`; `messaging_seen` is
//             only the webhook subscription field's name. It names one `mid`.
//   referral  `referral` ALONE, with no message, postback or read beside it
//             (TAC-536): the guest followed the venue's ig.me link into a
//             thread Instagram already had. It is the ONLY kind with no
//             `mid`, because Meta's standalone-referral item carries only
//             sender, recipient, timestamp and referral. Everything else
//             dedupes on messages.provider_message_id's unique constraint;
//             this one structurally cannot.
//
// Everything else becomes an `unhandled` event carrying a reason and the NAMES
// of what arrived, never values, so the route can log it and acknowledge it.
// Nothing is dropped silently: an unexpected shape is how a future Meta change
// shows up, and a silent drop would make it look like a bug somewhere else.

export type InstagramReferral = {
  /** The `ref` query parameter of the ig.me link the guest followed. */
  ref: string | null
  /** Meta's `source`, e.g. `SHORTLINK` on the recorded postback. */
  source: string | null
}

type EventBase = {
  /** `entry[].id`: the venue's Instagram professional account ID. */
  accountId: string
  /** The guest's Instagram-scoped ID: whichever party is not the account. */
  guestIgsid: string
  /** Meta's message ID. On a read receipt, the ID of the message that was read. */
  mid: string
  /**
   * When this happened by Instagram's clock, as an ISO string: the item's
   * `timestamp`, NOT `entry.time` (TAC-479). `entry.time` is when Meta sent
   * the delivery, 0.4 to 1.1 seconds later in every recorded payload, and far
   * later on a redelivery; Instagram's 24-hour reply window runs from the
   * guest's action. Null when the item carries no millisecond timestamp (see
   * providerSentAtOf).
   */
  providerSentAt: string | null
}

export type InstagramMessageEvent = EventBase & {
  kind: 'message'
  text: string | null
  mediaUrls: string[]
  referral: InstagramReferral | null
}

export type InstagramEchoEvent = EventBase & {
  kind: 'echo'
  text: string | null
  mediaUrls: string[]
}

// The postback's `payload` (e.g. ICEBREAKER_HOURS) is deliberately not carried:
// it is the venue's icebreaker configuration, not something the guest saw, and
// there is no column for it. The `title` is what the thread shows as the
// guest's message.
export type InstagramPostbackEvent = EventBase & {
  kind: 'postback'
  title: string | null
  referral: InstagramReferral | null
}

export type InstagramReadEvent = EventBase & { kind: 'read' }

/**
 * TAC-536: a standalone referral. The guest opened the venue's ig.me link into
 * a thread that already had messages, so Instagram showed no icebreaker and
 * sent this instead of a postback.
 *
 * Deliberately NOT extending EventBase: there is no `mid` on this shape, and
 * inheriting one as a lie would give the handler a duplicate key that is
 * always undefined. The absence is the reason handle-events.ts writes this row
 * with `provider_message_id: null`, which in turn is what tells a scan row
 * apart from every other inbound Instagram row.
 */
export type InstagramReferralEvent = {
  kind: 'referral'
  accountId: string
  guestIgsid: string
  providerSentAt: string | null
  referral: InstagramReferral
}

export type InstagramHandledEvent =
  | InstagramMessageEvent
  | InstagramEchoEvent
  | InstagramPostbackEvent
  | InstagramReadEvent
  | InstagramReferralEvent

export type InstagramUnhandledReason =
  /** Top-level `object` is not `instagram`. `fields` holds the object's value. */
  | 'not_instagram'
  /** A structure that isn't the shape Meta documents, or is missing an ID. */
  | 'malformed'
  /** An `entry[].changes[]` item: comments, live_comments, mentions. `fields` holds its `field`. */
  | 'changes_field'
  /** An `entry[].standby[]` item. */
  | 'standby'
  /** An entry key other than id, time, messaging, changes and standby. */
  | 'unrecognized_entry_field'
  /**
   * A referral-shaped item with nothing usable in it: no `ref` and no
   * `source`. RARE since TAC-536, which made the ordinary standalone referral
   * its own handled kind. Until then this was the normal outcome for a guest
   * following an ig.me link into a thread that already had messages, and every
   * one of them was discarded.
   */
  | 'standalone_referral'
  /** A `messaging[]` item of any other kind: reaction, message_edit, handover... */
  | 'unhandled_messaging_type'
  /** Sender and recipient don't fit the account, e.g. a guest message not addressed to it. */
  | 'account_mismatch'
  /** The guest unsent a message (`message.is_deleted`). */
  | 'message_deleted'
  /** Meta could not render the content (`message.is_unsupported`). */
  | 'message_unsupported'
  /** A message with neither text nor an attachment URL. */
  | 'message_no_content'

export type InstagramUnhandledEvent = {
  kind: 'unhandled'
  reason: InstagramUnhandledReason
  /** Names of what arrived (keys, or a `field` / `object` value). Never content. */
  fields: string[]
}

export type InstagramEvent = InstagramHandledEvent | InstagramUnhandledEvent

/** Entry keys this parser reads. Any other key is reported, not ignored. */
const KNOWN_ENTRY_KEYS: ReadonlySet<string> = new Set(['id', 'time', 'messaging', 'changes', 'standby'])

/** Per-item keys that route an event rather than name it. */
const ROUTING_KEYS: ReadonlySet<string> = new Set(['sender', 'recipient', 'timestamp'])

// The same bounds summarize-payload.ts puts on what it logs: the names come
// from a signed body, but they still end up in a log line.
const MAX_FIELD_LENGTH = 64
const MAX_FIELDS = 12

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function fieldNames(names: Iterable<string>): string[] {
  const out: string[] = []
  for (const name of names) {
    if (out.length >= MAX_FIELDS) break
    if (name.length > MAX_FIELD_LENGTH) continue
    out.push(name)
  }
  return out.sort()
}

function itemFieldNames(item: Record<string, unknown>): string[] {
  return fieldNames(Object.keys(item).filter((key) => !ROUTING_KEYS.has(key)))
}

function unhandled(reason: InstagramUnhandledReason, fields: string[] = []): InstagramUnhandledEvent {
  return { kind: 'unhandled', reason, fields }
}

function idOf(party: unknown): string | null {
  return isRecord(party) ? nonEmptyString(party.id) : null
}

// Meta sends `timestamp` in milliseconds since the epoch (13 digits in every
// recorded payload). Anything else becomes null rather than a guess. The bounds
// are what make a value in SECONDS null instead of a date in January 1970,
// which TAC-469's window gate would read as a window that closed decades ago.
// 1e12 ms is 2001-09-09 and 1e13 ms is 2286: every real value is between them,
// and no seconds value is. Not compared against the current time: this module
// is pure, and a timestamp slightly ahead of our clock is Meta's clock, not an
// error.
const MIN_EPOCH_MS = 1e12
const MAX_EPOCH_MS = 1e13

function providerSentAtOf(item: Record<string, unknown>): string | null {
  const value = item.timestamp
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < MIN_EPOCH_MS || value >= MAX_EPOCH_MS) return null
  return new Date(value).toISOString()
}

function parseReferral(value: unknown): InstagramReferral | null {
  if (!isRecord(value)) return null
  const ref = nonEmptyString(value.ref)
  const source = nonEmptyString(value.source)
  if (ref === null && source === null) return null
  return { ref, source }
}

// Every attachment kind Meta documents (image, video, audio, file, share,
// story_mention, ig_reel) carries its link at `payload.url`. These are signed
// CDN URLs that expire; they are kept as they arrive, as the Sendblue path
// keeps its media URL.
function attachmentUrls(message: Record<string, unknown>): string[] {
  if (!Array.isArray(message.attachments)) return []
  const urls: string[] = []
  for (const attachment of message.attachments) {
    if (!isRecord(attachment) || !isRecord(attachment.payload)) continue
    const url = nonEmptyString(attachment.payload.url)
    if (url !== null) urls.push(url)
  }
  return urls
}

function parseMessage(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
  accountId: string,
  senderId: string,
  recipientId: string,
): InstagramEvent {
  const isEcho = message.is_echo === true
  // An echo is FROM the account; everything else is TO it. A self-addressed
  // item fits neither and is refused rather than guessed at.
  const fits = isEcho
    ? senderId === accountId && recipientId !== accountId
    : recipientId === accountId && senderId !== accountId
  if (!fits) return unhandled('account_mismatch', itemFieldNames(item))

  const mid = nonEmptyString(message.mid)
  if (mid === null) return unhandled('malformed', fieldNames(Object.keys(message)))
  if (message.is_deleted === true) return unhandled('message_deleted', fieldNames(Object.keys(message)))
  if (message.is_unsupported === true) {
    return unhandled('message_unsupported', fieldNames(Object.keys(message)))
  }

  const text = nonEmptyString(message.text)
  const mediaUrls = attachmentUrls(message)
  if (text === null && mediaUrls.length === 0) {
    return unhandled('message_no_content', fieldNames(Object.keys(message)))
  }

  if (isEcho) {
    return {
      kind: 'echo',
      accountId,
      guestIgsid: recipientId,
      mid,
      providerSentAt: providerSentAtOf(item),
      text,
      mediaUrls,
    }
  }
  return {
    kind: 'message',
    accountId,
    guestIgsid: senderId,
    mid,
    providerSentAt: providerSentAtOf(item),
    text,
    mediaUrls,
    // Inside `message` on an ad referral; beside it, where Meta has put it on
    // other surfaces. Taking either costs nothing, and the ref arrives once.
    referral: parseReferral(message.referral) ?? parseReferral(item.referral),
  }
}

function parseMessagingItem(item: unknown, accountId: string | null): InstagramEvent {
  if (!isRecord(item)) return unhandled('malformed')

  const senderId = idOf(item.sender)
  const recipientId = idOf(item.recipient)
  if (accountId === null || senderId === null || recipientId === null) {
    return unhandled('malformed', itemFieldNames(item))
  }

  if (isRecord(item.message)) {
    return parseMessage(item, item.message, accountId, senderId, recipientId)
  }

  // A postback and a read receipt both come from the guest, to the account.
  const fromGuest = recipientId === accountId && senderId !== accountId

  if (isRecord(item.postback)) {
    if (!fromGuest) return unhandled('account_mismatch', itemFieldNames(item))
    const mid = nonEmptyString(item.postback.mid)
    if (mid === null) return unhandled('malformed', fieldNames(Object.keys(item.postback)))
    return {
      kind: 'postback',
      accountId,
      guestIgsid: senderId,
      mid,
      providerSentAt: providerSentAtOf(item),
      title: nonEmptyString(item.postback.title),
      referral: parseReferral(item.postback.referral) ?? parseReferral(item.referral),
    }
  }

  if (isRecord(item.read)) {
    if (!fromGuest) return unhandled('account_mismatch', itemFieldNames(item))
    const mid = nonEmptyString(item.read.mid)
    if (mid === null) return unhandled('malformed', fieldNames(Object.keys(item.read)))
    return { kind: 'read', accountId, guestIgsid: senderId, mid, providerSentAt: providerSentAtOf(item) }
  }

  // TAC-536: a referral with nothing else beside it. Handled rather than
  // discarded, because following an ig.me link into an existing thread reopens
  // Meta's 24-hour window on its own, so the venue may reply to it.
  //
  // `fromGuest` is checked for the same reason the postback and read branches
  // check it: the account never sends itself a referral, and an item that does
  // not fit is refused rather than guessed at.
  if (isRecord(item.referral)) {
    if (!fromGuest) return unhandled('account_mismatch', itemFieldNames(item))
    const referral = parseReferral(item.referral)
    // No ref and no source. There is nothing to record and nothing to act on,
    // so it keeps the reason the whole shape used to carry.
    if (referral === null) return unhandled('standalone_referral', itemFieldNames(item))
    return {
      kind: 'referral',
      accountId,
      guestIgsid: senderId,
      providerSentAt: providerSentAtOf(item),
      referral,
    }
  }

  return unhandled('unhandled_messaging_type', itemFieldNames(item))
}

function parseEntry(entry: unknown): InstagramEvent[] {
  if (!isRecord(entry)) return [unhandled('malformed')]

  const accountId = nonEmptyString(entry.id)
  const events: InstagramEvent[] = []
  let sawItems = false

  if (Array.isArray(entry.messaging)) {
    sawItems = true
    for (const item of entry.messaging) events.push(parseMessagingItem(item, accountId))
  }
  if (Array.isArray(entry.changes)) {
    sawItems = true
    for (const change of entry.changes) {
      const field = isRecord(change) ? nonEmptyString(change.field) : null
      events.push(unhandled('changes_field', field === null ? [] : fieldNames([field])))
    }
  }
  if (Array.isArray(entry.standby)) {
    sawItems = true
    for (const item of entry.standby) {
      events.push(unhandled('standby', isRecord(item) ? itemFieldNames(item) : []))
    }
  }

  // A new array Meta adds beside `messaging` would otherwise reach no log at
  // all: summarize-payload.ts only reads keys inside `messaging` items.
  const unknownKeys = Object.keys(entry).filter((key) => !KNOWN_ENTRY_KEYS.has(key))
  if (unknownKeys.length > 0) events.push(unhandled('unrecognized_entry_field', fieldNames(unknownKeys)))
  else if (!sawItems) events.push(unhandled('malformed'))
  return events
}

/**
 * Every event in a verified delivery, in delivery order. Never throws: the
 * input is whatever JSON.parse returned, so every level is guarded, and a
 * shape this doesn't recognize becomes an `unhandled` event rather than an
 * exception or a silent drop.
 */
export function parseInstagramDelivery(parsed: unknown): InstagramEvent[] {
  if (!isRecord(parsed)) return [unhandled('malformed')]

  if (parsed.object !== 'instagram') {
    const object = nonEmptyString(parsed.object)
    return [unhandled('not_instagram', object === null ? [] : fieldNames([object]))]
  }

  if (!Array.isArray(parsed.entry)) return [unhandled('malformed', fieldNames(Object.keys(parsed)))]
  return parsed.entry.flatMap(parseEntry)
}
