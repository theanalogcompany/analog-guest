'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { V2_PROMPT_VERSION } from '@/lib/ai/v2/template'
import { evaluationRan } from '@/lib/relationship/evaluation-ran'
import type {
  PlaygroundSession,
  TurnOverrides,
} from '@/lib/relationship/run-turn'
import type { VenueListRow } from '../_lib/load-venues'
import {
  deleteSavedConversation,
  fetchGuests,
  fetchSavedConversation,
  fetchSavedConversations,
  fetchTimeline,
  postRun,
  postSaveConversation,
} from './_lib/api'
import {
  activePromptFor,
  activePromptsServerSnapshot,
  activePromptsSnapshot,
  clearActivePrompt,
  setActivePrompt,
  subscribeActivePrompt,
} from './_lib/active-prompt'
import {
  buildReplayContext,
  savedTurnsFromPlayground,
  sessionHistoryFromTurns,
  turnsFromSaved,
} from './_lib/history'
import type {
  GuestListItem,
  PlaygroundTurn,
  RunRequestBody,
  SavedConversationSummary,
  TimelineMessage,
} from './_lib/types'
import { ChatPane } from './_components/chat-pane'
import { Inspector } from './_components/inspector'
import { ReplayPane } from './_components/replay-pane'
import { SetupBar, type PlaygroundMode } from './_components/setup-bar'

// Client orchestrator for the v2 playground. Live state is ephemeral -
// nothing in the URL, reload-to-reset is a feature on a debugging surface -
// with TWO deliberate exceptions: a sandbox conversation can be saved to
// playground_conversations (migration 074) and read back, and a prompt edit
// stays IN FORCE across turns and across a refresh (`_lib/active-prompt.ts`).
//
// The second one is a carve-out from reload-to-reset on purpose. An ablation
// is "change one line, try it on six inbounds", so an edit that died with the
// turn would be retyped six times, and a refresh mid-loop is not a request to
// go back to the composed prompt. It is loud rather than silent: the setup bar
// carries a strip naming the pinned blocks with one click to clear, because an
// invisible prompt override would make every later reading of this surface
// wrong.
//
// That exception exists because the ephemerality had a cost the rest of the
// design did not: getting a guest ten turns deep is ten runs at 15-45s each,
// and a reload meant typing all ten again to look at the eleventh. A save
// restores the chat with no model calls; rerunning from any point still costs
// exactly one run, because each turn carries the session it ran with.
//
// A SAVE IS NOT A SNAPSHOT OF THE TRACES. Restored turns have bubbles and no
// trace, and every consumer branches on that rather than filling the gap -
// see PlaygroundTurn.restored.
//
// Sandbox session discipline: the running PlaygroundSession advances ONLY
// when a NEW turn completes with an ok assessor - a regenerate never touches
// it, because regenerating turn N after turn N+1 exists would silently
// rewrite history the later turns already consumed.

let turnCounter = 0
function nextTurnId(): string {
  turnCounter += 1
  return `turn-${turnCounter}`
}

/**
 * The venue this page opens on, so the common case is one fewer click.
 *
 * MATCHED BY NAME, never by a pasted uuid: an id in a component is unreadable
 * and cannot be checked against anything, and the measurement harnesses
 * already resolve this same venue with `ilike('name', "Le Mil's Coffee")`
 * rather than an id.
 *
 * DELIBERATELY ITS OWN CONSTANT rather than imported from those harnesses.
 * They resolve "the venue every prior v2 measurement ran on", which is a
 * statement about history; this is "the venue an operator most likely wants",
 * which is convenience. They point at the same venue today and are free to
 * stop doing so, and coupling them would make a harness default move because
 * someone re-ordered a dropdown.
 *
 * FALLS BACK TO NO SELECTION, which is the previous behaviour. A venue that is
 * absent or out of this operator's allowlist must not become "no venue picker
 * worked" - the page is usable with any venue, so an unmatched name costs one
 * click and nothing else.
 */
const DEFAULT_VENUE_NAME = "Le Mil's Coffee"

/**
 * A request with no v1 arm, so one can be attached from the live toggle.
 *
 * `delete` rather than a rest destructure: the arm is OPTIONAL, and the
 * idiomatic `const {v1Arm: _, ...rest}` leaves a binding nothing reads, which
 * lint flags and which reads as an oversight rather than as a deliberate drop.
 */
