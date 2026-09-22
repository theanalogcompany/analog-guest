import { describe, expect, it } from 'vitest'
import {
  type BrandPersona,
  BrandPersonaSchema,
  type VenueInfo,
  VenueInfoSchema,
} from '../schemas'
import { composePrompt } from './compose-prompt'
import { FIRST_TOUCH_SIGNAL_LINE } from './prompts/serializers'
import { systemTemplateFor } from './prompts/system-template'
import {
  type GenerateMessageInput,
  type KnowledgeCorpusChunk,
  MESSAGE_CATEGORIES,
  type MessageCategory,
} from './types'

function makePersona(): BrandPersona {
  return BrandPersonaSchema.parse({
    tone: 'warm and direct',
    formality: 'casual',
    speakerFraming: 'venue',
    emojiPolicy: 'never',
    lengthGuide: 'short — 1-2 sentences',
  })
}

function makeVenueInfo(): VenueInfo {
  return VenueInfoSchema.parse({
    address: { line1: '1 Test St', city: 'Test', region: 'CA', postalCode: '94000' },
  })
}

function makeInput(
  overrides: Partial<GenerateMessageInput> = {},
): GenerateMessageInput {
  return {
    category: 'reply',
    persona: makePersona(),
    venueInfo: makeVenueInfo(),
    ragChunks: [],
    runtime: {},
    channel: 'text',
    ...overrides,
  }
}

const exampleChunk: KnowledgeCorpusChunk = {
  id: 'k1',
  text: 'flagship blend story',
  sourceType: 'voicenote_transcript',
  primaryTags: ['sourcing'],
  secondaryTags: ['ethiopia'],
  relevanceScore: 0.7,
}

describe('composePrompt — knowledge block rendering (TAC-242)', () => {
  it('OMITS the ## Venue knowledge block when knowledgeChunks is undefined', () => {
    // undefined = retrieval was gated off (e.g., day_* cron). The block
    // should not appear at all.
    const { systemPrompt } = composePrompt(makeInput({ knowledgeChunks: undefined }))
    expect(systemPrompt).not.toContain('## Venue knowledge')
  })

  it('RENDERS the no-match block when knowledgeChunks is an empty array', () => {
    // [] = retrieval ran but matched nothing. The agent should know it
    // lacked grounding so R9 (admit uncertainty) fires reliably.
    const { systemPrompt } = composePrompt(makeInput({ knowledgeChunks: [] }))
    expect(systemPrompt).toContain('## Venue knowledge')
    expect(systemPrompt).toContain('No specific venue knowledge matched this query')
  })

  it('RENDERS chunks with their primary/secondary tag lines when non-empty', () => {
    const { systemPrompt } = composePrompt(
      makeInput({ knowledgeChunks: [exampleChunk] }),
    )
    expect(systemPrompt).toContain('## Venue knowledge')
    expect(systemPrompt).toContain('[primary: sourcing]')
    expect(systemPrompt).toContain('[secondary: ethiopia]')
    expect(systemPrompt).toContain('> flagship blend story')
    // Non-empty path does not render the no-match framing.
    expect(systemPrompt).not.toContain('No specific venue knowledge matched this query')
  })
})

// ---------------------------------------------------------------------------
// TAC-314: assertions scoped to the ASSEMBLED prompt, not the constant.
// ---------------------------------------------------------------------------
//
// The defect class this guards against: a rule exists, its unit test is green,
// and it never renders on the turn that needed it. TAC-313's price scoping
// lived in NEW_QUESTION_INSTRUCTIONS with a passing test while the price
// leaked on a `reply` turn — the test was scoped to the wrong layer, and green
// was a stronger signal than absent. These tests check the string the model
// actually receives.

// The three categories from the TAC-314 UAT table: the two that failed and the
// one that passed. The promoted rules must render on ALL of them.
const UAT_CATEGORIES = ['reply', 'recommendation_request', 'new_question'] as const

function systemPromptFor(category: MessageCategory): string {
  return composePrompt(makeInput({ category })).systemPrompt
}

