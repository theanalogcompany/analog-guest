// Internal Sendblue HTTP wrapper. Used by other files in lib/messaging/.
// Do NOT import this from outside the messaging module — use the public
// API exported from lib/messaging/index.ts instead.

import type { ReactionType } from './types'

const SENDBLUE_BASE_URL = 'https://api.sendblue.co'

export class SendblueAPIError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message)
    this.name = 'SendblueAPIError'
  }
}

type SendblueSendResponse = {
  message_handle: string
  status: string
  [key: string]: unknown
}

type SendblueReactionResponse = {
  message_handle: string
  status: string
  [key: string]: unknown
}

type SendblueTypingResponse = {
  status: string
  [key: string]: unknown
}

type SendblueReadResponse = {
  status: string
  [key: string]: unknown
}

function getCredentials(): { keyId: string; secret: string } {
  const keyId = process.env.SENDBLUE_API_KEY_ID
  const secret = process.env.SENDBLUE_API_SECRET_KEY
  if (!keyId) throw new Error('Missing env var: SENDBLUE_API_KEY_ID')
  if (!secret) throw new Error('Missing env var: SENDBLUE_API_SECRET_KEY')
  return { keyId, secret }
}

// TODO(verify): Sendblue may expect PascalCase; confirm on first reaction test
function toSendblueReaction(r: ReactionType): string {
  return r
}

async function sendblueRequest<T>(path: string, body: unknown): Promise<T> {
  const { keyId, secret } = getCredentials()
  const url = `${SENDBLUE_BASE_URL}${path}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'sb-api-key-id': keyId,
        'sb-api-secret-key': secret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new SendblueAPIError(0, null, `Sendblue network error calling ${path}: ${message}`)
  }

  const text = await response.text()
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!response.ok) {
    throw new SendblueAPIError(
      response.status,
      parsed,
      `Sendblue API ${path} returned ${response.status}`,
    )
  }

  return parsed as T
}

export async function sendblueSendMessage(input: {
  from: string
  to: string
  content: string
  mediaUrl?: string
}): Promise<SendblueSendResponse> {
  const body: Record<string, unknown> = {
    number: input.to,
    from_number: input.from,
    content: input.content,
  }
  if (input.mediaUrl !== undefined) body.media_url = input.mediaUrl
  return sendblueRequest<SendblueSendResponse>('/api/send-message', body)
}

export async function sendblueSendReaction(input: {
  from: string
  to: string
  reaction: ReactionType
  messageHandle: string
}): Promise<SendblueReactionResponse> {
  return sendblueRequest<SendblueReactionResponse>('/api/v2/reactions', {
    from_number: input.from,
    number: input.to,
    reaction: toSendblueReaction(input.reaction),
    message_handle: input.messageHandle,
  })
}

export async function sendblueSendTypingIndicator(input: {
  from: string
  to: string
}): Promise<SendblueTypingResponse> {
  return sendblueRequest<SendblueTypingResponse>('/api/send-typing-indicator', {
    from_number: input.from,
    number: input.to,
  })
}

// TODO(verify): confirm Sendblue read-receipt endpoint when we wire up the first webhook
export async function sendblueMarkAsRead(input: {
  from: string
  to: string
  messageHandle: string
}): Promise<SendblueReadResponse> {
  return sendblueRequest<SendblueReadResponse>(
    `/api/v2/messages/${encodeURIComponent(input.messageHandle)}/read`,
    {
      from_number: input.from,
      number: input.to,
    },
  )
}
