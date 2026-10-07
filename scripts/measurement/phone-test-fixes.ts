// Phone test fixes (2026-10-07): the ablation and the generation check for
// items 1, 3, 4 and 5.
//
// GENERATE-ONLY. Nothing is sent and nothing is written, with the exception
// every harness on this path reports on itself: buildRuntimeContext calls
// computeGuestState, which persists a guest_states row on a recognition-band
// change. Context is built once per trigger kind and the row count is printed
// before and after.
//
// EVERY THREAD HERE IS CONSTRUCTED. The phone-test rounds were reset, and the
// one surviving thread is a counter-scan exchange that shows none of the
// defects. The threads below were rebuilt from Jaipal's description of each
// (2026-10-07) and are not replays of stored rows.
//
// ARMS ARE PROMPT TRANSFORMS. An arm is a list of edits applied to the
// composed system or user prompt. An edit to text every prompt carries must
// change the prompt or the unit fails; an edit to text only some prompts carry
// (a category instruction, a block) may find nothing, but an arm in which NO
// edit changed a unit's prompt fails that unit, so a control can never pass as
// a silent copy of the shipped arm. That one mechanism serves both jobs:
//
//   ablation   remove one unit (a rule, a block, a sentence) from the shipped
//              prompt and see whether the defect goes away
//   control    put the shipped prompt back to what it was before this change,
//              so the check has something to disagree with
//
// `shipped` is the prompt as composed, untouched. `control` is that prompt
// with this change's wording taken back out (the earlier text restored), and is
// what the shipped arm is read against. The `abl-` arms are the leave-one-out
// runs that found the causes; several name text this change has since
// replaced and will now refuse to run, which is the guard working. The `cand-`
// and `diag-` arms are wording that is NOT shipped (items 1a and 3).
//
// WHAT IT DOES NOT TAKE FROM PRODUCTION. It calls generateObject itself, so
// the dash/self-talk/link regen loop is bypassed. It classifies each unit once
// per run and reuses the category across that run's reps. An arm is its own
// run, so two arms can land a unit in different categories; the category is
// logged on every unit so that can be seen. Bodies are hand-read; the detectors only narrow
// the reading and are deliberately wide.
//
// A FAILED UNIT IS NOT A RESULT (scripts/CLAUDE.md, convention 5). Any
// generation error voids its cell.

import { randomUUID } from 'node:crypto'

import { generateObject } from 'ai'

import type {
  KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
  MessageCategory,
  RecentMessage,
} from '@/lib/ai/types'
import { getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  composeReplyWithIntention,
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
} from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'
import { createRunLog } from './run-log'

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

interface Transform {
  label: string
  target: 'system' | 'user'
  apply: (prompt: string) => string
  /** A transform that may legitimately find nothing on some units. */
  optional?: boolean
}

/** Remove the one line that starts with `prefix`. */
function dropLine(
  target: Transform['target'],
  label: string,
  prefix: string,
): Transform {
  return {
    label,
    target,
    apply: (p) =>
      p
        .split('\n')
        .filter((line) => !line.startsWith(prefix))
        .join('\n'),
  }
}

function swap(
  target: Transform['target'],
  label: string,
  from: string,
  to: string,
  optional = false,
): Transform {
  return { label, target, apply: (p) => p.replace(from, to), optional }
}

/** Remove a `## Heading` block from the user prompt, up to the next heading. */
function dropBlock(label: string, heading: string): Transform {
  return {
    label,
    target: 'user',
    optional: true,
    apply: (p) => {
      const start = p.indexOf(heading)
      if (start === -1) return p
      const next = p.indexOf('\n## ', start + heading.length)
      return next === -1
        ? p.slice(0, start)
        : p.slice(0, start) + p.slice(next + 1)
    },
  }
}

/** Add a block at the end of the user prompt's blocks, before the closing lines. */
function insertUserBlock(label: string, block: string): Transform {
  const anchors = ['\n\nThe guest just sent:', '\n\nGenerate ']
  return {
    label,
    target: 'user',
    apply: (p) => {
      const anchor = anchors.find((a) => p.includes(a))
      if (anchor === undefined) return p
      const at = p.lastIndexOf(anchor)
      return `${p.slice(0, at)}\n\n${block}${p.slice(at)}`
    },
  }
}

const GREETING_RULE = '- Do not name a specific product (a drink, a bean'
const MIRROR_RULE = '- Match the register and length of what the guest sent.'
const REPEAT_RULE = '- A greeting, a question about the guest, a check-in'

