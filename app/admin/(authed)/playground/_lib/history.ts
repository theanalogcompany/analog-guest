import type { HistoryTurn } from '@/lib/ai/v2/compose'
import { DELIVERED_OUTBOUND_STATUSES } from '@/lib/agent/group-responses'
import type { PlaygroundConversationTurn } from '@/lib/schemas/playground'
import type { PlaygroundSession } from '@/lib/relationship/run-turn'
import type { PlaygroundTurn, RunRequestBody, TimelineMessage } from './types'

// Pure helpers that turn playground state into runTurn inputs. Client-safe:
// group-responses is a pure module (its own header says so) and everything
// else here is data shuffling.
//
// Both builders enforce the composer's discipline: roles must alternate, so
// same-role runs merge into one turn (the same reduce run-turn.ts applies to
// real DB history).

export function mergeSameRoleRuns(
  turns: readonly HistoryTurn[],
): HistoryTurn[] {
  return turns.reduce<HistoryTurn[]>((acc, t) => {
    const last = acc[acc.length - 1]
    if (last && last.role === t.role) last.text = `${last.text}\n${t.text}`
    else acc.push({ ...t })
    return acc
  }, [])
}

/**
 * Sandbox mode: the prior chat as history. Error turns and failed
 * generations contribute their inbound only - the guest "said" it even if
 * no reply came back.
 *
 * A RESTORED TURN'S REPLY COUNTS, and reading only `response` is the bug this
 * comment exists to prevent: a conversation loaded from a save has no traces,
 * so a trace-only read would build a transcript of the guest talking into
 * silence. Nothing would error - the next turn would just be generated
 * against a conversation that never happened.
 */
export function sessionHistoryFromTurns(
  turns: readonly PlaygroundTurn[],
): HistoryTurn[] {
  const flat: HistoryTurn[] = []
  for (const turn of turns) {
    for (const text of turn.request.inbound) {
      if (text.length > 0) flat.push({ role: 'user', text })
    }
    for (const text of replyBubblesOf(turn)) {
      if (text.length > 0) flat.push({ role: 'assistant', text })
    }
  }
  return mergeSameRoleRuns(flat)
}

/**
 * This turn's reply bubbles, from whichever of the two sources it has: a live
 * trace, or a restore. The ONE definition - the chat bubbles and the
 * transcript builder both read it, and a turn rendering text the next prompt
 * does not carry is precisely the kind of divergence nothing notices.
 *
 * Empty for a running turn, a failed run, and a failed generation alike.
 * Callers that need to tell those apart read `status` and the trace.
 */
export function replyBubblesOf(turn: PlaygroundTurn): string[] {
  const generation = turn.response?.trace.generation
  if (generation?.ok) return generation.output.messages
  if (turn.response !== undefined) return []
  return turn.restored?.reply ?? []
}

/**
 * Sandbox turns to the saved shape (migration 074). Replay turns are dropped:
 * a replay is reproducible from the guest's real timeline, so saving one would
 * persist something that was never lost.
 *
 * `sessionHistory` is deliberately NOT carried. It is derivable from the turns
 * themselves, and a stored copy is a second transcript that can disagree with
 * the first; `turnsFromSaved` rebuilds it on the way back in.
 */
export function savedTurnsFromPlayground(
  turns: readonly PlaygroundTurn[],
): PlaygroundConversationTurn[] {
  const saved: PlaygroundConversationTurn[] = []
  for (const turn of turns) {
    if (turn.mode !== 'sandbox') continue
    // A turn still running has no outcome yet. Saving it would record a reply
    // of [] that reads, on restore, as "the venue said nothing" - which is a
    // different claim from "this had not finished".
    if (turn.status === 'running') continue
    saved.push({
      inbound: turn.request.inbound,
      ...(turn.request.session !== undefined
        ? { session: turn.request.session }
        : {}),
      ...(turn.request.overrides !== undefined
        ? { overrides: turn.request.overrides }
        : {}),
      reply: replyBubblesOf(turn),
      verdict:
        turn.response?.trace.gate?.verdict ?? turn.restored?.verdict ?? null,
    })
  }
  return saved
}