function withoutV1Arm(request: RunRequestBody): RunRequestBody {
  const copy = { ...request }
  delete copy.v1Arm
  return copy
}

export function PlaygroundClient({ venues }: { venues: VenueListRow[] }) {
  // Lazy initializer: `venues` is server-rendered and stable for the life of
  // the page, so this resolves once rather than on every render.
  const [venueId, setVenueId] = useState<string | null>(
    () => venues.find((v) => v.name === DEFAULT_VENUE_NAME)?.venueId ?? null,
  )
  const [mode, setMode] = useState<PlaygroundMode>('sandbox')
  // Survives a refresh by design - see the header. Read through a store rather
  // than an effect so the server renders "none in force" and the client renders
  // the truth, with no hydration mismatch.
  const activePrompt = activePromptFor(
    useSyncExternalStore(
      subscribeActivePrompt,
      activePromptsSnapshot,
      activePromptsServerSnapshot,
    ),
    venueId,
  )

  // Run v1 beside v2. FALSE by default: the arm is a second full generation
  // per turn, so defaulting it on would double the model spend of every
  // operator who opened this page to look at v2 alone.
  const [compareV1, setCompareV1] = useState(false)

  const [turns, setTurns] = useState<PlaygroundTurn[]>([])
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Sandbox: the engine-maintained session, adopted from each assessor.
  const [session, setSession] = useState<PlaygroundSession | null>(null)

  // Rewind-to-edit: bumping seq tells the composer to adopt the text.
  const [prefill, setPrefill] = useState<{ seq: number; text: string } | null>(
    null,
  )

  // Replay: guest picker + timeline.
  const [guests, setGuests] = useState<GuestListItem[]>([])
  const [guestsError, setGuestsError] = useState<string | null>(null)
  const [activityDegraded, setActivityDegraded] = useState(false)
  const [guestId, setGuestId] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<TimelineMessage[]>([])
  const [timelineError, setTimelineError] = useState<string | null>(null)
  const [timelineHasMore, setTimelineHasMore] = useState(false)
  const [timelineLoading, setTimelineLoading] = useState(false)

  // Saved conversations (migration 074), sandbox only.
  const [saved, setSaved] = useState<SavedConversationSummary[]>([])
  const [savedError, setSavedError] = useState<string | null>(null)
  const [savedHasMore, setSavedHasMore] = useState(false)
  const [saving, setSaving] = useState(false)

  // Guards state updates from fetches that resolve after a venue/mode/guest
  // switch already reset the pane.
  const epochRef = useRef(0)

  const resetConversation = useCallback(() => {
    epochRef.current += 1
    setTurns([])
    setSelectedTurnId(null)
    setSession(null)
    setGuestId(null)
    setTimeline([])
    setTimelineError(null)
    setTimelineHasMore(false)
  }, [])

  const onVenueChange = useCallback(
    (id: string | null) => {
      setVenueId(id)
      setGuests([])
      setGuestsError(null)
      setActivityDegraded(false)
      setSaved([])
      setSavedError(null)
      setSavedHasMore(false)
      resetConversation()
    },
    [resetConversation],
  )

  const onModeChange = useCallback(
    (next: PlaygroundMode) => {
      setMode(next)
      resetConversation()
    },
    [resetConversation],
  )

  // Load the saved-conversation picker when sandbox mode has a venue. Keyed
  // on venueId only (not on `saved`), so a save refreshing the list cannot
  // re-trigger the fetch that produced it.
  const refreshSaved = useCallback((id: string) => {
    void fetchSavedConversations(id).then((result) => {
      if (result.ok) {
        setSaved(result.data.conversations)
        setSavedHasMore(result.data.hasMore)
        setSavedError(null)
      } else {
        setSaved([])
        setSavedError(result.error)
      }
    })
  }, [])

  useEffect(() => {
    if (mode !== 'sandbox' || venueId === null) return
    refreshSaved(venueId)
  }, [mode, venueId, refreshSaved])

  // Load the guest picker when replay mode has a venue.
  useEffect(() => {
    if (mode !== 'replay' || venueId === null) return
    const epoch = epochRef.current
    void fetchGuests(venueId).then((result) => {
      if (epochRef.current !== epoch) return
      if (result.ok) {
        setGuests(result.data.guests)
        setActivityDegraded(result.data.activityDegraded)
        setGuestsError(null)
      } else {
        setGuests([])
        setGuestsError(result.error)
      }
    })
  }, [mode, venueId])

  // Picking a guest loads their timeline directly from the event handler
  // (not an effect): the fetch is a response to the click, and the epoch
  // guard drops a response that lands after another selection reset the pane.
  const onSelectGuest = useCallback(
    (id: string | null) => {
      epochRef.current += 1
      setGuestId(id)
      setTimeline([])
      setTimelineError(null)
      setTimelineHasMore(false)
      setTurns([])
      setSelectedTurnId(null)
      if (id === null || venueId === null) return
      const epoch = epochRef.current
      setTimelineLoading(true)
      void fetchTimeline(venueId, id).then((result) => {
        if (epochRef.current !== epoch) return
        setTimelineLoading(false)
        if (result.ok) {
          setTimeline(result.data.messages)
          setTimelineHasMore(result.data.hasMore)
          setTimelineError(null)
        } else {
          setTimeline([])
          setTimelineError(result.error)
        }
      })
    },
    [venueId],
  )

  /**
   * The v1 arm a run should carry, from the LIVE toggle rather than from
   * whatever the turn was first sent with.
   *
   * This is a fix, not a refactor. Every rerun path hands `runNewTurn` or the
   * regenerate a STORED request, and the arm used to ride inside it - so
   * ticking "also run v1" and then pressing Regenerate ran no v1 arm at all,
   * silently, and the column simply never appeared. The toggle sits at the top
   * of the page and reads as current state, so it has to be read at run time.
   *
   * A replay arm needs the inbound row's id, which only the turn knows; with
   * no id there is no arm rather than a sandbox one, because a sandbox arm on
   * a replay turn would answer a different question from the column's label.
   */
  const v1ArmFor = useCallback(
    (
      turnMode: PlaygroundMode,
      replayMessageId: string | undefined,
    ): RunRequestBody['v1Arm'] | null => {
      if (!compareV1) return null
      if (turnMode === 'sandbox') return { mode: 'sandbox' }
      return replayMessageId === undefined
        ? null
        : { mode: 'replay', inboundMessageId: replayMessageId }
    },
    [compareV1],
  )

  /**
   * Run a brand-new turn (sandbox send, replay click, or rerun-from-here).
   *
   * THE ACTIVE PROMPT IS BAKED IN HERE, at the one funnel every new turn goes
   * through, and into the stored request rather than only into the fetch - so
   * the turn carries what it ran with, the same property the session snapshot
   * has. A rerun picks up whatever is in force NOW, which is what the strip at
   * the top of the page is showing; carrying the old one forward would make
   * the page describe a run it did not describe.
   */
  const runNewTurn = useCallback(
    (
      incoming: RunRequestBody,
      turnMode: PlaygroundMode,
      v1Reply: string[] | null,
      replayMessageId?: string,
    ) => {
      // v1Arm is DROPPED and rebuilt rather than spread through, because a
      // rerun hands back a stored request: spreading would carry the arm
      // whatever the toggle now says, and there is no way to spread an
      // absence.
      //
      // NEVER an arm on an outreach turn, whatever the toggle says: the route
      // 400s the pairing, because v1's sandbox arm answers an inbound and an
      // outreach turn has none to hand it.
      const rest = withoutV1Arm(incoming)
      const arm =
        incoming.outreach !== undefined
          ? null
          : v1ArmFor(turnMode, replayMessageId)
      const request: RunRequestBody = {
        ...rest,
        ...(arm !== null ? { v1Arm: arm } : {}),
        ...(activePrompt === null
          ? {}
          : {
              overrides: {
                ...incoming.overrides,
                promptBlocks: activePrompt.blocks,
              },
            }),
      }
      const id = nextTurnId()
      const turn: PlaygroundTurn = {
        id,
        mode: turnMode,
        request,
        status: 'running',
        runSeq: 0,
        v1Reply,
        ...(replayMessageId !== undefined ? { replayMessageId } : {}),
      }
      setTurns((prev) => [...prev, turn])
      setSelectedTurnId(id)
      setBusy(true)
      void postRun(request).then((result) => {
        setBusy(false)
        setTurns((prev) =>
          prev.map((t) => {
            if (t.id !== id) return t
            if (!result.ok)
              return { ...t, status: 'error', error: result.error }
            return {
              ...t,
              status: 'done',
              runSeq: t.runSeq + 1,
              response: result.data,
              error: undefined,
            }
          }),
        )
        // Sandbox: adopt the assessor's next session so the chat carries
        // profile, memory and state forward turn over turn.
        if (result.ok && turnMode === 'sandbox') {
          // `evaluationRan` and not a bare null check: a skipped assessor
          // produces no nextSession. On a guest turn carrying the previous
          // session forward unchanged would silently make the chat forget the
          // turn - but the playground never skips those. OUTREACH turns do
          // skip (run-turn.ts skips the assessor when there are no guest
          // words), and there carrying the previous session forward is the
          // correct behaviour this guard quietly provides.
          const assessor = result.data.trace.assessor
          if (evaluationRan(assessor) && assessor.ok) {
            setSession(assessor.nextSession)
          }
        }
      })
    },
    [activePrompt, v1ArmFor],
  )

  const onSend = useCallback(
    (text: string) => {
      if (venueId === null || busy) return
      const request: RunRequestBody = {
        venueId,
        guestId: null,
        inbound: [text],
        sessionHistory: sessionHistoryFromTurns(turns),
        ...(session !== null ? { session } : {}),
        // The v1 arm is attached by `runNewTurn` from the live toggle - one
        // place, so every path agrees. v1 cannot run on a sandbox guest, so
        // the arm materializes the chat against the venue's synthetic guest;
        // see api/run/v1-arm.ts.
      }
      runNewTurn(request, 'sandbox', null)
    },
    [venueId, busy, turns, session, runNewTurn],
  )

  /**
   * Why "Venue writes first" cannot fire, or null when it can. The
   * no-completed-turn reason mirrors runTurn's own refusal - an outreach turn
   * with empty history is a dead turn there, so the button says why up front
   * rather than letting the run fail with the same sentence.
   */
  const outreachDisabledReason =
    mode !== 'sandbox'
      ? 'Outreach is a sandbox turn - replay mode replays what a real guest sent'
      : !turns.some((t) => t.status === 'done')
        ? 'An outreach turn needs history - complete at least one exchange first'
        : busy
          ? 'A run is in flight'
          : null

  /**
   * An outreach turn: the venue writing first after the chat went quiet. Same
   * request shape as a send with `inbound: []` plus the quiet-hours cue; the
   * gate gets the structural 'outreach' situation and the seeded
   * outreach_requires_approval row queues the draft, so the strip reads
   * "queue".
   *
   * The session deliberately does NOT advance afterwards: runTurn skips the
   * assessor on outreach (no guest words to assess), the trace carries
   * `assessor: {skipped: true}`, and runNewTurn's `evaluationRan` guard
   * already declines to adopt from a skipped assessor - the previous session
   * carries forward, which is correct because the guest said nothing to learn
   * from.
   */
  const onOutreach = useCallback(
    (hoursQuiet: number) => {
      if (venueId === null || busy || mode !== 'sandbox') return
      if (!turns.some((t) => t.status === 'done')) return
      const request: RunRequestBody = {
        venueId,
        guestId: null,
        inbound: [],
        sessionHistory: sessionHistoryFromTurns(turns),
        ...(session !== null ? { session } : {}),
        outreach: { hoursQuiet },
        // No v1Arm and no actualReply, ever: the route 400s either pairing.
        // runNewTurn skips the live toggle's arm on outreach for the same
        // reason.
      }
      runNewTurn(request, 'sandbox', null)
    },
    [venueId, busy, mode, turns, session, runNewTurn],
  )

  /**
   * Rewind the sandbox chat to just before `turnId`: later turns are
   * discarded and the rolling session restores from that turn's own request
   * (every request carries the session snapshot it ran with, so no replay
   * of the prefix is needed). 'rerun' re-runs the same inbound fresh;
   * 'edit' puts it in the composer instead.
   */
  const onRewind = useCallback(
    (turnId: string, mode: 'rerun' | 'edit') => {
      if (busy) return
      const idx = turns.findIndex((t) => t.id === turnId)
      if (idx === -1) return
      const turn = turns[idx]
      if (turn.mode !== 'sandbox') return
      epochRef.current += 1
      setTurns((prev) => prev.slice(0, idx))
      setSession(turn.request.session ?? null)
      setSelectedTurnId(idx > 0 ? turns[idx - 1].id : null)
      if (mode === 'rerun') {
        // Queued after the slice above, so the new turn appends to the
        // truncated list.
        runNewTurn(turn.request, 'sandbox', null, turn.replayMessageId)
      } else {
        setPrefill((p) => ({
          seq: (p?.seq ?? 0) + 1,
          text: turn.request.inbound.join('\n'),
        }))
      }
    },
    [busy, turns, runNewTurn],
  )

  const onReplayFrom = useCallback(
    (messageId: string) => {
      if (venueId === null || busy) return
      const context = buildReplayContext(timeline, messageId)
      if (context === null) return
      const request: RunRequestBody = {
        venueId,
        // Transcript-only on purpose: a real guestId would load history that
        // includes messages AFTER the replay point (see history.ts).
        guestId: null,
        inbound: context.inbound,
        sessionHistory: context.sessionHistory,
        session: context.session,
        // Judge what v1 actually sent alongside the v2 draft - same notes,
        // same transcript - so real replies become judge-calibration reads.
        ...(context.v1Reply !== null ? { actualReply: context.v1Reply } : {}),
        // The live arm is attached by `runNewTurn`, which is why the row id
        // travels as its own argument. When it runs, three things end up on a
        // replay turn and they are three different claims: what v1 sent at the
        // time, what v1 would send today, and what v2 drafts now.
      }
      runNewTurn(request, 'replay', context.v1Reply, messageId)
    },
    [venueId, busy, timeline, runNewTurn],
  )

  /**
   * Re-run the selected turn with overrides; replaces its trace in place.
   *
   * The inspector always sends `promptBlocks` - the full set, empty when
   * nothing is edited - so this is also where the active prompt is SET and
   * CLEARED. One source of truth: whatever you last regenerated with is what
   * the next turn and the next page load use. Were this conditional on the set
   * being non-empty, "Reset to composed" plus Regenerate would run the
   * composed prompt once and then silently go back to the pinned one.
   */
  const onRegenerate = useCallback(
    (overrides: TurnOverrides) => {
      const turn = turns.find((t) => t.id === selectedTurnId)
      if (turn === undefined || busy) return
      if (venueId !== null && overrides.promptBlocks !== undefined)
        setActivePrompt({
          venueId,
          promptVersion: V2_PROMPT_VERSION,
          blocks: overrides.promptBlocks,
        })
      const rest = withoutV1Arm(turn.request)
      // Same refusal as runNewTurn: regenerating an outreach turn with the v1
      // toggle on must not attach the arm the route rejects.
      const arm =
        turn.request.outreach !== undefined
          ? null
          : v1ArmFor(turn.mode, turn.replayMessageId)
      const request: RunRequestBody = {
        ...rest,
        overrides,
        ...(arm !== null ? { v1Arm: arm } : {}),
      }
      setBusy(true)
      setTurns((prev) =>
        prev.map((t) => (t.id === turn.id ? { ...t, status: 'running' } : t)),
      )
      void postRun(request).then((result) => {
        setBusy(false)
        setTurns((prev) =>
          prev.map((t) => {
            if (t.id !== turn.id) return t
            if (!result.ok)
              return { ...t, status: 'error', error: result.error }
            return {
              ...t,
              status: 'done',
              runSeq: t.runSeq + 1,
              request,
              previousTrace: t.response?.trace,
              response: result.data,
              error: undefined,
            }
          }),
        )
      })
    },
    [turns, selectedTurnId, busy, venueId, v1ArmFor],
  )

  const onSaveConversation = useCallback(
    (name: string) => {
      if (venueId === null || busy || saving) return
      const payload = savedTurnsFromPlayground(turns)
      if (payload.length === 0) return
      setSaving(true)
      void postSaveConversation(venueId, {
        name,
        turns: payload,
        // The live session, which is the state AFTER the last completed turn
        // - not any turn's own `request.session`, which is the state it ran
        // WITH. Getting these two confused restores a conversation one turn
        // stale, silently.
        nextSession: session,
      }).then((result) => {
        setSaving(false)
        if (result.ok) {
          setSaved((prev) => [result.data, ...prev])
          setSavedError(null)
        } else {
          setSavedError(result.error)
        }
      })
    },
    [venueId, busy, saving, turns, session],
  )

  const onLoadConversation = useCallback(
    (conversationId: string) => {
      if (venueId === null || busy) return
      epochRef.current += 1
      const epoch = epochRef.current
      void fetchSavedConversation(venueId, conversationId).then((result) => {
        if (epochRef.current !== epoch) return
        if (!result.ok) {
          setSavedError(result.error)
          return
        }
        const restored = turnsFromSaved(venueId, result.data.turns, nextTurnId)
        setTurns(restored)
        setSession(result.data.nextSession)
        // Nothing selected: every restored turn opens the "trace not saved"
        // panel, so auto-selecting one would greet the load with an explanation
        // of what is missing rather than the conversation itself.
        setSelectedTurnId(null)
        setSavedError(null)
      })
    },
    [venueId, busy],
  )

  const onDeleteConversation = useCallback(
    (conversationId: string) => {
      if (venueId === null) return
      void deleteSavedConversation(venueId, conversationId).then((result) => {
        if (result.ok) {
          setSaved((prev) => prev.filter((c) => c.id !== conversationId))
          setSavedError(null)
        } else {
          setSavedError(result.error)
        }
      })
    },
    [venueId],
  )

  const selectedTurn = turns.find((t) => t.id === selectedTurnId) ?? null
  const savableTurnCount = savedTurnsFromPlayground(turns).length

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-0 flex-col overflow-hidden rounded-[2px] border border-stone-light/60 bg-paper">
      <SetupBar
        venues={venues}
        selectedVenueId={venueId}
        mode={mode}
        busy={busy}
        compareV1={compareV1}
        saved={saved}
        savedError={savedError}
        savedHasMore={savedHasMore}
        onVenueChange={onVenueChange}
        onModeChange={onModeChange}
        onCompareV1Change={setCompareV1}
        onLoadConversation={onLoadConversation}
        onDeleteConversation={onDeleteConversation}
      />

      {/* An override nobody can see is an override that makes every later
          reading of this page wrong, so it gets a strip rather than a badge
          inside a collapsed section. HOUSE NOTES is called out by name: it is
          rebuilt every turn from retrieval and the guest's state, so pinning it
          hands a stale brief to every turn after the one it was taken on. */}
      {activePrompt !== null && venueId !== null && (
        <div className="flex items-center gap-2 border-b border-clay-soft bg-clay-soft/30 px-3 py-1.5">
          <span className="text-[11px] uppercase tracking-wider text-clay-deep">
            prompt edit in force
          </span>
          <span className="text-xs text-ink">
            {activePrompt.blocks.map((b) => b.label).join(', ')} replaced on
            every turn
            {activePrompt.promptVersion !== V2_PROMPT_VERSION &&
              ` · edited on ${activePrompt.promptVersion}, template is now ${V2_PROMPT_VERSION}`}
          </span>
          {activePrompt.blocks.some((b) => b.label === 'HOUSE NOTES') && (
            <span className="text-[11px] font-bold uppercase tracking-wider text-red-700">
              house notes is pinned - every turn gets this brief, not its own
            </span>
          )}
          <button
            type="button"
            onClick={() => clearActivePrompt(venueId)}
            className="ml-auto cursor-pointer text-[11px] uppercase tracking-wider text-clay-deep hover:text-destructive"
          >
            clear
          </button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_440px]">
        <div className="flex min-h-0 flex-col border-r border-stone-light/60">
          {mode === 'replay' && venueId !== null && (
            <div className="flex max-h-[45%] min-h-0 flex-col">
              <ReplayPane
                guests={guests}
                guestsError={guestsError}
                activityDegraded={activityDegraded}
                selectedGuestId={guestId}
                timeline={timeline}
                timelineError={timelineError}
                timelineHasMore={timelineHasMore}
                timelineLoading={timelineLoading}
                busy={busy}
                onSelectGuest={onSelectGuest}
                onReplayFrom={onReplayFrom}
              />
            </div>
          )}
          <ChatPane
            turns={turns}
            selectedTurnId={selectedTurnId}
            canSend={venueId !== null}
            busy={busy}
            prefill={prefill}
            onRewind={onRewind}
            emptyHint={
              mode === 'sandbox'
                ? venueId === null
                  ? 'Pick a venue, then message as a sandbox guest.'
                  : 'Message as a sandbox guest. Each send runs one full v2 turn.'
                : 'Click an inbound message in the timeline above to replay it through v2.'
            }
            showComposer={mode === 'sandbox'}
            onSend={onSend}
            onSelectTurn={setSelectedTurnId}
            savableTurnCount={savableTurnCount}
            saving={saving}
            onSaveConversation={onSaveConversation}
            outreachDisabledReason={outreachDisabledReason}
            onOutreach={onOutreach}
          />
        </div>

        <div className="min-h-0 overflow-hidden">
          <Inspector
            turn={selectedTurn}
            busy={busy}
            onRegenerate={onRegenerate}
          />
        </div>
      </div>
    </div>
  )
}
