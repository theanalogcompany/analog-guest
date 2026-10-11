import { z } from 'zod'

// Canonical projection of a single conversation message on the operator wire.
// One shape for two surfaces today: the recent-context preview on the queue
// (last 3, joined by the `list_operator_queue` RPC) and the full-thread fetch
// behind the operator-app edit screen (TAC-277, cap 200).
//
// {id, direction, body, createdAt} is the minimum the edit screen needs to
// render iMessage-style bubbles. Additional metadata (response_review,
// voice_fidelity, category, edit attribution) is deliberately excluded — see
// TAC-277 "Don't" notes. Schema-additive extensions are safe later because
// every consumer reads named fields.
//
// `direction` is `'inbound' | 'outbound'`, matching the messages.direction
// CHECK constraint. Reactions / status pings with empty body are filtered out
// upstream of any consumer of this shape (e.g. `body != ''` in the SELECT).

export const ThreadMessageSchema = z.object({
  id: z.string().uuid(),
  direction: z.enum(['inbound', 'outbound']),
  body: z.string(),
  createdAt: z.string(),
})

export type ThreadMessage = z.infer<typeof ThreadMessageSchema>

// Wire cap on full-thread fetches. Returned slice is the MOST RECENT N
// messages, ordered oldest→newest. Single source of truth for both the
// helper (`loadGuestThread`) and any client-side consumer that wants to
// short-circuit pagination.
export const THREAD_MESSAGE_LIMIT = 200

// TAC-582: one attachment on the operator wire. The Contract on TAC-582 is
// the source of truth for every field here; TAC-583 parses this shape.
//
// The two enums are restated here on purpose and not imported from
// lib/messaging/attachments/kind.ts: this file is the wire and that one is
// the table, and a value added to the table must not reach the client just by
// being added. `satisfies` in lib/messaging/attachments/serve.ts is what
// stops the two drifting silently.
//
// EVERY FIELD IS ALWAYS PRESENT. The client parses a thread all-or-nothing,
// so a field is null, never missing.
//   url           what to render: a signed link to our copy, giphy's own link
//                 for a GIF, Meta's link for a live story. Null otherwise.
//   urlExpiresAt  when `url` stops working. Null for a link that does not expire.
//   linkUrl       where "Open in Instagram" goes. Only a share has one.
export const THREAD_ATTACHMENT_KINDS = [
  'image',
  'gif',
  'video',
  'audio',
  'file',
  'share',
  'story_mention',
  'story_reply',
  'unknown',
] as const

export const THREAD_ATTACHMENT_STATUSES = [
  'ready',
  'pending',
  'link_only',
  'expired',
  'failed',
] as const

export const ThreadAttachmentSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(THREAD_ATTACHMENT_KINDS),
  status: z.enum(THREAD_ATTACHMENT_STATUSES),
  url: z.string().nullable(),
  urlExpiresAt: z.string().nullable(),
  mimeType: z.string().nullable(),
  title: z.string().nullable(),
  linkUrl: z.string().nullable(),
})

export type ThreadAttachment = z.infer<typeof ThreadAttachmentSchema>

// What the two thread endpoints return. A separate schema from ThreadMessage
// because the queue's `recentContext` shares that one and is built inside an
// RPC that knows nothing about attachments: extending the shared shape would
// have promised a field the queue cannot fill.
//
// `attachments` is [] and `unsupported` is false on every message when the
// request did not pass `?attachments=1`. `body` may be '' when either says
// there is something to show.
export const OperatorThreadMessageSchema = ThreadMessageSchema.extend({
  unsupported: z.boolean(),
  attachments: z.array(ThreadAttachmentSchema),
})

export type OperatorThreadMessage = z.infer<typeof OperatorThreadMessageSchema>
