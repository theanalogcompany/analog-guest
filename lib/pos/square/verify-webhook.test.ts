import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { verifySquareWebhook } from './verify-webhook'

const KEY = 'test-signature-key'
const URL = 'https://webhooks.example.com/api/webhooks/square'
const BODY = '{"type":"payment.created","event_id":"evt_1"}'

function sign(url: string, body: string, key: string): string {
  return createHmac('sha256', key)
    .update(url + body)
    .digest('base64')
}

function headersWith(sig: string): Headers {
  return new Headers({ 'x-square-hmacsha256-signature': sig })
}

describe('verifySquareWebhook', () => {
  it('accepts a correctly signed delivery', () => {
    const sig = sign(URL, BODY, KEY)
    expect(verifySquareWebhook(BODY, headersWith(sig), URL, KEY)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const sig = sign(URL, BODY, KEY)
    expect(verifySquareWebhook(BODY + 'x', headersWith(sig), URL, KEY)).toBe(false)
  })

  it('rejects a notification-url mismatch (the URL is part of the signature)', () => {
    const sig = sign(URL, BODY, KEY)
    expect(verifySquareWebhook(BODY, headersWith(sig), URL + '/', KEY)).toBe(false)
  })

  it('rejects the wrong key', () => {
    const sig = sign(URL, BODY, KEY)
    expect(verifySquareWebhook(BODY, headersWith(sig), URL, 'other-key')).toBe(false)
  })

  it('rejects a missing signature header without throwing', () => {
    expect(verifySquareWebhook(BODY, new Headers(), URL, KEY)).toBe(false)
  })
})
