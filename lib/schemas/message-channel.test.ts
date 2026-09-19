import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MESSAGE_CHANNELS, isMessageChannel, parseMessageChannel } from './message-channel'

describe('parseMessageChannel', () => {
  it('passes through the two real values', () => {
    expect(parseMessageChannel('text')).toBe('text')
    expect(parseMessageChannel('instagram')).toBe('instagram')
  })

  it('returns null for null and undefined, without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseMessageChannel(null)).toBeNull()
    expect(parseMessageChannel(undefined)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // Null, never a guess: an unknown channel must not quietly become 'text',
  // which is exactly how migration 048's default hides an Instagram row.
  it('degrades an unrecognized value to null and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseMessageChannel('sms')).toBeNull()
    expect(parseMessageChannel('Instagram')).toBeNull()
    expect(parseMessageChannel('')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('isMessageChannel rejects anything outside the list', () => {
    expect(isMessageChannel('text')).toBe(true)
    expect(isMessageChannel('instagram')).toBe(true)
    expect(isMessageChannel(undefined)).toBe(false)
    expect(isMessageChannel(null)).toBe(false)
    expect(isMessageChannel('dm')).toBe(false)
  })
})

// The list and migration 048's CHECK must name the same channels. A channel
// added to one and not the other either can't be written or can't be read.
describe('MESSAGE_CHANNELS matches messages_channel_check', () => {
  it('lists exactly the values the CHECK permits', () => {
    const sql = readFileSync(
      join(__dirname, '../../db/migrations/048_instagram_identity_and_message_channel.sql'),
      'utf8',
    )
    const check = sql.match(
      /add constraint messages_channel_check\s+check \(channel in \(([^)]*)\)\)/,
    )
    expect(check).not.toBeNull()
    const values = (check?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
    expect([...values].sort()).toEqual([...MESSAGE_CHANNELS].sort())
  })
})
