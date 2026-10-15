// TAC-588 hotfix: the check-in answer reader against thirty answers.
//
// THE BAR WAS POSTED ON THE TICKET BEFORE ANY GENERATION (2026-10-15) and is
// evaluated in code below. A re-run after the first is informational.
//
//   Thirty answers, each read once against the same question, "How'd you
//   like the oat cortado?". The reader only: nothing is sent, nothing is
//   written, no database is read.
//
//   Passes when:
//     at least 27 of 30 get exactly the expected label;
//     0 flip polarity (liked or ok read as disliked, or disliked read as
//       liked or ok);
//     "it was good" and "pretty good" are both read as liked (named in the
//       ruling).
//
//   A failed call voids the run.
//
//   npm run measure-checkin-answer-reader

import {
  readCheckinAnswer,
  READ_CHECKIN_ANSWER_PROMPT_VERSION,
  type CheckinAnswerVerdict,
} from '@/lib/ai/read-checkin-answer'
import { createRunLog } from './run-log'

const QUESTION = "How'd you like the oat cortado?"

const CASES: readonly [answer: string, expected: CheckinAnswerVerdict][] = [
  ['it was good', 'liked'],
  ['pretty good', 'liked'],
  ['loved it', 'liked'],
  ['so good', 'liked'],
  ['amazing thank you', 'liked'],
  ['really nice', 'liked'],
  ['delicious!', 'liked'],
  ['yum', 'liked'],
  ['great, thanks!', 'liked'],
  ['it was perfect', 'liked'],
  ['it was ok', 'ok'],
  ['fine', 'ok'],
  ['not bad', 'ok'],
  ['it was alright', 'ok'],
  ['decent', 'ok'],
  ['meh it was fine', 'ok'],
  ["it's okay", 'ok'],
  ['too sweet', 'disliked'],
  ['kinda cold', 'disliked'],
  ['not great honestly', 'disliked'],
  ["didn't love it", 'disliked'],
  ['it was burnt', 'disliked'],
  ['bit watery', 'disliked'],
  ["haven't tried it yet", 'not_yet'],
  ['still too hot', 'not_yet'],
  ['about to drink it', 'not_yet'],
  ['saving it for later', 'not_yet'],
  ['do you have wifi?', 'unclear'],
  ['thanks!', 'unclear'],
  ['see you next week', 'unclear'],
]

const POSITIVE = new Set<CheckinAnswerVerdict>(['liked', 'ok'])

async function main(): Promise<void> {
  const log = createRunLog({
    name: 'tac588-checkin-answer-reader',
    meta: {
      arm: 'treatment-only',
      promptVersion: READ_CHECKIN_ANSWER_PROMPT_VERSION,
      question: QUESTION,
      units: CASES.length,
      bars: { exact: '>= 27', polarityFlips: 0, namedLiked: 2 },
    },
  })
  console.log(`[tac588-reader] prompt=${READ_CHECKIN_ANSWER_PROMPT_VERSION}`)
  console.log(`[tac588-reader] run log: ${log.path}\n`)

  let exact = 0
  let flips = 0
  const failed: string[] = []
  const got = new Map<string, CheckinAnswerVerdict>()
  for (const [answer, expected] of CASES) {
    const r = await readCheckinAnswer({ question: QUESTION, answer })
    if (!r.ok) {
      failed.push(answer)
      log.appendUnit({ answer, expected, failed: true, error: r.error })
      console.log(`  ${JSON.stringify(answer)}  FAILED: ${r.error}`)
      continue
    }
    const verdict = r.data.verdict
    got.set(answer, verdict)
    const match = verdict === expected
    const flip =
      (POSITIVE.has(expected) && verdict === 'disliked') ||
      (expected === 'disliked' && POSITIVE.has(verdict))
    if (match) exact += 1
    if (flip) flips += 1
    log.appendUnit({
      answer,
      expected,
      verdict,
      item: r.data.item,
      match,
      flip,
    })
    console.log(
      `  ${match ? 'ok  ' : 'MISS'} ${JSON.stringify(answer)} -> ${verdict} (expected ${expected})${flip ? ' [POLARITY FLIP]' : ''} item=${JSON.stringify(r.data.item)}`,
    )
  }

  const named =
    (got.get('it was good') === 'liked' ? 1 : 0) +
    (got.get('pretty good') === 'liked' ? 1 : 0)
  console.log(`\n[tac588-reader] exact: ${exact}/${CASES.length} (bar >= 27)`)
  console.log(`[tac588-reader] polarity flips: ${flips} (bar 0)`)
  console.log(
    `[tac588-reader] "it was good" and "pretty good" liked: ${named}/2 (bar 2)`,
  )
  if (failed.length > 0) {
    console.log(`\n[tac588-reader] RUN VOID: ${failed.length} call(s) failed.`)
    log.appendUnit({ summary: true, void: true, failed })
    process.exit(2)
  }
  const pass = exact >= 27 && flips === 0 && named === 2
  log.appendUnit({ summary: true, void: false, exact, flips, named, pass })
  console.log(`\n[tac588-reader] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}

void main()