describe('composePrompt — promoted universal rules render on every category (TAC-314)', () => {
  it.each(UAT_CATEGORIES)('price scoping (R17) renders for %s', (category) => {
    expect(systemPromptFor(category)).toContain(
      'Price is not part of an answer unless the guest asked',
    )
  })

  it.each(UAT_CATEGORIES)('nearby-places carve-out (R18) renders for %s', (category) => {
    expect(systemPromptFor(category)).toContain(
      "speak with the same confidence you'd use about the menu",
    )
  })

  it.each(UAT_CATEGORIES)('mirroring (R19) and length authority (R20) render for %s', (category) => {
    const prompt = systemPromptFor(category)
    expect(prompt).toContain('Match the register and length of what the guest sent')
    expect(prompt).toContain('only authority on how long a message should be')
  })

  it('category instructions still render after the universal block, per assembly order', () => {
    // The layering TAC-314 legislates for: universal rules render, then the
    // category block. Position is the whole reason the strip mattered — a
    // form directive in the later block outranks everything above it.
    const prompt = systemPromptFor('recommendation_request')
    const universalIdx = prompt.indexOf('# Universal voice rules')
    const categoryIdx = prompt.indexOf(
      '## Category-specific instructions: recommendation_request',
    )
    expect(universalIdx).toBeGreaterThan(-1)
    expect(categoryIdx).toBeGreaterThan(universalIdx)
  })

  // TAC-314 second round: R22 promoted the jurisdictional carve-out sentence
  // out of acknowledgment.ts (added by TAC-330 case 2) into the universal
  // layer. The sentence had only ever rendered on `acknowledgment` turns;
  // the point of promoting it is that it now protects every category from
  // the same silent-veto failure class TAC-327/TAC-330 found. `acknowledgment`
  // itself is asserted alongside a category the sentence never used to touch
  // (`reply`) so a regression that scopes it back to one category fails here.
  it.each([...UAT_CATEGORIES, 'acknowledgment'] as const)(
    'goal-state authority carve-out (R22) renders for %s',
    (category) => {
      expect(systemPromptFor(category)).toContain(
        "never authority over whether you act on an open goal from the ## What you're hoping to get to block",
      )
    },
  )

  it('the assembled prompt carries no length directive after the category heading', () => {
    // End-to-end statement of the governing principle: whatever renders after
    // the category heading — the most proximate text the model reads — must
    // not carry a length or sentence-count prescription.
    for (const category of UAT_CATEGORIES) {
      const prompt = systemPromptFor(category)
      const tail = prompt.slice(prompt.indexOf('## Category-specific instructions:'))
      expect(tail).not.toMatch(
        /keep it short|short sentences? total|one short (line|message)|stay short|at or below the length/i,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// TAC-417: recommendation-request references known order history.
// ---------------------------------------------------------------------------
//
// A returning guest asking "what should I get" got a first-visit reply even
// though their order history was in the prompt the whole time. Both halves
// have to be checked together against the ASSEMBLED prompt: the category
// instruction telling the model to use the history (system prompt), and the
// history itself actually reaching the model (user prompt). Checking either
// alone would pass while the other regressed — the exact shape of the
// original defect (the block rendered; nothing pointed at it).

describe('composePrompt — recommendation-request references known order history (TAC-417)', () => {
  it('a returning guest with real order history gets both the instruction and the block', () => {
    const { systemPrompt, userPrompt } = composePrompt(
      makeInput({
        category: 'recommendation_request',
        runtime: {
          recentVisits: [{ items: ['cortado'], visitedAt: new Date() }],
        },
      }),
    )

    // The instruction reaches the model.
    expect(systemPrompt).toContain('## Category-specific instructions: recommendation_request')
    expect(systemPrompt).toContain('"## Visit history"')
    expect(systemPrompt).toContain("Say so in one short clause naming what they've had")

    // The history it's being told to use actually reached the model too —
    // this is the half that fails if the plumbing regresses even though the
    // instruction text is untouched.
    expect(userPrompt).toContain('## Visit history')
    expect(userPrompt).toContain('cortado')
  })

  it('a genuinely new guest with no history gets no visit-history block to reference or invent', () => {
    const { systemPrompt, userPrompt } = composePrompt(
      makeInput({
        category: 'recommendation_request',
        runtime: {},
      }),
    )

    // The instruction is still present (it's a category constant, not a
    // conditional include) — what must be absent is any data to act on.
    expect(systemPrompt).toContain("don't invent a history they don't have")
    expect(userPrompt).not.toContain('## Visit history')
  })
})

// ---------------------------------------------------------------------------
// TAC-495: the Sendblue channel copy, pinned before Instagram gets its own.
// ---------------------------------------------------------------------------
//
// Every string below was transcribed from origin/main at 40fc720, before
// TAC-495 changed anything, and this block was committed on its own and green
// against that code. They are the SMS copy: correct for a guest who texted a
// phone number, and required to stay byte-identical for one. TAC-495 adds an
// Instagram variant beside each; if any assertion here has to change, the
// Sendblue copy changed, which TAC-495's acceptance criteria forbid.
//
// Literals, not reads of the constants: a test that read SYSTEM_TEMPLATE to
// build its expectation could only confirm the template equals itself.

const SENDBLUE_OPENING_LINE =
  "You work at a hospitality venue (cafe, bakery, restaurant). You communicate with its guests via iMessage, in whatever voice the venue has configured below — its own collective voice, its owner's, or a named staff member's."
const SENDBLUE_REGISTER_LINE = '- Sound like whichever of those would actually text: short, native, human.'
const SENDBLUE_PLAIN_TEXT_RULE =
  '- Plain text suitable for iMessage. No HTML, no markdown formatting in the message body, no headers or bullet points.'
const SENDBLUE_HEADS_UP_EXAMPLES =
  'When your reply offers a comp, hold, or discount, ASK FOR THE HEADS-UP IN THE SAME BREATH AS THE OFFER, in the venue\'s voice. Examples: "comped you an oat latte, give me a heads up when you\'re heading over" / "next one\'s on us. text me when you\'re close." Do NOT ask the heads-up question separately or in a follow-up turn. For recommendations, only ask about arrival if timing actually matters for the item (e.g. "the duck is ready when you are — text me a heads-up if you want it tonight").'
const SENDBLUE_R1 =
  '- Don\'t reference actions the guest didn\'t take. Don\'t say "you tapped in," "thanks for stopping by," or anything that assumes the guest visited, scanned, scheduled, or interacted unless the message itself or the guest\'s history confirms it. If the only signal is an inbound text with no prior context, treat the guest as a new contact and respond accordingly. Exception: when the context says this is the guest\'s first message after they scanned a sign at the venue, treat the channel itself as the shared context: they know which number they just texted and why. Greet them on that basis, without assuming they\'re still on-site. Do not narrate the scan or thank them for it. Everything else in this rule holds: never assume a visit, a tap, or an interaction the message or history doesn\'t confirm.'
const SENDBLUE_R5 =
  '- Never refer guests to alternative channels for things the venue can answer. The guest is already in conversation with the venue. Don\'t tell them to email, call, DM Instagram, or "ask next time you\'re in" for information the agent should be able to answer. Exception: legitimate handoffs to systems we don\'t yet manage (e.g., "for reservations, use Resy" if Resy is the venue\'s booking system). Rule of thumb: if the agent has the data or can ask the operator for it, don\'t push the guest to another channel.'
const SENDBLUE_R32 =
  "- Never tell the guest to send a message, reach out, or get in touch as if that were a separate, future action. They are already texting you, right now, in this thread. If you have a question, ask it directly and expect the answer here. This is different from the alternative-channels rule above, which is about routing the guest elsewhere. Here the guest never left this thread. It also does not restrict inviting them to save this number or text again in the future for a different visit. That is a distinct, legitimate invitation."
const SENDBLUE_OPENER =
  "This is the guest's first message on this number, sent right after they scanned the sign at your pickup counter. They have just ordered and collected it. Say hello. If their message doesn't name a person, say who they've reached as well, even where your voice guidance would otherwise have you hold your name back."
const FIRST_TOUCH_SIGNAL =
  "This is the guest's first message, sent after they scanned your venue's QR sign."
const SENDBLUE_NAMED_PERSON =
  'You are Sana, staff at the venue, texting as yourself. Do not sign messages with your name. You ARE that person, not an outside service representing it.'

// TAC-495: the Instagram variants, transcribed from the wording approved on the
// ticket (2026-09-19), not from the code. Each differs from its SMS twin only in
// the channel phrases; the scope guards in system-template.test.ts and
// serializers.test.ts pin that nothing else moved.
const INSTAGRAM_R1 =
  '- Don\'t reference actions the guest didn\'t take. Don\'t say "you tapped in," "thanks for stopping by," or anything that assumes the guest visited, scanned, scheduled, or interacted unless the message itself or the guest\'s history confirms it. If the only signal is an inbound message with no prior context, treat the guest as a new contact and respond accordingly. Exception: when the context says this is the guest\'s first message after they scanned a sign at the venue, treat the channel itself as the shared context: they know who they just messaged and why. Greet them on that basis, without assuming they\'re still on-site. Do not narrate the scan or thank them for it. Everything else in this rule holds: never assume a visit, a tap, or an interaction the message or history doesn\'t confirm.'
const INSTAGRAM_R5 =
  '- Never refer guests to alternative channels for things the venue can answer. The guest is already in conversation with the venue. Don\'t tell them to email, call, text, or "ask next time you\'re in" for information the agent should be able to answer. Exception: legitimate handoffs to systems we don\'t yet manage (e.g., "for reservations, use Resy" if Resy is the venue\'s booking system). Rule of thumb: if the agent has the data or can ask the operator for it, don\'t push the guest to another channel.'
const INSTAGRAM_R32 =
  '- Never tell the guest to send a message, reach out, or get in touch as if that were a separate, future action. They are already messaging you, right now, in this thread. If you have a question, ask it directly and expect the answer here. This is different from the alternative-channels rule above, which is about routing the guest elsewhere. Here the guest never left this thread. It also does not restrict inviting them to message again in the future for a different visit. That is a distinct, legitimate invitation.'
const INSTAGRAM_OPENING_LINE =
  "You work at a hospitality venue (cafe, bakery, restaurant). You communicate with its guests through Instagram messages, in whatever voice the venue has configured below — its own collective voice, its owner's, or a named staff member's."
const INSTAGRAM_REGISTER_LINE = '- Sound like whichever of those would actually message: short, native, human.'
const INSTAGRAM_PLAIN_TEXT_RULE =
  '- Plain text. No HTML, no markdown formatting in the message body, no headers or bullet points.'
const INSTAGRAM_HEADS_UP_EXAMPLES =
  'When your reply offers a comp, hold, or discount, ASK FOR THE HEADS-UP IN THE SAME BREATH AS THE OFFER, in the venue\'s voice. Examples: "comped you an oat latte, give me a heads up when you\'re heading over" / "next one\'s on us. message me when you\'re close." Do NOT ask the heads-up question separately or in a follow-up turn. For recommendations, only ask about arrival if timing actually matters for the item (e.g. "the duck is ready when you are — send me a heads-up if you want it tonight").'
const INSTAGRAM_NAMED_PERSON =
  'You are Sana, staff at the venue, messaging as yourself. Do not sign messages with your name. You ARE that person, not an outside service representing it.'
// The last two lines ruled on (2026-09-19). SMS transcribed from 40fc720;
// Instagram from the approved wording.
const SENDBLUE_UNKNOWN_CLOSE = 'It should sound like a real busy person texting back in their own natural voice.'
const INSTAGRAM_UNKNOWN_CLOSE = 'It should sound like a real busy person messaging back in their own natural voice.'
const SENDBLUE_CASUAL_FORMALITY =
  'casual — Use contractions; lowercase starts are fine; write the way you would text a friend.'
const INSTAGRAM_CASUAL_FORMALITY =
  'casual — Use contractions; lowercase starts are fine; write the way you would message a friend.'
const INSTAGRAM_OPENER =
  "This is the guest's first message, sent right after they scanned the sign at your pickup counter. They have just ordered and collected it. Say hello. If their message doesn't name a person, say who they've reached as well, even where your voice guidance would otherwise have you hold your name back."

function firstTouchInput(overrides: Partial<GenerateMessageInput> = {}): GenerateMessageInput {
  return makeInput({
    // Explicit, not inherited from makeInput: this is the Sendblue fixture,
    // and the pins below are the proof that a Sendblue guest still gets the
    // Sendblue copy.
    channel: 'text',
    persona: BrandPersonaSchema.parse({
      tone: 'warm and direct',
      formality: 'casual',
      speakerFraming: 'named_person',
      speakerName: 'Sana',
      emojiPolicy: 'never',
      lengthGuide: 'short',
    }),
    runtime: {
      inboundMessage: 'Hi Sana!',
      mechanics: [],
      openIntentions: ["You haven't heard what this guest ordered yet."],
      firstTouchAfterQrScan: true,
    },
    ...overrides,
  })
}

describe('composePrompt — Sendblue channel copy is pinned (TAC-495)', () => {
  it('the system prompt carries the Sendblue opening line, plain-text rule and heads-up examples', () => {
    const { systemPrompt } = composePrompt(firstTouchInput())
    expect(systemPrompt.startsWith(`${SENDBLUE_OPENING_LINE}\n`)).toBe(true)
    expect(systemPrompt).toContain(`\n${SENDBLUE_REGISTER_LINE}\n`)
    expect(systemPrompt).toContain(`\n${SENDBLUE_PLAIN_TEXT_RULE}\n`)
    expect(systemPrompt).toContain(`\n${SENDBLUE_HEADS_UP_EXAMPLES}\n`)
  })

  it('the system prompt carries the Sendblue R1, R5 and R32', () => {
    const { systemPrompt } = composePrompt(firstTouchInput())
    expect(systemPrompt).toContain(`\n${SENDBLUE_R1}\n`)
    expect(systemPrompt).toContain(`\n${SENDBLUE_R5}\n`)
    expect(systemPrompt).toContain(`\n${SENDBLUE_R32}\n`)
  })

  it('the persona block carries the Sendblue named-speaker line', () => {
    const { systemPrompt } = composePrompt(firstTouchInput())
    expect(systemPrompt).toContain(SENDBLUE_NAMED_PERSON)
  })

  it('the user prompt carries the Sendblue opener and the first-touch signal line', () => {
    const { userPrompt } = composePrompt(firstTouchInput())
    expect(userPrompt).toContain(`\n${SENDBLUE_OPENER}\n`)
    expect(userPrompt).toContain(`\n${FIRST_TOUCH_SIGNAL}\n`)
  })
})

describe('composePrompt — each channel gets its own channel copy (TAC-495)', () => {
  it('an Instagram conversation gets the Instagram R1, R5 and R32, and none of the SMS ones', () => {
    const { systemPrompt } = composePrompt(firstTouchInput({ channel: 'instagram' }))
    expect(systemPrompt).toContain(`\n${INSTAGRAM_R1}\n`)
    expect(systemPrompt).toContain(`\n${INSTAGRAM_R5}\n`)
    expect(systemPrompt).toContain(`\n${INSTAGRAM_R32}\n`)
    expect(systemPrompt).not.toContain(SENDBLUE_R1)
    expect(systemPrompt).not.toContain(SENDBLUE_R5)
    expect(systemPrompt).not.toContain(SENDBLUE_R32)
  })

  it('an Instagram conversation gets the Instagram opening line, register line, plain-text rule, heads-up examples and persona line', () => {
    const { systemPrompt } = composePrompt(firstTouchInput({ channel: 'instagram' }))
    expect(systemPrompt.startsWith(`${INSTAGRAM_OPENING_LINE}\n`)).toBe(true)
    expect(systemPrompt).toContain(`\n${INSTAGRAM_REGISTER_LINE}\n`)
    expect(systemPrompt).toContain(`\n${INSTAGRAM_PLAIN_TEXT_RULE}\n`)
    expect(systemPrompt).toContain(`\n${INSTAGRAM_HEADS_UP_EXAMPLES}\n`)
    expect(systemPrompt).toContain(INSTAGRAM_NAMED_PERSON)
    for (const sms of [
      SENDBLUE_OPENING_LINE,
      SENDBLUE_REGISTER_LINE,
      SENDBLUE_PLAIN_TEXT_RULE,
      SENDBLUE_HEADS_UP_EXAMPLES,
      SENDBLUE_NAMED_PERSON,
    ]) {
      expect(systemPrompt).not.toContain(sms)
    }
  })

  // AC2, over every prompt an Instagram guest can get: every category, every
  // formality and every speaker framing, system and user prompt. A first
  // version checked one fixture only (a casual 'reply'), and code review found
  // two lines it never rendered (the unknown category's "texting back" and the
  // casual formality line's "text a friend"). Both now have Instagram wording,
  // so no line anywhere may claim the channel.
  it('an Instagram prompt names no iMessage, no phone number and no texting, on any category, formality or framing', () => {
    const CHANNEL_CLAIM =
      /imessage|\bSMS\b|\bphone\b|this number|\btext(s|ing|ed)\b|\ba text\b|\btext (me|us|them|a friend|back)\b|would (actually )?text\b/i
    // Ruled to stay on both channels: R3's rationale explains the em-dash rule
    // and instructs nothing. Only this phrase is exempt; the rest of its line
    // must still claim nothing.
    const SHARED_BY_RULING = ['Em dashes read as AI writing in casual texts']
    const residual = new Set<string>()
    for (const category of MESSAGE_CATEGORIES) {
      for (const formality of ['casual', 'warm', 'formal'] as const) {
        for (const speakerFraming of ['venue', 'named_person', 'owner'] as const) {
          const { systemPrompt, userPrompt } = composePrompt(
            firstTouchInput({
              channel: 'instagram',
              category,
              persona: BrandPersonaSchema.parse({
                tone: 't',
                formality,
                speakerFraming,
                speakerName: 'Sana',
                emojiPolicy: 'frequent',
                lengthGuide: 'short',
              }),
            }),
          )
          for (const line of `${systemPrompt}\n${userPrompt}`.split('\n')) {
            const unruled = SHARED_BY_RULING.reduce((rest, phrase) => rest.replace(phrase, ''), line)
            if (CHANNEL_CLAIM.test(unruled)) residual.add(line)
          }
        }
      }
    }
    expect([...residual]).toEqual([])
  })

  // The two lines ruled on last, on the paths that render them: the unknown
  // category, and a casual venue.
  it('an unknown turn at a casual venue gets the Instagram category close and formality line, and none of the SMS ones', () => {
    const ig = composePrompt(firstTouchInput({ channel: 'instagram', category: 'unknown' })).systemPrompt
    expect(ig).toContain(INSTAGRAM_UNKNOWN_CLOSE)
    expect(ig).toContain(`\n${INSTAGRAM_CASUAL_FORMALITY}\n`)
    expect(ig).not.toContain(SENDBLUE_UNKNOWN_CLOSE)
    expect(ig).not.toContain(SENDBLUE_CASUAL_FORMALITY)
    const sms = composePrompt(firstTouchInput({ channel: 'text', category: 'unknown' })).systemPrompt
    expect(sms).toContain(SENDBLUE_UNKNOWN_CLOSE)
    expect(sms).toContain(`\n${SENDBLUE_CASUAL_FORMALITY}\n`)
    expect(sms).not.toContain(INSTAGRAM_UNKNOWN_CLOSE)
    expect(sms).not.toContain(INSTAGRAM_CASUAL_FORMALITY)
  })

  it('an Instagram conversation gets the Instagram opener, and not the SMS one', () => {
    const { userPrompt } = composePrompt(firstTouchInput({ channel: 'instagram' }))
    expect(userPrompt).toContain(`\n${INSTAGRAM_OPENER}\n`)
    expect(userPrompt).not.toContain(SENDBLUE_OPENER)
  })

  // The other half of AC1, stated the other way round: the Sendblue fixture
  // carries none of the Instagram wording anywhere.
  it('a Sendblue conversation gets none of the Instagram copy', () => {
    const { systemPrompt, userPrompt } = composePrompt(firstTouchInput())
    for (const instagram of [
      INSTAGRAM_R1,
      INSTAGRAM_R5,
      INSTAGRAM_R32,
      INSTAGRAM_OPENING_LINE,
      INSTAGRAM_REGISTER_LINE,
      INSTAGRAM_PLAIN_TEXT_RULE,
      INSTAGRAM_HEADS_UP_EXAMPLES,
      INSTAGRAM_NAMED_PERSON,
    ]) {
      expect(systemPrompt).not.toContain(instagram)
    }
    expect(userPrompt).not.toContain(INSTAGRAM_OPENER)
  })

  // Null is unknown, and gets the copy that asserts no phone number.
  it('an unknown channel gets exactly the Instagram prompts', () => {
    expect(composePrompt(firstTouchInput({ channel: null }))).toEqual(
      composePrompt(firstTouchInput({ channel: 'instagram' })),
    )
  })

  // Nothing outside the channel copy moves: swap the Instagram strings back for
  // the SMS ones and the two conversations' prompts are identical.
  it('the channels differ only in the channel copy', () => {
    const sms = composePrompt(firstTouchInput({ channel: 'text' }))
    const ig = composePrompt(firstTouchInput({ channel: 'instagram' }))
    const backToSms = (s: string) =>
      s
        .replace(INSTAGRAM_R1, SENDBLUE_R1)
        .replace(INSTAGRAM_R5, SENDBLUE_R5)
        .replace(INSTAGRAM_R32, SENDBLUE_R32)
        .replace(INSTAGRAM_OPENER, SENDBLUE_OPENER)
        .replace(INSTAGRAM_OPENING_LINE, SENDBLUE_OPENING_LINE)
        .replace(INSTAGRAM_REGISTER_LINE, SENDBLUE_REGISTER_LINE)
        .replace(INSTAGRAM_PLAIN_TEXT_RULE, SENDBLUE_PLAIN_TEXT_RULE)
        .replace(INSTAGRAM_HEADS_UP_EXAMPLES, SENDBLUE_HEADS_UP_EXAMPLES)
        .replace(INSTAGRAM_NAMED_PERSON, SENDBLUE_NAMED_PERSON)
        .replace(INSTAGRAM_CASUAL_FORMALITY, SENDBLUE_CASUAL_FORMALITY)
        .replace(INSTAGRAM_UNKNOWN_CLOSE, SENDBLUE_UNKNOWN_CLOSE)
    expect(backToSms(ig.systemPrompt)).toBe(sms.systemPrompt)
    expect(backToSms(ig.userPrompt)).toBe(sms.userPrompt)
    const smsUnknown = composePrompt(firstTouchInput({ channel: 'text', category: 'unknown' }))
    const igUnknown = composePrompt(firstTouchInput({ channel: 'instagram', category: 'unknown' }))
    expect(backToSms(igUnknown.systemPrompt)).toBe(smsUnknown.systemPrompt)
    expect(backToSms(igUnknown.userPrompt)).toBe(smsUnknown.userPrompt)
  })
})

// TAC-495: R1's exception in the system prompt applies "when the context says
// this is the guest's first message after they scanned a sign at the venue".
// What says so is the first-touch signal line in the user prompt (and, where it
// renders, the opener's first sentence). Nothing structural links them: the
// model matches the prose. So this holds the pair together, per channel: if
// either side is reworded, this fails and says why, instead of R1's exception
// silently stopping on the turns where the signal line is its only trigger
// (opt_out, comp_complaint, an empty intentions block).
describe('composePrompt — R1 exception and the first-touch signal line move together (TAC-495)', () => {
  const R1_TRIGGER =
    "when the context says this is the guest's first message after they scanned a sign at the venue"

  it.each(['text', 'instagram', null] as const)('on channel %s, both halves render', (channel) => {
    const { systemPrompt, userPrompt } = composePrompt(firstTouchInput({ channel }))
    expect(systemPrompt).toContain(R1_TRIGGER)
    expect(userPrompt).toContain(`\n${FIRST_TOUCH_SIGNAL}\n`)
  })

  // Read from the production strings, not the literals above, so rewording
  // either side fails here.
  it('the signal line carries the words the trigger keys on, on both channels', () => {
    for (const channel of ['text', 'instagram'] as const) {
      const r1 = systemTemplateFor(channel)
        .split('\n')
        .find((line) => line.startsWith("- Don't reference actions the guest didn't take."))
      expect(r1).toBeDefined()
      for (const word of ['first message', 'scanned', 'sign']) {
        expect(r1).toContain(word)
        expect(FIRST_TOUCH_SIGNAL_LINE).toContain(word)
      }
    }
  })

  // The case that makes the signal line load-bearing: on comp_complaint the
  // intentions block (and so the opener) is suppressed, so the signal line is
  // the only thing that can trigger R1's exception.
  it('on a comp_complaint first touch, the signal line still renders without the opener', () => {
    for (const channel of ['text', 'instagram'] as const) {
      const { userPrompt } = composePrompt(firstTouchInput({ channel, category: 'comp_complaint' }))
      expect(userPrompt).toContain(`\n${FIRST_TOUCH_SIGNAL}\n`)
      expect(userPrompt).not.toContain(SENDBLUE_OPENER)
      expect(userPrompt).not.toContain(INSTAGRAM_OPENER)
    }
  })
})

// TAC-484, ruled 2026-09-22. R35 tells the model to correct a message the
// guest has challenged. The hazard is structural rather than semantic:
// `## Category-specific instructions` renders LAST in the system prompt, and
// this repo has a documented history of a later block winning on proximity
// (TAC-314/327/329/330/338). Two category blocks plausibly select a challenge
// turn and point the other way:
//
//   unknown        — "a warm holding response ... will be followed up on".
//                    Reachable BY CONSTRUCTION here: TAC-240 rewrites any
//                    classification below 0.3 confidence to `unknown`, and
//                    "you're confusing me" is exactly that shape.
//   acknowledgment — "This is a close, not an opening ... do not turn the
//                    closer into a fresh exchange." Which is what the
//                    incident's "ignore me, we're good" is.
//
// WHAT THESE TESTS DO AND DO NOT SHOW. They show the rule and its boundary
// clause are PRESENT on those turns, that the category block genuinely renders
// after R35 (so the conflict is real, not hypothetical), and that the clause
// names the shapes those blocks actually use. They cannot show the model obeys
// R35 over the category block. Nothing in CI can: that needs a real
// generation, and it is the QA: Device half of this ticket.
describe('composePrompt — R35 governs a challenge turn whatever category it lands in (TAC-484)', () => {
  const CHALLENGE_CATEGORIES = ['unknown', 'acknowledgment'] as const

  it.each(CHALLENGE_CATEGORIES)('R35 renders for %s', (category) => {
    expect(systemPromptFor(category)).toContain(
      'When a guest questions or pushes back on something you said',
    )
  })

  it.each(CHALLENGE_CATEGORIES)('the boundary clause renders for %s', (category) => {
    expect(systemPromptFor(category)).toContain(
      "A category's register guidance, whether it frames the turn as a close or as a holding response, is never authority over whether you correct the record.",
    )
  })

  it.each(CHALLENGE_CATEGORIES)(
    'the two prohibitions render for %s, so "ignore me, we are good" is banned on this turn',
    (category) => {
      expect(systemPromptFor(category)).toContain(
        'Never invent a reason for what you said, and never tell the guest to disregard it, ignore you, or that everything is fine.',
      )
    },
  )

  // The conflict has to be REAL for the clause to be worth anything: both
  // blocks present, category second. If the category block ever stops
  // rendering after the template, the clause is solving a problem that no
  // longer exists and should be revisited rather than left as noise.
  it.each(CHALLENGE_CATEGORIES)(
    'the %s block really does render after R35, which is why the clause exists',
    (category) => {
      const prompt = systemPromptFor(category)
      const r35 = prompt.indexOf('When a guest questions or pushes back on something you said')
      const categoryBlock = prompt.indexOf('## Category-specific instructions')
      expect(r35).toBeGreaterThan(-1)
      expect(categoryBlock).toBeGreaterThan(r35)
    },
  )

  it('unknown still carries its own holding-response framing, unchanged', () => {
    // R35 does not delete the category's guidance, it subordinates it on one
    // question. If this stops rendering, the clause is arguing with nothing.
    expect(systemPromptFor('unknown')).toContain('warm holding response')
  })

  it('acknowledgment still carries its own close framing, unchanged', () => {
    expect(systemPromptFor('acknowledgment')).toContain('This is a close, not an opening')
  })
})
