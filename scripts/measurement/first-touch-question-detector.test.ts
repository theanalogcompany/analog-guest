import { describe, expect, it } from 'vitest'
import { classifyFirstTouchReply, sentencesOf } from './first-touch-question-detector'

describe('classifyFirstTouchReply (TAC-423)', () => {
  it('reads a reply with no question mark as asking nothing', () => {
    const v = classifyFirstTouchReply("Hey, welcome in. You've got Le Mil's here.")
    expect(v.hasQuestion).toBe(false)
    expect(v.isOrderQuestion).toBe(false)
    expect(v.questionSentences).toEqual([])
  })

  it('reads the live pre-change reply as an order question', () => {
    const v = classifyFirstTouchReply(
      "Hey, welcome! You're texting Himanshu directly. What did you end up getting?",
    )
    expect(v.hasQuestion).toBe(true)
    expect(v.isOrderQuestion).toBe(true)
    expect(v.orderPhrase).toBe('what did you end up getting')
    expect(v.questionSentences).toEqual(['What did you end up getting?'])
  })

  // The distinction the whole measurement turns on: a question that is not
  // about the order still counts as a question and must not count as the
  // order question.
  it('separates asking something from asking about the order', () => {
    const v = classifyFirstTouchReply("Hey! First time in, or have you been coming a while?")
    expect(v.hasQuestion).toBe(true)
    expect(v.isOrderQuestion).toBe(false)
    expect(v.orderPhrase).toBeNull()
  })

  // Scoped to the question sentence, so a statement elsewhere in the body
  // cannot make a non-order question read as one.
  it('does not count an order phrase that sits outside the question', () => {
    const v = classifyFirstTouchReply(
      "Hope what you got is good. Are you around this afternoon?",
    )
    expect(v.hasQuestion).toBe(true)
    expect(v.isOrderQuestion).toBe(false)
  })

  it('matches an order question through curly apostrophes and casing', () => {
    const v = classifyFirstTouchReply("hey — WHAT’S IN YOUR HAND?")
    expect(v.isOrderQuestion).toBe(true)
  })

  it('reports an ask with no question mark as implied only, never as a question', () => {
    const v = classifyFirstTouchReply('Welcome in. Let me know what you went with.')
    expect(v.hasQuestion).toBe(false)
    expect(v.impliedAsk).toBe(true)
  })

  it('finds a question in a multi-sentence reply and keeps only the question sentences', () => {
    const v = classifyFirstTouchReply(
      "Hey, welcome. We're open till 3 today. What did you grab?",
    )
    expect(v.questionSentences).toEqual(['What did you grab?'])
    expect(v.isOrderQuestion).toBe(true)
  })

  it('records the introduction and the thank-you separately from the question', () => {
    const v = classifyFirstTouchReply("Thanks for coming in! You've reached Himanshu.")
    expect(v.namesSomeone).toBe(true)
    expect(v.thanks).toBe(true)
    expect(v.hasQuestion).toBe(false)
  })

  it('splits on sentence end, not on every period', () => {
    expect(sentencesOf('Open till 3 p.m. What did you get?')).toHaveLength(2)
  })
})