// ---------------------------------------------------------------------------
// The wording under test. Restated here rather than imported from the prompt:
// importing would make the control arm agree with whatever the prompt says,
// including a typo. `before` is the text this change replaced, `after` is
// this change's.
// ---------------------------------------------------------------------------

const RULES_END = '\n\n# Voice imperative'

const RULE_OFFER =
  '- Whether a reply ends by offering more help is decided by what the answer did, not by its topic. When your answer sent the guest a link, made a recommendation or helped them choose between things, or walked them through how to do something, end with one short, light line saying you are happy to answer anything else about it. When your answer was a single fact, like an hour, a price, an address or a yes or no, give the fact and stop, with no offer after it. The offer is a statement and not a question, it is about the thing you just helped with, and it is worded differently each time: look at what you have already sent this guest and do not reuse an offer you have made. This is not the closing sentence the rule on recommendations above forbids, which is about praising the thing; this line says nothing about how good anything is. It is not telling the guest to get in touch either, which the rule above on that forbids: it leaves the door open in this thread and asks for nothing. Leave it off a complaint turn, a sign-off, any reply that already asks the guest something, and any turn where you are putting a question in intentionQuestion.'

const RULE_APOLOGY =
  '- Apologise for a thing once. If your last reply to this guest already opened with an apology, do not open this one with another, in the same words or in different ones. The apology has been made. Start with what is new instead: the answer, the next step, or what you are doing about it. A new problem the guest raises is a new thing and gets its own apology, once. This is separate from the rule above on repeating a line, which is about wording; this one is about not apologising again at all.'

const RULE_SELF_CORRECTION =
  "- When a guest corrects something they themselves told you, like saying it was a different place or that they mixed something up, the slip is theirs and it is a small one. Take the correction lightly and move on in one short line. Do not apologise, do not call it your mistake or the venue's, and do not make anything of it. This is separate from the rule above on a guest questioning something you said: that one is about your own earlier message, and there you do own an error. Here nothing you said was wrong. A guest who only says they have never been here, without saying they got something wrong, has not corrected themselves yet: # A visit the guest takes back covers that turn, and its one gentle check comes first."

interface WordingEdit {
  label: string
  target: Transform['target']
  before: string
  after: string
  /** True when the text is not in every unit's prompt (a category, a block). */
  optional?: boolean
}

const appendRule = (label: string, rule: string): WordingEdit => ({
  label,
  target: 'system',
  before: RULES_END,
  after: `\n${rule}${RULES_END}`,
})

const CLOSE_BEFORE_HEAD =
  'The conversation has reached a natural pause. Close it warmly and leave\nthe door open: they can message here anytime.'
const CLOSE_BEFORE_GUIDE =
  " This is what this venue's close usually covers, as a guide to its content and not as words to reuse: "
const CLOSE_BEFORE_TAIL =
  'Say it in your own words, different from anything you have already sent\nthis guest. A soft hope to see them again is fine. Do not invite them in\nfor anything specific, and do not name any item they did not mention\nthemselves. Ask nothing.'

// The approved first part plus one sentence: asked for a line about what was
// talked about, two of the first ten closes answered the question again or
// placed the guest inside the venue.
const CLOSE_AFTER_HEAD =
  'The conversation has reached a natural pause. Close it in two short\nparts. First, one line that belongs to this conversation: something warm\nabout what you and this guest actually talked about, or a soft hope to\nsee them again. It does not repeat an answer you already gave, and it\ndoes not assume they are at the venue or have been in. Then a light open\ndoor: they can message here anytime with other questions, with two or\nthree examples of what they might ask about.'

const CLOSE_AFTER_GUIDE =
  " Take those examples from what this venue's close usually covers, leaning on the menu, events and recommendations where it has them, choosing different ones each time and never reusing its words: "
const CLOSE_AFTER_TAIL =
  'Say all of it in your own words, different from anything you have\nalready sent this guest. Do not include a link and do not ask for a\nreview. Do not invite them in for anything specific, and do not name any\nitem they did not mention themselves. Ask nothing.'

