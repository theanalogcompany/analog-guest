// TAC-588 hotfix: the one line that tells the reply its guest is answering
// the venue's own question about their order.
//
// WHY IT EXISTS. After "How did the matcha latte land tonight?" the guest
// wrote "it was good", and the reply, a plain `reply` turn told to ask
// nothing and run about twelve words, filled the length by complimenting the
// order again ("The croissant alongside it was a good call"). Nothing in the
// prompt said this message was an answer, or what it said.
//
// THE WORDING IS JAIPAL'S, approved 2026-10-15, with "they thought it was ok"
// added for the lukewarm verdict. Rendered right after "The guest just sent",
// the last thing before the model writes, because proximity reads as
// authority in this prompt.
//
// NOTHING FOR `unclear`: "They are answering your question" would be false
// for a guest who asked about the wifi instead. With no item in the question
// the line says "what they got" in its place.

import type { CheckinAnswerVerdict } from '../read-checkin-answer'

const WHAT_THEY_SAID = {
  liked: 'they liked it',
  ok: 'they thought it was ok',
  disliked: "they didn't like it",
  not_yet: "they haven't tried it yet or didn't say",
  unclear: null,
} as const satisfies Record<CheckinAnswerVerdict, string | null>

export function checkinAnswerFactLine(input: {
  item: string | null
  verdict: CheckinAnswerVerdict
}): string | null {
  const said = WHAT_THEY_SAID[input.verdict]
  if (said === null) return null
  const item = input.item?.replace(/\s+/g, ' ').trim()
  const subject =
    item === undefined || item === '' ? 'what they got' : `the ${item}`
  return `They are answering your question about ${subject}: ${said}. Respond to that answer.`
}
