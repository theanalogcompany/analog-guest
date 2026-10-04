import type { HistoryTurn } from '@/lib/ai/v2/compose'
import { DELIVERED_OUTBOUND_STATUSES } from '@/lib/agent/group-responses'
import type { PlaygroundSession } from '@/lib/relationship/run-turn'
import type { PlaygroundTurn, TimelineMessage } from './types'

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
 */
export function sessionHistoryFromTurns(
  turns: readonly PlaygroundTurn[],
): HistoryTurn[] {
  const flat: HistoryTurn[] = []
  for (const turn of turns) {
    for (const text of turn.request.inbound) {
      if (text.length > 0) flat.push({ role: 'user', text })
    }
    const generation = turn.response?.trace.generation
    if (generation?.ok) {
      for (const text of generation.output.messages) {
        if (text.length > 0) flat.push({ role: 'assistant', text })
      }
    }
  }
  return mergeSameRoleRuns(flat)
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
