import { describe, expect, it } from 'vitest'

import {
  asksAQuestion,
  findTopics,
  mentionsThePause,
} from './warm-close-language'

describe('findTopics (TAC-560)', () => {
  it('finds all three when named plainly', () => {
    const v = findTopics(
      "we're around whenever, whether it's questions about our beans, what to order next time, or events coming up",
    )
    expect(v.allThree).toBe(true)
    expect(v.matched).toEqual({
      coffee: 'beans',
      menu: 'what to order',
      events: 'events',
    })
  })

  it('finds a paraphrase, because rule 15 says "in your own words"', () => {
    // The reason this cannot be a phrase list alone: every topic arrives
    // reworded, and a narrow list under-counts exactly the replies that obeyed
    // the instruction (the TAC-423 asymmetry).
    const v = findTopics(
      "message us anytime about what's in the cup, what we're pouring this week, or anything happening at the shop",
    )
    expect(v.allThree).toBe(true)
  })

  it('reports WHICH topic is missing rather than a bare false', () => {
    const v = findTopics(
      'come back anytime for a chat about our beans and the menu',
    )
    expect(v.allThree).toBe(false)
    expect(v.coffee).toBe(true)
    expect(v.menu).toBe(true)
    expect(v.events).toBe(false)
  })

  it('is case and accent insensitive', () => {
    expect(findTopics('BEANS, MENU, EVENTS').allThree).toBe(true)
  })

  it('does not match a topic word inside a longer word', () => {
    // Word boundaries on both sides, after the TAC-326 "san" inside "Hi Sana!"
    // trap: a substring match here would report a topic that is not named.
    expect(findTopics('eventually').events).toBe(false)
    expect(findTopics('beanstalk').coffee).toBe(false)
  })
})

describe('asksAQuestion (TAC-560)', () => {
  it('is a ceiling, and one occurrence is a breach', () => {
    expect(asksAQuestion('anything you want to know, just ask')).toBe(false)
    expect(asksAQuestion('what did you think of it?')).toBe(true)
  })
})

describe('mentionsThePause (TAC-560)', () => {
  it('catches narrating the silence, which the block forbids', () => {
    expect(mentionsThePause('sorry for the wait, the line is open')).toBe(
      'sorry for the wait',
    )
    expect(mentionsThePause("haven't heard from you, but we're here")).toBe(
      "haven't heard",
    )
    expect(mentionsThePause('the line is open whenever you want it')).toBeNull()
  })
})
