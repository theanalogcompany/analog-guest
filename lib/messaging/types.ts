import { z } from 'zod'

export type ReactionType =
  | 'love'
  | 'like'
  | 'dislike'
  | 'laugh'
  | 'emphasize'
  | 'question'

// TAC-467: `to` is nullable on the three inputs that take a guest's phone
// straight from GuestContext (send, typing, mark-as-read). A guest who came in
// on Instagram has no phone, and these refuse null with
// `recipient_has_no_phone_number` before touching the provider. Reactions keep
// a plain string: their only caller answers an inbound text, which always has
// a number.
export type SendMessageInput = {
  venueId: string
  to: string | null
  body: string
  mediaUrls?: string[]
}

export type SendReactionInput = {
  venueId: string
  to: string
  reaction: ReactionType
  messageHandle: string
  replyToMessageId: string
  guestId: string
}

export type SendTypingIndicatorInput = {
  venueId: string
  to: string | null
}

export type MarkAsReadInput = {
  venueId: string
  to: string | null
  messageHandle: string
}

export type MessagingResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; errorCode?: string }

export const SendblueWebhookPayloadSchema = z.object({
  // Sendblue uses camelCase for this one field, snake_case for everything else.
  accountEmail: z.string(),
  content: z.string().nullable().optional(),
  // Empty string "" is sent when no media (not null), per the docs.
  media_url: z.string().optional(),
  number: z.string(),
  from_number: z.string(),
  is_outbound: z.boolean(),
  message_handle: z.string(),
  status: z.enum(['QUEUED', 'SENT', 'DELIVERED', 'ERROR', 'RECEIVED']),
  error_code: z.union([z.string(), z.number()]).nullable().optional(),
  error_message: z.string().nullable().optional(),
  error_detail: z.string().nullable().optional(),
  date_sent: z.string().optional(),
  date_updated: z.string().optional(),
  to_number: z.string().optional(),
  sendblue_number: z.string().nullable().optional(),
  was_downgraded: z.boolean().nullable().optional(),
  plan: z.string().optional(),
  message_type: z.string().optional(),
  group_id: z.string().optional(),
  participants: z.array(z.string()).optional(),
  send_style: z.string().optional(),
  opted_out: z.boolean().optional(),
  service: z.string().optional(),
  group_display_name: z.string().nullable().optional(),
})

export type SendblueWebhookPayload = z.infer<typeof SendblueWebhookPayloadSchema>
