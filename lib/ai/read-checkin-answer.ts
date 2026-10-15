// TAC-588 hotfix: read a guest's answer to the venue's own question about
// their order ("how'd you like the cortado?", "how is it so far?").
//
// WHY A READER OF ITS OWN (ruled 2026-10-15). The answer used to be read off
// the classifier's `praisedExperience`, which is the review-ask signal and so
// set deliberately high: "genuine, specific enthusiasm", and P(yes) >= 0.75 on
// Jev. A guest asked how they liked it who says "it was good" is answering
// yes, plainly, and fell under that bar to `not_yet`. After a receipt scan's
// item question, the visit's only check-back, that left nothing to follow it
// (UAT, 2026-10-15: no warm close, and a reply that re-complimented the order).
// This reads the answer against the question it answers, which is the one
// thing the praise flag was never asked to do.
//
// FIVE VERDICTS, mapped by the caller (classifyCheckinAnswer,
// lib/agent/visit-checkin.ts):
//
//   liked     "it was good", "pretty good", "loved it"     -> good
//   ok        "fine", "not bad", "it was alright"          -> ok (ruled: no
//             review link, no further question)
//   disliked  "too sweet", "kinda cold"                    -> bad
//   not_yet   "haven't tried it", "still too hot"          -> not_yet
//   unclear   a question, a thank-you, a change of subject -> not_yet
//
// A classifier `comp_complaint` is still `bad` whatever this says, so the
// complaint path is decided where it always was.
//
// FAILS TO THE OLD READING, at the caller: a failed call returns ok:false and
// the praise-based reading stands, so a reader outage costs what the old code
// already did and nothing more.
//
// Also returns the ITEM our question named, as written in it, for the reply's
// fact line ("They are answering your question about the …"): the question is
// the one place this turn has it in words.

import { generateObject, NoObjectGeneratedError } from 'ai'
import { z } from 'zod'

import { getClassificationModel } from './client'
import type { AIResult } from './types'

export const READ_CHECKIN_ANSWER_PROMPT_VERSION = 'v1.0.0'

export const READ_CHECKIN_ANSWER_MAX_OUTPUT_TOKENS = 400

export const CHECKIN_ANSWER_VERDICTS = [
  'liked',
  'ok',
  'disliked',
  'not_yet',
  'unclear',
] as const
export type CheckinAnswerVerdict = (typeof CHECKIN_ANSWER_VERDICTS)[number]

export interface ReadCheckinAnswerInput {
  /** Our message the guest is answering: the question we asked them. */
  question: string
  /** What the guest sent back. */
  answer: string
}

export interface ReadCheckinAnswerResult {
  verdict: CheckinAnswerVerdict
  /** The item our question named, as written, or null when it named none. */
  item: string | null
  promptVersion: string
}

const SYSTEM_PROMPT = `A venue asked a guest how they liked what they ordered, and the guest replied. Decide what the reply says about the order.

- liked: they liked it, plainly or warmly. "it was good", "pretty good", "really nice", "loved it", "so good", "delicious".
- ok: lukewarm. Neither a yes nor a complaint. "it was ok", "fine", "not bad", "alright", "decent".
- disliked: something was wrong with it, or they did not like it. "too sweet", "kinda cold", "not great", "didn't love it".
- not_yet: they have not had it yet, or are only starting. "haven't tried it", "still too hot", "about to".
- unclear: the reply does not say how it was. A question about something else, a bare thanks, a goodbye, a change of subject.

Judge only what the reply says about the order, read as an answer to the question. Do not ask for enthusiasm: a plain "good" is liked. When a reply is both warm and critical ("loved it but it was cold"), it is disliked.

Also give the item the venue's question asks about, copied from the question as written, or "" if the question names none.`

function buildUserPrompt(input: ReadCheckinAnswerInput): string {
  return `The venue asked: "${input.question}"\nThe guest replied: "${input.answer}"`
}

export async function readCheckinAnswer(
  input: ReadCheckinAnswerInput,
): Promise<AIResult<ReadCheckinAnswerResult>> {
  if (input.answer.trim() === '' || input.question.trim() === '') {
    return { ok: false, error: 'invalid_input' }
  }

  // `reasoning` first: structured output generates in declaration order, and a
  // verdict declared before the analysis is one the model has not reasoned
  // about yet (the verifiers' rule, TAC-301 part 1.5).
  const schema = z.object({
    reasoning: z.string(),
    verdict: z.enum(CHECKIN_ANSWER_VERDICTS),
    item: z.string(),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      schema,
      // Analytical and idempotent, like every sibling here.
      temperature: 0.2,
      maxOutputTokens: READ_CHECKIN_ANSWER_MAX_OUTPUT_TOKENS,
    })
    const item = object.item.replace(/\s+/g, ' ').trim()
    return {
      ok: true,
      data: {
        verdict: object.verdict,
        item: item === '' ? null : item,
        promptVersion: READ_CHECKIN_ANSWER_PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (NoObjectGeneratedError.isInstance(e) && e.finishReason === 'length') {
      return {
        ok: false,
        error: message,
        errorCode: 'ai_read_checkin_answer_truncated',
      }
    }
    return {
      ok: false,
      error: message,
      errorCode: 'ai_read_checkin_answer_failed',
    }
  }
}
