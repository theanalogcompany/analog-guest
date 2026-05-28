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
