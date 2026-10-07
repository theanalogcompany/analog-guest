// Behavioural checks for the offer-more-help line on a draft that is HELD for
// an operator rather than sent (ruled 2026-10-07): a held draft never carries
// it, and the getting-to-know-you question and review invitation are left as
// they were.
//
// Run by hand (see README.md). Pure: no database, no model, no network. It
// drives the functions dispatch itself calls.
//
// Every "the offer is gone" check has a CONTROL beside it showing the same
// reply auto-sent, where the offer goes out as its own last message. Without
// that, a check expecting no offer would pass on a reply that never had one.

import { readFileSync } from 'node:fs'

import { heldDraftBody, withoutOfferBubble } from '@/lib/agent/held-draft-body'
import {
  offeredThisConversation,
  previousReplyOffered,
} from '@/lib/agent/previous-offer'
import {
  resolveDispatchBubbles,
  resolveOutboundTail,
} from '@/lib/agent/sentence-split'
import {
  appendFurtherHelpOffer,
  decideFurtherHelpOffer,
} from '@/lib/ai/further-help-offer'
import type { RecentMessage } from '@/lib/ai/types'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`ok    ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}\n        expected ${e}\n        actual   ${a}`)
}

const OFFER = 'glad to help with anything else on the menu'
/** What an auto-send delivers: never split, so the rng is pinned high. */
const sent = (body: string, offer: string): string[] =>
  resolveDispatchBubbles(
    body,
    () => 0.99,
    resolveOutboundTail('', '', 0, offer),
  )

// A reply ending on a link, the case the ruling is about.
const linkAnswer = 'here you go: https://example.com/pages/menu'
const linkReply = appendFurtherHelpOffer(linkAnswer, OFFER)
check(
  'control: auto-sent, the offer is its own last message',
  sent(linkReply, OFFER),
  [linkAnswer, OFFER],
)
check(
  'held: the draft is the answer alone',
  heldDraftBody({ body: linkReply, furtherHelpOffer: OFFER }),
  linkAnswer,
)
check(
  'held: no run-on of link and offer survives',
  heldDraftBody({ body: linkReply, furtherHelpOffer: OFFER }).includes(OFFER),
  false,
)

// A reply ending on an emoji, the other shape with no full stop.
const emojiAnswer = 'head to example.com and you can browse everything ☕'
const emojiReply = appendFurtherHelpOffer(emojiAnswer, OFFER)
check('control: auto-sent after an emoji', sent(emojiReply, OFFER), [
  emojiAnswer,
  OFFER,
])
check(
  'held: after an emoji',
  heldDraftBody({ body: emojiReply, furtherHelpOffer: OFFER }),
  emojiAnswer,
)

// A reply that ends a sentence.
const proseAnswer = 'the cortado is a little bolder, the flat white is rounder.'
check(
  'held: after a full stop',
  heldDraftBody({
    body: appendFurtherHelpOffer(proseAnswer, OFFER),
    furtherHelpOffer: OFFER,
  }),
  proseAnswer,
)

// No offer on the turn: the held draft is the reply, untouched.
check(
  'held: a reply with no offer is unchanged',
  heldDraftBody({ body: proseAnswer, furtherHelpOffer: '' }),
  proseAnswer,
)

// THE OTHER TWO TAILS STAY. A held draft carrying a getting-to-know-you
// question or a review invitation has furtherHelpOffer '' by construction
// (decideFurtherHelpOffer withholds the offer from any reply that carries
// either), so the question is still folded into the one message.
const question = 'what did you end up getting?'
check(
  'held: a getting-to-know-you question is still folded in',
  heldDraftBody({
    body: `glad you made it in. ${question}`,
    furtherHelpOffer: '',
  }),
  `glad you made it in. ${question}`,
)

