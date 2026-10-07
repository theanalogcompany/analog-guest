import type { HistoryTurn } from '@/lib/ai/v2/compose'
import type { PlaygroundConversationTurn } from '@/lib/schemas/playground'
import type {
  PlaygroundSession,
  TurnOverrides,
  TurnTrace,
} from '@/lib/relationship/run-turn'

// Shared shapes for the v2 playground: the run endpoint's request/response
// contract and the client's per-turn bookkeeping. Types only - every import
// from the engine is type-only so nothing server-side leaks into the client
// bundle.

export interface GraphStateOption {
  key: string
  label: string
}

/** POST /admin/playground/api/run body. Mirrors RunTurnInput minus `now`. */
export interface RunRequestBody {
  venueId: string
  guestId: string | null
  inbound: string[]
  sessionHistory?: HistoryTurn[]
  session?: PlaygroundSession
  overrides?: TurnOverrides
  /** Replay mode: what production actually sent, for the comparison judgment. */
  actualReply?: string[]
}

export interface RunResponseBody {
  trace: TurnTrace
  /**
   * The active graph's states, for the inspector's state-override dropdown -
   * the trace itself only carries the resolved state, not the menu.
   */
  graphStates: GraphStateOption[]
}

/** One row of the replay-mode guest picker. */
export interface GuestListItem {
  id: string
  displayName: string
  /** Null when the guest has no messages yet. */
  lastMessageAt: string | null
}

export interface GuestListResponse {
  guests: GuestListItem[]
  /** Activity ordering degraded to enrollment order (load-venue-guests posture). */
  activityDegraded: boolean
}

export interface TimelineMessage {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  status: string | null
  createdAt: string
}

export interface TimelineResponse {
  messages: TimelineMessage[]
  /** True when older messages exist beyond the window. */
  hasMore: boolean
}

/**
 * One playground turn: the exact request that produced it (regenerate replays
 * it with overrides), the result, and - after a regenerate - the previous
 * trace kept for the judge-score comparison.
 */
export interface PlaygroundTurn {
  id: string
  mode: 'sandbox' | 'replay'
  request: RunRequestBody
  status: 'running' | 'done' | 'error'
  /** Increments per completed run of this turn; keys the inspector's edit state. */
  runSeq: number
  error?: string
  response?: RunResponseBody
  /** The trace this turn's current response replaced, kept for old-vs-new judge scores. */
  previousTrace?: TurnTrace
  /** Replay mode: the bubbles v1 actually sent after this inbound, null when none followed. */
  v1Reply?: string[] | null
  /**
   * Restored from a saved conversation (migration 074): the reply and gate
   * verdict as they were, with NO trace behind them.
   *
   * Mutually exclusive with `response` by construction - a turn is either one
   * this session ran (trace, inspectable) or one read back from a save
   * (bubbles only). Every consumer must branch on which, and none may
   * synthesize a trace from this: an inspector panel filled from a save would
   * show a composed prompt and judge scores that were never recorded.
   *
   * Cleared the moment the turn is rerun, because then a real trace exists.
   */
  restored?: {
    reply: string[]
    verdict: 'send' | 'queue' | 'block' | null
  }
}

/** One row of the saved-conversation picker. No `turns` - see the list route. */
export interface SavedConversationSummary {
  id: string
  name: string
  turnCount: number
  createdAt: string
  updatedAt: string
}

export interface SavedConversationListResponse {
  conversations: SavedConversationSummary[]
  /** True when saves exist beyond the listed window. */
  hasMore: boolean
}

export interface SavedConversationDetail extends SavedConversationSummary {
  turns: PlaygroundConversationTurn[]
  /**
   * The session a new message onto the end would run with. Null when the save
   * carried none, which restores as a fresh session rather than as an error.
   */
  nextSession: PlaygroundSession | null
}
