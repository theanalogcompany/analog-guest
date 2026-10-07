'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
// with ONE deliberate exception: a sandbox conversation can be saved to
// playground_conversations (migration 074) and read back.
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

export function PlaygroundClient({ venues }: { venues: VenueListRow[] }) {
  const [venueId, setVenueId] = useState<string | null>(null)
  const [mode, setMode] = useState<PlaygroundMode>('sandbox')

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

  /** Run a brand-new turn (sandbox send or replay click). */
  const runNewTurn = useCallback(
    (
      request: RunRequestBody,
      turnMode: PlaygroundMode,
      v1Reply: string[] | null,
    ) => {
      const id = nextTurnId()
      const turn: PlaygroundTurn = {
        id,
        mode: turnMode,
        request,
        status: 'running',
        runSeq: 0,
        v1Reply,
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
          const assessor = result.data.trace.assessor
          if (assessor !== null && assessor.ok) {
            setSession(assessor.nextSession)
          }
        }
      })
    },
    [],
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
        // Only when the operator asked for it. v1 cannot run on a sandbox
        // guest, so the arm materializes the chat against the venue's
        // synthetic guest - see api/run/v1-arm.ts.
        ...(compareV1 ? { v1Arm: { mode: 'sandbox' as const } } : {}),
      }
      runNewTurn(request, 'sandbox', null)
    },
    [venueId, busy, turns, session, runNewTurn, compareV1],
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
        runNewTurn(turn.request, 'sandbox', null)
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
        // And, when asked, run v1 LIVE on the same inbound row. Three things
        // then end up on a replay turn and they are three different claims:
        // what v1 sent at the time, what v1 would send today, and what v2
        // drafts now.
        ...(compareV1
          ? { v1Arm: { mode: 'replay' as const, inboundMessageId: messageId } }
          : {}),
      }
      runNewTurn(request, 'replay', context.v1Reply)
    },
    [venueId, busy, timeline, runNewTurn, compareV1],
  )

  /** Re-run the selected turn with overrides; replaces its trace in place. */
  const onRegenerate = useCallback(
    (overrides: TurnOverrides) => {
      const turn = turns.find((t) => t.id === selectedTurnId)
      if (turn === undefined || busy) return
      const request: RunRequestBody = { ...turn.request, overrides }
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
    [turns, selectedTurnId, busy],
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