// REGRESSION, from the first live run of this harness. Two AFTER-arm replies
// asked the order question as "what'd you get?" and scored 0, because the
// phrase list held only the uncontracted form. The miss was asymmetric: the
// BEFORE arm's opener scripts "ask what they got" so the model echoed the
// long form and matched, while the AFTER arm wrote the way a person texts.
// Left in, it would have reported that removing the opener's question stops
// the agent asking about the order, which is the opposite of what those
// bodies say.
describe('contractions (regression from the 2026-09-22 run)', () => {
  it.each([
    "Hey! Himanshu here 👋 glad you found this number. What'd you get?",
    "Hey! I'm Himanshu 👋 hope you enjoyed whatever you grabbed today — what'd you get?",
    'hey, welcome in. what’d you end up with?',
  ])('reads a contracted order question as the order question: %s', (body) => {
    const v = classifyFirstTouchReply(body)
    expect(v.hasQuestion).toBe(true)
    expect(v.isOrderQuestion).toBe(true)
  })

  // The control, and the reason this is not just "match more things": asking
  // how it was is a DIFFERENT intention (did_they_like_it), and counting it as
  // the order question would inflate the AFTER arm instead.
  it.each([
    "Hey, welcome! I'm Himanshu 👋 how was everything?",
    'hey! how was it?',
  ])('does not read a how-was-it question as the order question: %s', (body) => {
    const v = classifyFirstTouchReply(body)
    expect(v.hasQuestion).toBe(true)
    expect(v.isOrderQuestion).toBe(false)
  })
})

// SECOND REGRESSION, from the confirmation run of the restored wording, and
// caused by that wording. The opener now says "Ask what they just got", so the
// model writes "what did you just grab?" and "what did you just get?" — and an
// exact-substring list holding "what did you get" matches neither. Asymmetric
// again, and this time against the SHIPPED arm, because only the shipped
// opener says "just". Reported at 71% before the fix for a wording that asks
// the order question every time.
//
// The lesson is the same one twice: an exact-phrase list is the wrong shape
// for a free-text question, and each new opener wording breaks it in a new
// place. The matcher is a pattern with an optional adverb slot now.
describe('adverb slot (regression from the 2026-09-23 confirmation run)', () => {
  it.each([
    'Hey! Himanshu here 👋 what did you just grab?',
    "Hey, hi! I'm Himanshu 👋 what did you just get?",
    'hey! what did you end up getting today?',
    'what did you already pick up?',
  ])('reads an order question with an adverb as the order question: %s', (body) => {
    expect(classifyFirstTouchReply(body).isOrderQuestion).toBe(true)
  })

  // The control that keeps the pattern from swallowing a different intention.
  // "whatever you got" must not read as "what you got".
  it.each([
    'Hey, welcome! how was whatever you got?',
    "hope you enjoyed whatever you grabbed. how'd it go?",
    'how was everything?',
  ])('still does not read a how-was-it question as the order question: %s', (body) => {
    expect(classifyFirstTouchReply(body).isOrderQuestion).toBe(false)
  })
})

// TAC-519: the apology ceiling. The real body that prompted it is the first
// case; the rest fix the boundary so the ceiling stays actionable at n=1 rather
// than firing on any mention of a problem.
describe('carriesApology', () => {
  it('catches the live position-arm body that broke the block restraint', () => {
    const v = classifyFirstTouchReply(
      "ah got it, sorry for the mix-up! glad the Blossom Tonic was good. what's your name, by the way?",
    )
    expect(v.carriesApology).toBe(true)
    expect(v.hasQuestion).toBe(true)
  })

  it.each([
    ['apologies for the confusion, that was our error', true],
    ['my bad, the order was wrong', true],
    // THE CONTRACTION, which is what the pattern matches. This fixture read
    // 'that should not have happened', which matches on \\bmy bad\\b instead, so
    // deleting /shouldn't have/ killed nothing. Found in review.
    ["we shouldn't have let that go out", true],
    ["that's on us, come back and we'll sort it", true],
    ['we messed up the order', true],
    ['sorry about that', true],
  ])('treats %j as apologetic: %s', (body, expected) => {
    expect(classifyFirstTouchReply(body as string).carriesApology).toBe(expected)
  })

  it.each([
    ['open till 3 on Sundays. you nearby?'],
    ['the cortado is great, one of our best'],
    // The GUEST complaining is not the venue apologising. The restraint is about
    // the reply carrying bad news, and this is matched against the reply only.
    ['glad you liked it. what did you get?'],
  ])('does not fire on %j', (body) => {
    expect(classifyFirstTouchReply(body as string).carriesApology).toBe(false)
  })
})