const EDITS = {
  '1a': [appendRule('offer rule', RULE_OFFER)],
  '1b': [
    {
      label: 'greeting invitation',
      target: 'system',
      before: ' Reply in kind and stop.',
      after:
        ' When that message is a greeting, greet them back warmly and ask how you can help or what they are looking for, in one short line, and stop there. They are messaging you, not standing at the counter, so do not ask what you can get them or what they would like: that is taking an order. Say it your own way rather than reaching for a stock phrase. When it is anything else with no content of its own, reply in kind and stop.',
    },
    // The half the ablation found: the first-conversation block outranks the
    // rule above, so the rule alone moved 4 of 10 and this took it to 10.
    {
      label: 'no-questions exception',
      target: 'user',
      before:
        'exception is a question another block in this prompt tells you to ask.',
      after:
        'exception is a question another block in this prompt tells you to ask.\nInviting a guest who has only said hello to say what they need is not a\nquestion of your own, and is welcome.',
      optional: true,
    },
    {
      label: 'first-conversation exception',
      target: 'user',
      before: 'line above fits.',
      after:
        'line above fits.\nInviting a guest who has only said hello to say what they need is not a\nquestion of your own, and is welcome.',
      optional: true,
    },
  ],
  '3-rule': [appendRule('apology rule', RULE_APOLOGY)],
  '3-category': [
    {
      label: 'category: already said sorry',
      target: 'system',
      before: 'say sorry for it, once, and mean it.',
      after:
        'say sorry for it, once, and mean it. If you have already said sorry for this in an earlier message, do not say it again.',
      optional: true,
    },
  ],
  '4': [
    appendRule('self-correction rule', RULE_SELF_CORRECTION),
    {
      label: 'take-back section',
      target: 'system',
      before:
        'The first time this happens, set it to "checking" and make the reply one gentle check in the guest\'s own words, the way a friend who half remembers would: "oh wait, didn\'t you mention a cold latte earlier? or was that somewhere else?" is the shape. Ask it once and ask nothing else.\nIf you already asked that and the guest confirms they have not been here, set it to "retracted". Believe them plainly and move on in one short line. Do not explain, and do not ask them anything. Anything the venue already offered them still stands: do not take it back, and leave cancelsCommitmentId empty.',
      after:
        'If the guest says outright that they got it wrong, like that it was a different place or the wrong cafe, there is nothing to check: set it to "retracted" straight away.\nIf they only say something that does not fit, like that they have never been here, without saying they got anything wrong, then the first time this happens set it to "checking" and make the reply one gentle check in the guest\'s own words, the way a friend who half remembers would: "oh wait, didn\'t you mention a cold latte earlier? or was that somewhere else?" is the shape. Ask it once and ask nothing else.\nIf you already asked that and the guest confirms they have not been here, set it to "retracted".\nWhenever you set "retracted", believe them plainly and move on in one short line, with no apology: nothing you said was wrong. Do not explain, and do not ask them anything. Anything the venue already offered them still stands: do not take it back, and leave cancelsCommitmentId empty.',
    },
  ],
  '5': [
    {
      label: 'close head',
      target: 'user',
      before: CLOSE_BEFORE_HEAD,
      after: CLOSE_AFTER_HEAD,
      optional: true,
    },
    {
      label: 'close guide',
      target: 'user',
      before: CLOSE_BEFORE_GUIDE,
      after: CLOSE_AFTER_GUIDE,
      optional: true,
    },
    {
      label: 'close tail',
      target: 'user',
      before: CLOSE_BEFORE_TAIL,
      after: CLOSE_AFTER_TAIL,
      optional: true,
    },
  ],
} as const satisfies Record<string, readonly WordingEdit[]>

/** Apply the new wording to a prompt that does not have it yet. */
const forward = (edits: readonly WordingEdit[]): Transform[] =>
  edits.map((e) => swap(e.target, e.label, e.before, e.after, e.optional))

/** Take the new wording back out of a prompt that ships it. */
const reverse = (edits: readonly WordingEdit[]): Transform[] =>
  [...edits]
    .reverse()
    .map((e) => swap(e.target, e.label, e.after, e.before, e.optional))

