// Does a sandbox conversation survive save -> restore intact? Pure, no model
// calls, no DB - the converters in _lib/history.ts are the whole subject.
//
// The check that earns this file is "transcript identical after restore".
// A restored turn has bubbles and no trace, so a reply read that only looks
// at the trace builds a transcript of the guest talking into silence, and
// NOTHING ERRORS - the next turn is just generated against a conversation
// that never happened. Verified by ablation on 2026-10-06: reverting
// replyBubblesOf to the trace-only read takes the transcript from 7 entries
// to 1 and fails 4 of the 9 checks below.
import {
  savedTurnsFromPlayground,
  sessionHistoryFromTurns,
  turnsFromSaved,
} from '@/app/admin/(authed)/playground/_lib/history'
import type { PlaygroundTurn } from '@/app/admin/(authed)/playground/_lib/types'

const VENUE = '11111111-1111-1111-1111-111111111111'

function sessionAfter(n: number) {
  return {
    profile: { fields: { first_name: `n${n}` }, facts: [] },
    memory: { entries: [] },
    facts: { visitCount: 0, replyCount: n, daysSinceLastContact: null },
  }
}

function liveTurn(
  id: string,
  inbound: string,
  reply: string[],
  session: ReturnType<typeof sessionAfter> | undefined,
  verdict: 'send' | 'queue' | null,
): PlaygroundTurn {
  return {
    id,
    mode: 'sandbox',
    request: {
      venueId: VENUE,
      guestId: null,
      inbound: [inbound],
      sessionHistory: [],
      ...(session ? { session } : {}),
    },
    status: 'done',
    runSeq: 1,
    response: {
      graphStates: [],
      // Only the fields the converters read; cast because a full TurnTrace is
      // 40 fields of irrelevance for this check.
      trace: {
        generation: { ok: true, output: { messages: reply } },
        gate: verdict === null ? null : { verdict },
      },
    } as unknown as PlaygroundTurn['response'],
  }
}

const live: PlaygroundTurn[] = [
  liveTurn(
    'turn-1',
    'heyo',
    ['hey, welcome. glad you found us.'],
    undefined,
    'send',
  ),
  liveTurn(
    'turn-2',
    'i had a bad experience',
    ['sorry to hear that. what happened?'],
    sessionAfter(1),
    'send',
  ),
  liveTurn(
    'turn-3',
    'drink tasted bad',
    ["that's on us. we'll remake it."],
    sessionAfter(2),
    'queue',
  ),
]

const liveHistory = sessionHistoryFromTurns(live)

const saved = savedTurnsFromPlayground(live)
let c = 0
const restored = turnsFromSaved(VENUE, saved, () => `r-${(c += 1)}`)
const restoredHistory = sessionHistoryFromTurns(restored)

const checks: [string, boolean, string][] = [
  [
    'turn count survives',
    restored.length === live.length,
    `${restored.length}`,
  ],
  [
    'transcript identical after restore',
    JSON.stringify(liveHistory) === JSON.stringify(restoredHistory),
    `${restoredHistory.length} entries`,
  ],
  [
    'venue replies present in restored transcript',
    restoredHistory.filter((h) => h.role === 'assistant').length === 3,
    JSON.stringify(restoredHistory.filter((h) => h.role === 'assistant')),
  ],
  [
    'turn 1 carries no session (opening send has none)',
    restored[0].request.session === undefined,
    String(restored[0].request.session),
  ],
  [
    'turn 3 session is the one it RAN with, not the one after',
    restored[2].request.session?.facts.replyCount === 2,
    String(restored[2].request.session?.facts.replyCount),
  ],
  [
    'rerun-from-turn-3 request rebuilds the prior transcript',
    restored[2].request.sessionHistory?.length === 4,
    `${restored[2].request.sessionHistory?.length}`,
  ],
  [
    'gate verdict survives',
    restored[2].restored?.verdict === 'queue',
    String(restored[2].restored?.verdict),
  ],
  [
    'restored turns carry no trace',
    restored.every((t) => t.response === undefined),
    'ok',
  ],
  [
    'second save of a restored conversation is byte-identical',
    JSON.stringify(savedTurnsFromPlayground(restored)) ===
      JSON.stringify(saved),
    'ok',
  ],
]

let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`)
}
console.log(`\n${checks.length - failed}/${checks.length}`)
process.exit(failed > 0 ? 1 : 0)
