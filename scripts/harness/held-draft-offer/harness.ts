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

import { heldDraftBody } from '@/lib/agent/held-draft-body'
import {
  resolveDispatchBubbles,
  resolveOutboundTail,
} from '@/lib/agent/sentence-split'
import { appendFurtherHelpOffer } from '@/lib/ai/further-help-offer'

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

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall checks passed')