// The venue's own persona text. Not ours to edit in this change, but it has to
// be ruled in or out as a cause.
const DROP_PERSONA_COMPLAINT_LINE: Transform = {
  label: 'persona complaint line',
  target: 'system',
  apply: (p) =>
    p
      .split('\n')
      .filter((line) => !line.includes('we own it plainly'))
      .join('\n'),
}
const DROP_PERSONA_LENGTH: Transform = {
  label: 'persona length section',
  target: 'system',
  apply: (p) => p.replace(/## Length\n[^\n]*\n/, ''),
}
const DROP_LENGTH_RULE = dropLine(
  'system',
  'length authority rule',
  '- The ## Length section below is the only authority',
)

/** What v1.95.0 ships. Items 1a and 3 are not in it. */
const SHIPPED = [...EDITS['1b'], ...EDITS['4'], ...EDITS['5']]

const ARMS: Record<string, readonly Transform[]> = {
  shipped: [],
  control: reverse(SHIPPED),
  // Candidate wording applied to a prompt that does not ship it yet.
  'cand-1a': forward(EDITS['1a']),
  'cand-3-rule': forward(EDITS['3-rule']),
  'cand-3': forward([...EDITS['3-rule'], ...EDITS['3-category']]),
  // The candidate with one more unit removed: what is still holding it back?
  'cand-1a+length-section': [...forward(EDITS['1a']), DROP_PERSONA_LENGTH],
  'cand-1a+length-rule': [...forward(EDITS['1a']), DROP_LENGTH_RULE],
  'cand-1a+length-both': [
    ...forward(EDITS['1a']),
    DROP_PERSONA_LENGTH,
    DROP_LENGTH_RULE,
  ],
  'cand-1a+mirror-rule': [
    ...forward(EDITS['1a']),
    dropLine('system', 'mirror rule', MIRROR_RULE),
  ],
  'cand-1a+closer-rule': [
    ...forward(EDITS['1a']),
    dropLine(
      'system',
      'closer rule',
      '- When delivering a recommendation, a description, or a fact',
    ),
  ],
  'cand-1a+no-cta': [
    ...forward(EDITS['1a']),
    swap('system', 'no calls-to-action', ', no calls-to-action.', '.'),
  ],
  // DIAGNOSTICS, not candidates: the same instruction moved from the rule list
  // to a block at the end of the user prompt, to separate "the wording does
  // not work" from "the wording is too far from the generate line".
  'diag-1a-block': [
    insertUserBlock(
      'offer block',
      `## Offering more help\n\n${RULE_OFFER.slice(2)}`,
    ),
  ],
  'diag-3-block': [
    insertUserBlock(
      'apology block',
      '## You have already apologised\n\nYou have already said sorry to this guest for this, earlier in this conversation. Do not apologise again, and do not say again whose fault it was. Start with what is new: the answer, the next step, or what you are doing about it. If they raise a different problem, that one gets its own apology, once.',
    ),
  ],
  'cand-3+persona-own-it': [
    ...forward([...EDITS['3-rule'], ...EDITS['3-category']]),
    DROP_PERSONA_COMPLAINT_LINE,
  ],
  // Item 1b: what stops a "hi" getting an invitation?
  'abl-greeting-rule': [dropLine('system', 'greeting rule', GREETING_RULE)],
  'abl-reply-in-kind': [
    swap('system', 'reply in kind', ' Reply in kind and stop.', ''),
  ],
  'abl-no-questions-block': [
    dropBlock('no-questions block', '## No questions this turn'),
  ],
  'abl-mirror-rule': [dropLine('system', 'mirror rule', MIRROR_RULE)],
  'abl-no-cta': [
    swap('system', 'no calls-to-action', ', no calls-to-action.', '.'),
  ],
  // Item 3: what makes each reply open with an apology?
  'abl-category-sorry': [
    swap(
      'system',
      'category sorry',
      'Once you understand it, say sorry for it, once, and mean it. Then find',
      'Once you understand it, find',
      true,
    ),
  ],
  'abl-persona-own-it': [DROP_PERSONA_COMPLAINT_LINE],
  'abl-repeat-rule': [dropLine('system', 'repeat rule', REPEAT_RULE)],
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

type Line = readonly ['in' | 'out', string]

interface Unit {
  id: string
  /** Earlier messages, oldest first. Timestamps are assigned two minutes apart. */
  history: readonly Line[]
  /** The guest's message this turn. Absent on the pause-timer close. */
  inbound?: string
  reportedItems?: readonly string[]
}

interface Cell {
  id: string
  what: string
  /** `close` is the pause-timer sign-off; everything else is an inbound turn. */
  kind: 'inbound' | 'close'
  /** A guest whose first contact was days ago, so no first-conversation gating. */
  established: boolean
  units: readonly Unit[]
}

const u = (
  id: string,
  inbound: string,
  history: readonly Line[] = [],
): Unit => ({
  id,
  inbound,
  history,
})

/** One apology sent, as a clarifying question. The reply under test is the second. */
const COMPLAINT_ASKED: readonly Line[] = [
  ['in', 'my latte was cold when i got it today'],
  [
    'out',
    "so sorry about that, that's not how it should come out. was it cold right when you picked it up?",
  ],
]

/** Two apologies sent. The reply under test is the third. */
const COMPLAINT_ANSWERED: readonly Line[] = [
  ...COMPLAINT_ASKED,
  ['in', 'yeah right away'],
  [
    'out',
    "really sorry, that shouldn't happen. come back in and we'll make you a fresh one on us",
  ],
]

/** The gentle check already asked (TAC-573); the guest's answer is under test. */
const RETRACTION_CHECKED: readonly Line[] = [
  ['in', 'had a cold brew at yours this morning, so good'],
  ['out', 'love to hear that'],
  ['in', "what are your hours? i've never actually been in"],
  [
    'out',
    "oh wait, didn't you mention a cold brew earlier? or was that somewhere else?",
  ],
]

/** No check asked: the guest takes the visit back unprompted. */
const RETRACTION_UNPROMPTED: readonly Line[] = [
  ['in', 'had a cold brew at yours this morning, so good'],
  ['out', 'love to hear that. glad the cold brew hit the spot'],
]

const CLOSE_EXCHANGES: readonly Line[][] = [
  [
    ['in', 'what time do you close today?'],
    ['out', "we're open till 3 today"],
  ],
  [
    ['in', 'do you have oat milk?'],
    ['out', 'yep, oat and almond'],
  ],
  [
    ['in', 'is there wifi?'],
    ['out', 'there is, the password is on the counter'],
  ],
  [
    ['in', 'can i bring my dog?'],
    ['out', 'dogs are welcome out front'],
  ],
  [
    ['in', 'do you sell beans to take home?'],
    ['out', 'we do, bags are on the shelf by the door'],
  ],
  [
    ['in', 'is there parking nearby?'],
    ['out', 'street parking, usually easy before noon'],
  ],
  [
    ['in', 'do you take card?'],
    ['out', 'card and tap, yes'],
  ],
  [
    ['in', 'anything decaf?'],
    ['out', 'yes, any espresso drink can be decaf'],
  ],
  [
    ['in', 'are you open on sundays?'],
    ['out', 'we are, same hours'],
  ],
  [
    ['in', 'do you have somewhere to sit and work?'],
    ['out', 'a few tables inside, quieter after lunch'],
  ],
]

const CELLS: readonly Cell[] = [
  {
    id: '1-offer',
    what: 'answers that send a link, recommend, help choose, or give instructions',
    kind: 'inbound',
    established: true,
    units: [
      u('menu-link', 'can you send me the menu?'),
      u('shop-link', 'do you have an online shop?'),
      u('rec-first', "what should i get? haven't tried much here"),
      u('rec-beans', 'which beans would you get for pour over?'),
      u('choose', "can't decide between the cortado and the flat white"),
      u('brew', 'how should i brew your beans at home?'),
      u('order-online', 'how do i order beans online?'),
      u('catering', 'do you do catering?'),
      u('wholesale', 'do you sell wholesale?'),
      u('events', 'any events coming up?'),
    ],
  },
  {
    id: '1-fact',
    what: 'single-fact answers',
    kind: 'inbound',
    established: true,
    units: [
      u('close-today', 'what time do you close today?'),
      u('sunday', 'are you open sunday?'),
      u('price', 'how much is a cortado?'),
      u('parking', 'is there parking?'),
      u('address', "what's your address?"),
      u('wifi', 'do you have wifi?'),
      u('dogs', 'can i bring my dog?'),
      u('oat', 'do you have oat milk?'),
      u('card', 'do you take card?'),
      u('open-tomorrow', 'what time do you open tomorrow?'),
    ],
  },
  {
    id: '1-greeting',
    what: 'a bare greeting from a guest with no history (constructed from the phone test)',
    kind: 'inbound',
    established: false,
    units: [
      u('hi', 'hi'),
      u('hey', 'hey'),
      u('hello', 'hello'),
      u('hi-there', 'hi there'),
      u('heyy', 'heyy'),
    ],
  },
  {
    id: '3-apology',
    what: 'the next reply in a complaint thread that has already apologised (constructed)',
    kind: 'inbound',
    established: true,
    units: [
      u('answer-1', 'yeah right away', COMPLAINT_ASKED),
      u('answer-2', 'yes, straight from the counter', COMPLAINT_ASKED),
      u('still-1', 'honestly it was barely warm at all', COMPLAINT_ANSWERED),
      u('still-2', 'yeah it was just disappointing', COMPLAINT_ANSWERED),
      u('logistics', 'can i come by saturday instead?', COMPLAINT_ANSWERED),
    ],
  },
  {
    id: '4-selfcorrect',
    what: 'the guest takes back a visit they reported (constructed)',
    kind: 'inbound',
    established: true,
    units: [
      { inbound: 'yeah, different place', history: RETRACTION_CHECKED },
      {
        inbound: 'oh yeah that was somewhere else',
        history: RETRACTION_CHECKED,
      },
      { inbound: 'sorry that was another cafe', history: RETRACTION_CHECKED },
      {
        inbound: 'oh wait, that was a different place actually',
        history: RETRACTION_UNPROMPTED,
      },
      {
        inbound: 'ah sorry i mixed you up with somewhere else',
        history: RETRACTION_UNPROMPTED,
      },
    ].map((x, i) => ({
      id: `takeback-${i + 1}`,
      ...x,
      reportedItems: ['cold brew'],
    })),
  },
  {
    id: '4-vague',
    what: 'the guest only says they have never been in, no check asked yet (constructed)',
    kind: 'inbound',
    established: true,
    units: [
      "wait, i've never actually been to yours",
      "i haven't been in before though",
      'never been there tbh',
      "hm i don't think i've ever come in",
      "i've never been to le mil's",
    ].map((inbound, i) => ({
      id: `never-${i + 1}`,
      inbound,
      history: RETRACTION_UNPROMPTED,
      reportedItems: ['cold brew'],
    })),
  },
  {
    id: '5-close',
    what: 'the pause-timer close with no link',
    kind: 'close',
    established: false,
    units: CLOSE_EXCHANGES.map((history, i) => ({
      id: `close-${String(i + 1).padStart(2, '0')}`,
      history,
    })),
  },
]

// ---------------------------------------------------------------------------
// Detectors. Wide on purpose; every body is printed to be read.
// ---------------------------------------------------------------------------

const fold = (s: string): string => s.toLowerCase().replace(/[‘’]/g, "'")

const APOLOGY = /\b(sorry|apolog\w*|my bad|our bad|our mistake|my mistake)\b/
const OWNS_MISTAKE =
  /\b(our mistake|my mistake|our bad|my bad|on us|on me|our end|my end|our fault|my fault|mix-?up on)\b/
const OFFER =
  /\b(let (me|us) know|happy to|here if|any(thing| other) (else|questions?)|questions? about|just (ask|say)|shout|holler|ask away|reach)\b/
const INVITE =
  /(\?|\b(let (me|us) know|what can|how can|anything (you|we|i)|here (if|for)|just (ask|say)|ask away|fire away)\b)/

function firstSentence(body: string): string {
  return body.split(/(?<=[.!?])\s+|\n/)[0] ?? body
}

function detect(body: string): Record<string, boolean> {
  const b = fold(body)
  return {
    opensWithApology: APOLOGY.test(fold(firstSentence(body))),
    anyApology: APOLOGY.test(b),
    ownsMistake: OWNS_MISTAKE.test(b),
    offer: OFFER.test(b),
    invite: INVITE.test(b),
    question: b.includes('?'),
    link: /https?:\/\/|www\./.test(b),
  }
}

// ---------------------------------------------------------------------------

// `new` unless MEASURE_BAND says otherwise, which is a probe and never the check.
const BANDS = ['new', 'returning', 'regular', 'raving_fan'] as const
const BAND = BANDS.find((b) => b === (process.env.MEASURE_BAND ?? 'new'))
if (BAND === undefined) {
  throw new Error(`MEASURE_BAND must be one of: ${BANDS.join(', ')}`)
}

type BaseCtx = Awaited<ReturnType<typeof buildRuntimeContext>>

function toHistory(lines: readonly Line[], endsAt: Date): RecentMessage[] {
  return lines.map(([dir, body], i) => ({
    direction: dir === 'in' ? 'inbound' : 'outbound',
    body,
    createdAt: new Date(endsAt.getTime() - (lines.length - i) * 120_000),
    delivery: 'delivered',
  })) as RecentMessage[]
}

function unitContext(
  base: BaseCtx,
  cell: Cell,
  unit: Unit,
  now: Date,
): RuntimeContext {
  // The close fires after the venue's pause; an inbound turn follows the
  // thread directly.
  const historyEnd =
    cell.kind === 'close' ? new Date(now.getTime() - 10 * 60_000) : now
  const firstContact = cell.established
    ? new Date(now.getTime() - 3 * 24 * 60 * 60_000)
    : new Date(now.getTime() - 20 * 60_000)
  return {
    ...base,
    guest: {
      ...base.guest,
      firstName: null,
      context: toParsedGuestContext({}, now),
      createdAt: firstContact,
      firstContactedAt: firstContact,
      reviewAskedAt: null,
    },
    currentMessage:
      unit.inbound === undefined
        ? null
        : {
            id: randomUUID(),
            providerMessageId: `phone-test-${cell.id}-${unit.id}`,
            body: unit.inbound,
            receivedAt: now,
            channel: 'instagram',
            referralSource: null,
          },
    recentMessages: toHistory(unit.history, historyEnd),
    // NOTHING OF THE REAL GUEST'S (the TAC-575 contamination: a leaked open
    // comp reached a ruling).
    recentVisits: [],
    // The base guest's band rides into the prompt as `Guest relationship:`.
    // Left alone it was `returning`, and ten of ten bare greetings from a
    // "new" guest came back "welcome back". No constructed guest here has a
    // visit, so every one is `new`.
    recognition: { ...base.recognition, state: BAND },
    activeCommitments: [],
    mechanics: [],
    openIntentions: [],
    pendingQuestion: null,
    reviewAsk: null,
    scanArrival: null,
    inquiryFollowup: null,
    visitCheckback: false,
    visitCheckin: null,
    visitCheckinHold: false,
    insideVisitCheckin: false,
    complaintFollowup: null,
    reOptIn: null,
    inboundMedia: null,
    visitLocalDate: null,
    // The base guest may be inside the quiet that follows a warm close, which
    // would render `## No questions this turn` on guests meant to be established.
    intentionDerivation: {
      ...base.intentionDerivation,
      quietAfterWarmClose: false,
    },
    retractableReportedVisits: (unit.reportedItems
      ? [unit.reportedItems]
      : []
    ).map((items) => ({
      transactionId: randomUUID(),
      occurredAt: new Date(now.getTime() - 4 * 60 * 60_000),
      items: [...items],
    })),
    conversationChannel: 'instagram',
    firstConversation: !cell.established,
    signOff: cell.kind === 'close' ? 'plain' : null,
  } as RuntimeContext
}

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const armName = process.env.MEASURE_ARM ?? 'shipped'
  const reps = Number(process.env.MEASURE_REPS ?? '10')
  if (!Number.isInteger(reps) || reps < 1) {
    throw new Error('MEASURE_REPS must be a positive whole number')
  }
  const cellIds = (
    process.env.MEASURE_CELLS ?? CELLS.map((c) => c.id).join(',')
  )
    .split(',')
    .map((s) => s.trim())
  const arm = ARMS[armName]
  if (!arm) {
    throw new Error(
      `MEASURE_ARM="${armName}" is not one of: ${Object.keys(ARMS).join(', ')}`,
    )
  }
  const cells = CELLS.filter((c) => cellIds.includes(c.id))
  if (cells.length !== cellIds.length) {
    throw new Error(`MEASURE_CELLS names an unknown cell: ${cellIds.join(',')}`)
  }

  const db = createAdminClient()
  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, name, status')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  const { data: candidates } = await db
    .from('guests')
    .select('id')
    .eq('venue_id', venue.id)
    .is('opted_out_at', null)
    .not('instagram_scoped_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
  const guestId = candidates?.[0]?.id
  if (!guestId) throw new Error(`need one Instagram guest at ${venueSlug}`)

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const now = new Date()
  const trace = startAgentTrace({
    name: 'phone-test-fixes',
    agentRunId: randomUUID(),
  })

  // One build per trigger kind in use, so computeGuestState runs at most twice.
  const bases = new Map<Cell['kind'], BaseCtx>()
  for (const kind of new Set(cells.map((c) => c.kind))) {
    bases.set(
      kind,
      await buildRuntimeContext({
        agentRunId: randomUUID(),
        guestId,
        venueId: venue.id,
        trace,
        ...(kind === 'close'
          ? {
              followupTrigger: {
                reason: 'warm_close' as const,
                triggeredAt: now,
                warmClose: {
                  answersMessageId: randomUUID(),
                  signOff: 'plain' as const,
                },
              },
            }
          : {
              currentMessage: {
                id: randomUUID(),
                providerMessageId: `phone-test-probe-${randomUUID()}`,
                body: 'hi',
                receivedAt: now,
                channel: 'instagram' as const,
                referralSource: null,
              },
            }),
      }),
    )
  }

  const log = createRunLog({
    name: `phone-test-fixes-${armName}`,
    meta: {
      arm: armName,
      band: BAND,
      transforms: arm.map((t) => t.label),
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueStatus: venue.status,
      guestId,
      cells: cells.map((c) => c.id),
      reps,
      constructed:
        'every thread is constructed; none is a replay of stored rows. Categories are classified once per unit per run.',
    },
  })
  console.log(
    `[phone-test] arm=${armName} prompt=${PROMPT_VERSION} venue=${venueSlug} reps=${reps}`,
  )
  console.log(`[phone-test] run log: ${log.path}`)

  const anyBase = [...bases.values()][0] as BaseCtx
  const corpus = await retrieveCorpusStage(anyBase)
  const ragChunks: AiVoiceCorpusChunk[] = corpus.map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))

  const voidCells: string[] = []

  for (const cell of cells) {
    console.log(`\n== ${cell.id}: ${cell.what}`)
    const base = bases.get(cell.kind) as BaseCtx
    const categories = new Map<string, MessageCategory>()
    const knowledge = new Map<string, AiKnowledgeCorpusChunk[]>()
    const tallies: Record<string, number> = {}
    let done = 0
    let failed = 0

    for (let rep = 0; rep < reps; rep += 1) {
      const unit = cell.units[rep % cell.units.length] as Unit
      const ctx = unitContext(base, cell, unit, now)
      ctx.corpus = corpus
      try {
        let category = categories.get(unit.id)
        if (category === undefined) {
          if (cell.kind === 'close') {
            category = 'acknowledgment'
            knowledge.set(unit.id, [])
          } else {
            const classification = await classifyStage(ctx)
            category = classification.category
            const matches = await retrieveKnowledgeWithContextStage(
              ctx,
              category,
              unit.inbound as string,
            )
            knowledge.set(
              unit.id,
              matches.map((c) => ({
                id: c.id,
                text: c.text,
                sourceType: c.sourceType,
                primaryTags: c.primaryTags,
                secondaryTags: c.secondaryTags,
                relevanceScore: c.similarity,
              })),
            )
          }
          categories.set(unit.id, category)
        }

        const composed = composePrompt({
          category,
          persona: ctx.venue.brandPersona,
          venueInfo: ctx.venue.venueInfo,
          ragChunks,
          knowledgeChunks: knowledge.get(unit.id) ?? [],
          runtime: buildAiRuntime(ctx),
          channel: 'instagram',
        })
        let system = composed.systemPrompt
        let user = composed.userPrompt
        const applied: string[] = []
        for (const t of arm) {
          const before = t.target === 'system' ? system : user
          const after = t.apply(before)
          if (after === before && !t.optional) {
            throw new Error(`transform "${t.label}" did not change the prompt`)
          }
          if (after !== before) applied.push(t.label)
          if (t.target === 'system') system = after
          else user = after
        }
        if (arm.length > 0 && applied.length === 0) {
          throw new Error('no transform in this arm changed the prompt')
        }

        const { object } = await generateObject({
          model: getGenerationModel(),
          system,
          messages: [...composed.historyTurns, { role: 'user', content: user }],
          schema: GeneratedMessageSchema,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        })
        const reply = composeReplyWithIntention(
          object.body,
          object.intentionQuestion,
        ).body
        const flags = detect(reply)
        for (const [k, v] of Object.entries(flags)) {
          if (v) tallies[k] = (tallies[k] ?? 0) + 1
        }
        done += 1
        log.appendUnit({
          cell: cell.id,
          unit: unit.id,
          rep,
          failed: false,
          category,
          applied,
          inbound: unit.inbound ?? null,
          body: reply,
          knowledgeGap: object.knowledgeGap,
          reportedVisitCorrection: object.reportedVisitCorrection,
          flags,
        })
        const marks = Object.entries(flags)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(',')
        console.log(
          `  ${unit.id} [${category}${object.knowledgeGap ? ', GAP' : ''}] ${JSON.stringify(reply)}  {${marks}}`,
        )
      } catch (e) {
        failed += 1
        const error = e instanceof Error ? e.message : String(e)
        log.appendUnit({
          cell: cell.id,
          unit: unit.id,
          rep,
          failed: true,
          error,
        })
        console.log(`  ${unit.id} FAILED: ${error}`)
      }
    }

    if (failed > 0) voidCells.push(cell.id)
    console.log(
      `  -- ${cell.id}: ${done}/${reps} generated${failed > 0 ? `, ${failed} FAILED (CELL VOID)` : ''}; ${Object.entries(
        tallies,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    )
    log.appendUnit({ summary: true, cell: cell.id, done, failed, tallies })
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
  console.log(
    `\n[phone-test] guest_states rows before/after: ${statesBefore}/${statesAfter}`,
  )
  console.log(
    '[phone-test] counts above are detector hits, not verdicts. Read the bodies.',
  )
  if (voidCells.length > 0) {
    console.log(`[phone-test] VOID cells: ${voidCells.join(', ')}`)
    process.exit(2)
  }
  process.exit(0)
}

main().catch((e: unknown) => {
  console.error('[phone-test] crashed:', e instanceof Error ? e.message : e)
  process.exit(2)
})