// A body that does not end with the line is left alone rather than guessed at.
check(
  'held: an offer that is not the tail is not cut out of the middle',
  heldDraftBody({
    body: `${OFFER}. here you go: https://example.com/pages/menu`,
    furtherHelpOffer: OFFER,
  }),
  `${OFFER}. here you go: https://example.com/pages/menu`,
)

// Whitespace a model leaves around either part does not defeat the slice.
check(
  'held: trailing whitespace on the body',
  heldDraftBody({ body: `${linkReply}  \n`, furtherHelpOffer: ` ${OFFER} ` }),
  linkAnswer,
)

// THE WIRING. The checks above prove the function; this proves the two places
// a held draft's text is stored call it. Both used to store the whole reply.
const source = readFileSync('lib/agent/schedule-and-send.ts', 'utf8')
check(
  'wiring: a held draft is stored through heldDraftBody, at both sites',
  (source.match(/heldDraftBody\(generation\)/g) ?? []).length,
  2,
)
check(
  'wiring: nothing in schedule-and-send stores the whole reply as one message',
  source.includes('collapseToSingleMessage('),
  false,
)

// A suffix that lands inside a word is not a tail.
check(
  'held: an offer that only matches the end of a word is not cut',
  heldDraftBody({ body: 'see the menu', furtherHelpOffer: 'nu' }),
  'see the menu',
)

// THE INSTAGRAM PARTIAL SEND. Some messages went out and the rest become a
// card. By then the offer is its own message, full stop stripped.
check(
  'partial send: the offer is dropped from what is carded',
  withoutOfferBubble(['second half of the answer', OFFER], `${OFFER}.`),
  ['second half of the answer'],
)
check(
  'partial send: when only the offer failed, nothing is left to card',
  withoutOfferBubble([OFFER], OFFER),
  [],
)
check(
  'control: a reply with no offer keeps every unsent message',
  withoutOfferBubble(['second half of the answer', 'and a third'], ''),
  ['second half of the answer', 'and a third'],
)
check(
  'control: an offer that already went out leaves the unsent messages alone',
  withoutOfferBubble(['second half of the answer', 'and a third'], OFFER),
  ['second half of the answer', 'and a third'],
)

// ONE OFFER PER CONVERSATION (ruled 2026-10-07).
const NOW = new Date('2026-10-07T20:00:00Z')
const HOUR_MS = 60 * 60 * 1000
const WINDOW_MS = 48 * HOUR_MS
const msg = (
  direction: 'inbound' | 'outbound',
  body: string,
  minutesAgo: number,
  delivery: RecentMessage['delivery'] = 'delivered',
): RecentMessage => ({
  direction,
  body,
  createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  delivery,
})
// The 2026-10-07 phone thread, constructed.
const beansThread = [
  msg('inbound', 'can you help me buy beans', 3),
  msg(
    'outbound',
    "you can browse everything at https://example.com/collections/all happy to point you toward a specific bean if you tell me what you're brewing",
    2,
  ),
]
const noOfferThread = [
  msg('inbound', 'what time do you close', 3),
  msg('outbound', '3pm today', 2),
]
const base = {
  body: 'for black coffee the light roast is the one: https://example.com/products/light',
  offer: 'glad to help you pick a grind too',
  category: 'recommendation_request' as const,
  commitment: {},
  repliesToGuest: true,
  signsOff: false,
  onComplaintTurn: false,
  carriesAnAsk: false,
  knowledgeGap: false,
  correctingVisit: false,
}
const decide = (thread: RecentMessage[], asOf = NOW) =>
  decideFurtherHelpOffer({
    ...base,
    offeredThisConversation: offeredThisConversation(thread, asOf, WINDOW_MS),
  })
