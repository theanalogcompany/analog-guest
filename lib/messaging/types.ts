import { z } from 'zod'

export type ReactionType =
  | 'love'
  | 'like'
  | 'dislike'
  | 'laugh'
  | 'emphasize'
  | 'question'

export type SendMessageInput = {
  venueId: string
  to: string
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
  to: string
}

export type MarkAsReadInput = {
  venueId: string
  to: string
  messageHandle: string
}

export type MessagingResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; errorCode?: string }

export const SendblueWebhookPayloadSchema = z.object({
  account_email: z.string(),
  content: z.string().nullable().optional(),
  media_url: z.string().nullable().optional(),
  number: z.string(),
  from_number: z.string(),
  is_outbound: z.boolean(),
  message_handle: z.string(),
  status: z.enum(['QUEUED', 'SENT', 'DELIVERED', 'ERROR']),
  error_code: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  date_sent: z.string().optional(),
  date_updated: z.string().optional(),
})

export type SendblueWebhookPayload = z.infer<typeof SendblueWebhookPayloadSchema>
