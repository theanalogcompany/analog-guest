import type { HistoryTurn } from '@/lib/ai/v2/compose'
// Type-only, like every other engine import here: `handle-inbound` is the v1
// orchestrator and pulls the whole server pipeline, so a value import would
// drag it into the client bundle. Imported rather than re-declared because a
// second copy of this shape is a contract that can disagree with itself.
import type { TestDraft } from '@/lib/agent/handle-inbound'
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
  /**
   * An outreach turn: the venue writing first (v2.21.0). `inbound` must be
   * empty, and the route refuses the pairing with `v1Arm` or `actualReply` -
   * both of those answer an inbound this turn does not have.
   */
  outreach?: { hoursQuiet: number }
  /**
   * What the guest sent besides words, stated rather than stored - a golden
   * scenario's links. Reaches BOTH arms from this one field, and it is what
   * makes `inbound: []` legal: a photo with no caption is a media-only turn,
   * not an empty one.
   */
  media?: { mediaUrls: string[] }
  /**
   * Skip the judge and the post-turn assessor. Only safe where nothing chains
   * off the turn - the route's own schema has the full reasoning.
   */
  skipEvaluation?: boolean
  /**
   * Run the v1 arm beside v2 and return its draft. Replay needs the real
   * inbound row id (v1 is invoked on the row); sandbox needs nothing beyond
   * the request's own `sessionHistory` + `inbound`.
   *
   * Omitted = v2 only, which is what every pre-existing caller gets.
   *
   * `slot` IS LOAD-BEARING FOR ANY CALLER THAT FANS OUT. The sandbox arm
   * materializes the transcript by DELETING the synthetic guest's messages and
   * rewriting them (v1-arm.ts), so two concurrent requests on one slot answer
   * each other's transcript - or a row the other just removed. A batch caller
   * passes its worker index, 0..SANDBOX_SLOTS-1, and keeps it for the whole
   * run; omitted means slot 0, which is what the playground's one-turn-at-a-
   * time use has always had.
   */
  v1Arm?:
    | { mode: 'sandbox'; slot?: number }
    | { mode: 'replay'; inboundMessageId: string }
}

/**
 * The v1 column. `null` when the arm was not requested.
 *
 * NOT JUDGED, deliberately. The judge scores v2's draft against v2's house
 * notes; v1 was written from a different prompt carrying different context, so
 * a score over v1 using v2's notes would mark it down for not using facts its
 * prompt never held. The operator reads the two replies. (Replay's existing
 * `actualJudge` over what production really sent is unchanged and separate.)
 */
export interface V1Column {
  outcome:
    { ok: true; data: TestDraft } | { ok: false; error: string; stage: string }
}

export interface RunResponseBody {
  trace: TurnTrace
  /**
   * How long each arm took, both timed by the ROUTE from the same instant and
   * each stopped when it itself settled.
   *
   * Here rather than read off the trace, because `trace.totalDurationMs`
   * covers a different boundary from the v1 arm's (which includes
   * materializing the sandbox transcript), and two numbers measuring different
   * boundaries are not a comparison. `v1` is null when no v1 arm was
   * requested - which is not a duration of zero.
   */
  armMs: { v1: number | null; v2: number }
  /**
   * The active graph's states, for the inspector's state-override dropdown -
   * the trace itself only carries the resolved state, not the menu.
   */
  graphStates: GraphStateOption[]
  /** The v1 arm's result, or null when it was not requested. */
  v1: V1Column | null
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
   * Replay mode: the inbound row this turn replays.
   *
   * Kept on the TURN and not only inside `request.v1Arm`, because the v1 arm
   * is a live toggle: ticking "also run v1" and pressing Regenerate has to be
   * able to build a replay arm for a turn that was first run with the toggle
   * off, and the id is the one thing it cannot reconstruct.
   */
  replayMessageId?: string
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