/**
 * A saved conversation back to playground turns, ready to render and to rerun
 * from any point.
 *
 * Each turn's request is REBUILT rather than stored: `sessionHistory` comes
 * from the turns before it, exactly as the live client computes it on every
 * send. The session snapshot is the one thing taken verbatim from the save,
 * because it is the thing that cannot be recomputed - it is what the engine
 * handed back after that turn, and it is what makes "rerun from turn 6" cost
 * one run rather than six.
 */
export function turnsFromSaved(
  venueId: string,
  saved: readonly PlaygroundConversationTurn[],
  nextId: () => string,
): PlaygroundTurn[] {
  const turns: PlaygroundTurn[] = []
  for (const entry of saved) {
    const request: RunRequestBody = {
      venueId,
      guestId: null,
      inbound: entry.inbound,
      sessionHistory: sessionHistoryFromTurns(turns),
      ...(entry.session !== undefined ? { session: entry.session } : {}),
      ...(entry.overrides !== undefined ? { overrides: entry.overrides } : {}),
    }
    turns.push({
      id: nextId(),
      mode: 'sandbox',
      request,
      status: 'done',
      // 0, not 1: runSeq counts runs THIS session, and it keys the inspector's
      // edit state. A restored turn has had none.
      runSeq: 0,
      restored: { reply: entry.reply, verdict: entry.verdict },
    })
  }
  return turns
}

export interface ReplayContext {
  inbound: string[]
  sessionHistory: HistoryTurn[]
  session: PlaygroundSession
  /** What v1 actually sent: the outbound run following the chosen inbound, or null. */
  v1Reply: string[] | null
}

/**
 * Replay mode: rebuild the moment just before a real inbound arrived.
 *
 * Replay runs with guestId null + a transcript-built session on purpose: a
 * real guestId would make runTurn load the guest's FULL message history,
 * which includes everything sent AFTER the replay point - the model would
 * see the future. The cost is that profile/memory/state are empty
 * (transcript-only context); the page states that next to every replay.
 *
 * Returns null when the chosen message is not a replayable inbound - the
 * caller renders nothing rather than fabricating a turn.
 */
export function buildReplayContext(
  timeline: readonly TimelineMessage[],
  chosenId: string,
): ReplayContext | null {
  const idx = timeline.findIndex((m) => m.id === chosenId)
  if (idx === -1) return null
  const chosen = timeline[idx]
  if (chosen.direction !== 'inbound' || chosen.body.length === 0) return null

  const prior = timeline.slice(0, idx)
  const flat: HistoryTurn[] = []
  let priorInboundCount = 0
  for (const m of prior) {
    if (m.body.length === 0) continue
    if (m.direction === 'inbound') {
      priorInboundCount += 1
      flat.push({ role: 'user', text: m.body })
    } else if (DELIVERED_OUTBOUND_STATUSES.has(m.status ?? '')) {
      flat.push({ role: 'assistant', text: m.body })
    }
  }

  // The outbound run immediately after the chosen inbound, up to the next
  // inbound: that is the complete v1 response (one response spans several
  // bubble rows). Delivered rows only - a superseded draft was never sent.
  const v1: string[] = []
  for (const m of timeline.slice(idx + 1)) {
    if (m.direction === 'inbound') break
    if (m.body.length > 0 && DELIVERED_OUTBOUND_STATUSES.has(m.status ?? ''))
      v1.push(m.body)
  }

  return {
    inbound: [chosen.body],
    sessionHistory: mergeSameRoleRuns(flat),
    session: {
      profile: { fields: {}, facts: [] },
      memory: { entries: [] },
      // No stateKey: the engine enters at the active graph's own initial
      // state, whatever a venue graph names it.
      facts: {
        visitCount: 0,
        replyCount: priorInboundCount,
        daysSinceLastContact: null,
      },
    },
    v1Reply: v1.length > 0 ? v1 : null,
  }
}