check(
  'control: the first answer in a conversation gets its offer',
  decide(noOfferThread),
  {
    append: true,
    reason: 'link',
  },
)
check('once: the reply after an offer carries none', decide(beansThread), {
  append: false,
  reason: 'offered_this_conversation',
})
check(
  'once: nor does a later reply, with other messages in between',
  decide([
    ...beansThread,
    msg('inbound', 'usually black', 1.5),
    msg(
      'outbound',
      'the light roast then: https://example.com/products/light',
      1,
    ),
    msg('inbound', 'and for espresso?', 0.5),
  ]),
  { append: false, reason: 'offered_this_conversation' },
)
check(
  'control: an offer from before the conversation window does not count',
  decide(beansThread, new Date(NOW.getTime() + WINDOW_MS + HOUR_MS)),
  { append: true, reason: 'link' },
)
check(
  'control: an offer in a draft the guest never received does not count',
  decide([
    msg('inbound', 'can you help me buy beans', 3),
    msg('outbound', beansThread[1]?.body ?? '', 2, 'awaiting_review'),
  ]),
  { append: true, reason: 'link' },
)
// What turns on the `## They are answering your offer` block. Narrower than
// the veto on purpose: a false hit here tells the model something untrue.
const answering = (thread: RecentMessage[], asOf = NOW): boolean =>
  previousReplyOffered(thread, asOf, WINDOW_MS)
const afterOurs = (body: string, category?: string): RecentMessage[] => [
  msg('inbound', 'hey', 3),
  { ...msg('outbound', body, 2), category },
]
check(
  'answering: our last message ended with an offer',
  answering(beansThread),
  true,
)
check(
  'control: our last message was a plain answer',
  answering(noOfferThread),
  false,
)
check(
  'control: an offer two messages back is not what they are answering',
  answering([
    ...beansThread,
    msg('inbound', 'usually black', 1.5),
    msg('outbound', 'the light roast then', 1),
  ]),
  false,
)
check(
  'control: an offer from before the conversation window is not being answered',
  answering(beansThread, new Date(NOW.getTime() + WINDOW_MS + HOUR_MS)),
  false,
)
// ORDINARY REPLIES THAT ARE NOT OFFERS. Each of these turned the block on
// under the first version, which shared the veto's wide wording list.
for (const body of [
  'if you want something cold, the tonic is the one',
  "let us know when you're on your way",
  'give us a heads up if you want it tonight',
  'happy to hear it',
  'glad to have you',
  'any other day works too',
  "if you need parking, there's a lot on Pine",
  "you won't hear from us again. if you want to come back, text START anytime",
]) {
  check(
    `not an offer: ${JSON.stringify(body)}`,
    answering(afterOurs(body)),
    false,
  )
}

// BY HOW IT WAS SENT, NOT BY HOW IT READS (ruled 2026-10-07). A close or a
// sign-off worded exactly like an offer is not one, for the veto or the block.
const closeWording =
  'hope to see you soon. happy to answer anything else about the menu, events or what to try'
const closedThread = (category: string): RecentMessage[] => [
  ...noOfferThread,
  { ...msg('outbound', closeWording, 1), category },
]
check(
  'control: the same words in a reply DO count',
  decide(closedThread('new_question')),
  { append: false, reason: 'offered_this_conversation' },
)
for (const category of [
  'acknowledgment',
  'follow_up',
  'guest_arrived',
  'manual',
  'a_close_category_that_does_not_exist_yet',
]) {
  check(
    `sent as ${category}: not an offer for the once-per-conversation rule`,
    decide(closedThread(category)),
    { append: true, reason: 'link' },
  )
  check(
    `sent as ${category}: the guest is not answering an offer`,
    answering(closedThread(category)),
    false,
  )
}
check(
  'a close sent after an offer ends "answering", but the offer still counts once',
  [
    answering([
      ...beansThread,
      {
        ...msg('outbound', 'hope to see you soon', 1),
        category: 'acknowledgment',
      },
    ]),
    decide([
      ...beansThread,
      {
        ...msg('outbound', 'hope to see you soon', 1),
        category: 'acknowledgment',
      },
    ]).reason,
  ],
  [false, 'offered_this_conversation'],
)

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall checks passed')
