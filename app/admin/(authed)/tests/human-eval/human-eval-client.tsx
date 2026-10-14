'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { postRun } from '../../playground/_lib/api'
import type { VenueListRow } from '../../_lib/load-venues'
import { goldenSessionFor, goldenTurnFor } from '@/lib/eval/golden-turn'
import { goldenV1FromOutcome, goldenV2FromTrace } from '@/lib/eval/golden-arms'
import {
  humanEvalCompleteness,
  humanEvalQuestions,
  isUnitJudgeable,
  judgmentComplete,
  judgmentFromUnit,
  type HumanEvalJudgment,
} from '@/lib/eval/human-eval'
import { patchJudgment, postPair, postPass, postSubmit } from './_lib/api'
import type {
  HumanEvalPageData,
  HumanEvalSessionView,
  HumanEvalUnitView,
} from './_lib/types'
import { BlindRow } from './_components/blind-row'
import { SessionBar } from './_components/session-bar'

// Client orchestrator for the blind human evaluation: generate both engines'
// answers to the golden set, then judge them without being told which is
// which.
//
// FAN-OUT IS CLIENT-SIDE, one request per question through the playground's
// existing run route with its v1 arm switched on. Not one 58-way server
// request: that route's budget is 110s against a 120s platform ceiling, and a
// pass is a quarter of an hour - it would be killed mid-flight and hand back
// nothing. Per question, each request is an ordinary two-armed turn, pairs
// land as they finish, and a failure costs one row.
//
// CONCURRENCY IS 4, AND THE BINDING LIMIT IS SANDBOX SLOTS, NOT THE PROVIDER.
// The v1 arm materializes its transcript by deleting the venue's synthetic
// guest's messages and rewriting them, so each in-flight arm needs its own
// slot and a worker holds its slot for the whole pass - handing slots out per
// QUESTION would let two questions share one the moment a worker finished
// early, which is the collision the slots exist to prevent. 4 rather than the
// full ten because each request is v1's generation plus v2's three calls.
//
// The ceiling is NOT imported from `SANDBOX_SLOTS` here, deliberately: that
// constant lives beside the v1 arm in a server module that pulls the whole v1
// orchestrator, and a value import would drag it into this bundle. The route
// bounds `slot` against the real constant instead, so a raised CONCURRENCY
// past it is a 400 on the first request rather than two questions silently
// sharing a transcript.
//
// TWO THINGS A PASS WRITES THAT A READER SHOULD KNOW ABOUT: production
// `messages` rows against the per-venue `is_test_synthetic` sandbox guests
// (that is how v1 gets a context built by production's own queries - v1-arm.ts
// explains why a hand-built one would be worse), and a row per pair the moment
// it lands. The first is why a pass belongs in the venue's OPEN HOURS, and why
// nobody should run `measure-golden-set` at the same time: the slot namespace
// is per venue and shared with it.

const CONCURRENCY = 4

type SaveState = 'idle' | 'saving' | 'saved' | { error: string }

/** One key gone from a record, without mutating the one React is holding. */
function withoutKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

export function HumanEvalClient({
  venues,
  venueId,
  data,
}: {
  venues: VenueListRow[]
  venueId: string | null
  data: HumanEvalPageData
}) {
  /**
   * The pass on screen. Seeded from the server and then owned here: the
   * session id is NOT in the URL, because navigating to add it would re-render
   * the server component in the middle of a 15-minute fan-out. A reload lands
   * on the newest pass, which is this one.
   */
  const [session, setSession] = useState<HumanEvalSessionView | null>(
    data.session,
  )
  const [units, setUnits] = useState<Record<string, HumanEvalUnitView>>(() =>
    Object.fromEntries(
      (data.session?.units ?? []).map((u) => [u.questionKey, u]),
    ),
  )
  const [running, setRunning] = useState<Record<string, true>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, SaveState>>({})
  /**
   * Judgments clicked but not yet confirmed by storage, keyed by unit id. The
   * row renders this when it is there and the stored row when it is not - see
   * `onJudge` for the two failures that makes impossible.
   */
  const [pending, setPending] = useState<Record<string, HumanEvalJudgment>>({})
  /** One serialized write queue per unit. Also `onJudge`. */
  const writeQueues = useRef<
    Record<string, { chain: Promise<void>; inFlight: number }>
  >({})
  const [fatal, setFatal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const cancelRef = useRef(false)
  /**
   * The pass is finished: every control goes read-only and the CSV exists.
   * Read off the session, which the submit response updates, so a reload and
   * a fresh submit land in the same state.
   */
  const readOnly = session?.submittedAt != null

  const questions = useMemo(() => humanEvalQuestions(), [])
  const missing = useMemo(
    () => questions.filter((q) => units[q.key] === undefined),
    [questions, units],
  )
  const judged = Object.values(units).filter(
    (u) => u.aVerdict !== null && u.bVerdict !== null,
  ).length
  /**
   * Judged rows that still owe a comment, which a failing verdict requires
   * (`judgmentComplete`). Counted and SHOWN rather than folded into `judged`:
   * the two numbers answer different questions - how much of the pass has
   * been looked at, and how much of it is actually usable - and a pass that
   * reads as finished while its findings are blank is the one failure this
   * requirement exists to prevent.
   *
   * Read off the stored rows, so it only counts a comment the database has.
   */
  const needComment = Object.values(units).filter(
    (u) =>
      u.aVerdict !== null &&
      u.bVerdict !== null &&
      !judgmentComplete(judgmentFromUnit(u)),
  ).length
  /**
   * What is still in the way of submitting, by the SAME function the submit
   * route runs against the stored rows. The button it labels is advisory -
   * the route decides - but the two cannot describe the pass differently.
   */
  const completeness = useMemo(() => {
    const all = Object.values(units)
    const inSet = new Set(questions.map((q) => q.key))
    return humanEvalCompleteness(
      all.map((u) => ({
        judgeable: isUnitJudgeable(u),
        aVerdict: u.aVerdict,
        bVerdict: u.bVerdict,
        note: u.note,
      })),
      questions.length,
      all.filter((u) => inSet.has(u.questionKey)).length,
    )
  }, [units, questions])

  /** One question, both arms, stored. Returns nothing - it writes state. */
  const generateOne = useCallback(
    async (
      sessionId: string,
      questionKey: string,
      slot: number,
    ): Promise<void> => {
      const question = questions.find((q) => q.key === questionKey)
      if (question === undefined) return
      const { turn, skip } = goldenTurnFor(question)
      // Unreachable: the queue is `humanEvalQuestions`, which is defined as
      // the questions with no skip. Named rather than assumed, so a future
      // third skip reason surfaces here instead of asking v2 something the
      // harness never would.
      if (skip !== null || venueId === null) return

      setRunning((p) => ({ ...p, [questionKey]: true }))
      setRowErrors((p) => withoutKey(p, questionKey))
      const run = await postRun({
        venueId,
        guestId: null,
        inbound: turn.inbound,
        sessionHistory: turn.history,
        // The same guest picture the harness gives v2, from the same
        // function - zero visits, empty profile, the real reply count.
        session: goldenSessionFor(turn),
        // The judge and the assessor would be two more model calls per
        // question whose output this surface never renders. The gate does not
        // read them, and nothing chains off a single-turn scenario.
        skipEvaluation: true,
        v1Arm: { mode: 'sandbox', slot },
      })
      setRunning((p) => withoutKey(p, questionKey))
      if (!run.ok) {
        setRowErrors((p) => ({ ...p, [questionKey]: run.error }))
        return
      }
      const { trace, v1, armMs } = run.data
      // The route was asked for a v1 arm, so this is a contract violation
      // rather than an empty column - reported as the row's error instead of
      // being stored as a reply v1 never gave.
      if (v1 === null || armMs.v1 === null) {
        setRowErrors((p) => ({
          ...p,
          [questionKey]: 'the run returned no v1 arm, so there is no pair',
        }))
        return
      }
      const stored = await postPair({
        sessionId,
        questionKey,
        v1: goldenV1FromOutcome(v1.outcome, armMs.v1),
        // The version that actually composed the prompt, off the trace.
        v2: goldenV2FromTrace(trace, trace.composed.promptVersion, armMs.v2),
      })
      if (!stored.ok) {
        // The pair was generated and is now lost - that is real money and the
        // row says so rather than reading as "not generated yet".
        setRowErrors((p) => ({
          ...p,
          [questionKey]: `both replies were generated but could not be stored: ${stored.error}`,
        }))
        return
      }
      setUnits((p) => ({ ...p, [questionKey]: stored.data.unit }))
    },
    [questions, venueId],
  )

  const runQueue = useCallback(
    async (sessionId: string, keys: readonly string[]): Promise<void> => {
      let next = 0
      const worker = async (slot: number): Promise<void> => {
        for (;;) {
          if (cancelRef.current) return
          const i = next
          next += 1
          if (i >= keys.length) return
          await generateOne(sessionId, keys[i], slot)
        }
      }
      // A worker keeps its slot for the whole pass. See the header.
      await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, slot) => worker(slot)),
      )
    },
    [generateOne],
  )

  /**
   * The pass to write into, opening one if this venue has none yet.
   *
   * Shared by the bulk button and the per-row one: a single row generated on a
   * venue with no pass yet has to open one too, and the first version of this
   * returned early instead - the row's button did nothing at all, silently,
   * which is exactly the kind of dead affordance a page cannot afford on its
   * first click.
   */
  const ensureSession =
    useCallback(async (): Promise<HumanEvalSessionView | null> => {
      if (session !== null) return session
      if (venueId === null) return null
      const created = await postPass(venueId)
      if (!created.ok) {
        setFatal(created.error)
        return null
      }
      setSession(created.data.session)
      return created.data.session
    }, [session, venueId])

  const onGenerate = useCallback(() => {
    if (busy || venueId === null || readOnly) return
    setBusy(true)
    setFatal(null)
    cancelRef.current = false
    void (async () => {
      const current = await ensureSession()
      if (current === null) {
        setBusy(false)
        return
      }
      await runQueue(
        current.id,
        missing.map((q) => q.key),
      )
      setBusy(false)
    })()
  }, [busy, venueId, readOnly, ensureSession, missing, runQueue])

  /** One question - a pending row's Generate, or a judged row's Regenerate. */
  const onGenerateOne = useCallback(
    (questionKey: string) => {
      if (busy || readOnly) return
      const unit = units[questionKey]
      // Confirmed, because this clears a verdict the rater already gave: the
      // new pair is a different reply and the old judgment is not about it.
      if (
        unit !== undefined &&
        (unit.aVerdict !== null || unit.bVerdict !== null) &&
        !window.confirm(
          'Re-generating replaces both replies and clears the verdicts on this row. Continue?',
        )
      )
        return
      setBusy(true)
      setFatal(null)
      cancelRef.current = false
      void (async () => {
        const current = await ensureSession()
        if (current === null) {
          setBusy(false)
          return
        }
        await runQueue(current.id, [questionKey])
        setBusy(false)
      })()
    },
    [busy, readOnly, units, ensureSession, runQueue],
  )

  const onCancel = useCallback(() => {
    cancelRef.current = true
  }, [])

  /**
   * Finish the pass, then fetch its CSV.
   *
   * IN THAT ORDER, AND ONLY IN THAT ORDER. The export route refuses an
   * unsubmitted pass, so the download cannot be the thing that happens when
   * the stamp did not - a failed submit leaves the error on screen and no
   * file, which is the honest outcome. The confirm is because this is
   * one-way: there is no unsubmit, by design.
   */
  const onSubmit = useCallback(() => {
    if (session === null || submitting || readOnly) return
    if (
      !window.confirm(
        'Submitting freezes this pass - no more verdicts, comments or re-generating - and generates its CSV. There is no undo. Continue?',
      )
    )
      return
    setSubmitting(true)
    setSubmitError(null)
    void (async () => {
      const result = await postSubmit(session.id)
      setSubmitting(false)
      if (!result.ok) {
        setSubmitError(result.error)
        return
      }
      setSession({ ...session, submittedAt: result.data.submittedAt })
      // A plain navigation rather than fetch-and-blob: the route answers with
      // Content-Disposition: attachment, so the browser saves it and the page
      // stays exactly where it was, scroll position included.
      window.location.href = `/admin/tests/human-eval/api/export?sessionId=${session.id}`
    })()
  }, [session, submitting, readOnly])

  /**
   * Record a judgment.
   *
   * TWO THINGS HERE ARE NOT OPTIONAL, and both were found by using the page
   * rather than by reading it.
   *
   * THE WRITES FOR ONE ROW ARE SERIALIZED. Clicking a control after typing a
   * note fires TWO writes - the textarea's blur, then the click - and
   * unordered responses meant the stale one landed last and overwrote what
   * the database had actually recorded, leaving the row showing the older
   * state of a field the rater had just changed.
   *
   * THE PENDING INTENT IS WHAT THE NEXT CLICK COMPOSES WITH, not the last
   * stored row. Every write carries the whole judgment, so a second click
   * arriving before the first response would have been built from a row that
   * did not have the first verdict in it yet - and would have written it back
   * as null. Marking A and then B quickly would have silently lost A.
   *
   * The stored row is still what renders once the queue drains, so a write
   * that FAILED cannot leave the row looking saved: the error stays on screen
   * and the pending value stays with it rather than reverting under the
   * rater's cursor.
   */
  const onJudge = useCallback((unitId: string, judgment: HumanEvalJudgment) => {
    setPending((p) => ({ ...p, [unitId]: judgment }))
    setSaving((p) => ({ ...p, [unitId]: 'saving' }))
    const queue = writeQueues.current
    const slot = queue[unitId] ?? { chain: Promise.resolve(), inFlight: 0 }
    slot.inFlight += 1
    slot.chain = slot.chain.then(async () => {
      const result = await patchJudgment(unitId, judgment)
      slot.inFlight -= 1
      if (!result.ok) {
        setSaving((p) => ({ ...p, [unitId]: { error: result.error } }))
        return
      }
      setUnits((p) => ({
        ...p,
        [result.data.unit.questionKey]: result.data.unit,
      }))
      // Only the LAST write in the queue hands the row back to storage. A
      // middle one clearing the pending intent would show the row as it was
      // two clicks ago until the next response landed.
      if (slot.inFlight === 0) {
        setSaving((p) => ({ ...p, [unitId]: 'saved' }))
        setPending((p) => withoutKey(p, unitId))
      }
    })
    queue[unitId] = slot
  }, [])

  const runningCount = Object.keys(running).length

  return (
    <div className="flex flex-col overflow-hidden rounded-[2px] border border-stone-light/60 bg-paper">
      <SessionBar
        venues={venues}
        venueId={venueId}
        sessions={data.sessions}
        session={session}
        missing={missing.length}
        generated={Object.keys(units).length}
        judged={judged}
        needComment={needComment}
        judgeable={questions.length}
        running={runningCount}
        busy={busy}
        completeness={session === null ? null : completeness}
        submitting={submitting}
        submitError={submitError}
        onGenerate={onGenerate}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />

      {fatal !== null ? (
        <p
          className="border-b border-stone-light/60 px-4 py-3 text-xs text-destructive"
          role="alert"
        >
          {fatal}
        </p>
      ) : null}

      {questions.map((question) => {
        const unit = units[question.key]
        const error = rowErrors[question.key]
        if (unit === undefined)
          return (
            <PendingRow
              key={question.key}
              label={question.question}
              questionKey={question.key}
              running={running[question.key] === true}
              error={error}
              // A question ADDED to the golden set after this pass was
              // submitted shows up here, on a pass that can no longer take a
              // pair. Disabled rather than offered-then-409'd.
              busy={busy || readOnly}
              onGenerate={() => onGenerateOne(question.key)}
            />
          )
        return (
          <div key={question.key}>
            {error !== undefined ? (
              <p
                className="px-4 pt-3 text-[11px] text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            <BlindRow
              question={unit.question}
              unit={unit}
              judgment={pending[unit.id] ?? judgmentFromUnit(unit)}
              saveState={saving[unit.id] ?? 'idle'}
              busy={busy}
              readOnly={readOnly}
              onJudge={(judgment) => onJudge(unit.id, judgment)}
              onRegenerate={() => onGenerateOne(question.key)}
            />
          </div>
        )
      })}

      {/* Rows this pass generated for a question that is no longer in the set.
          Kept visible: the verdict was still given, and dropping them would
          make an older pass look shorter than it was. */}
      {Object.values(units)
        .filter((u) => u.question === null)
        .map((unit) => (
          <BlindRow
            key={unit.id}
            question={null}
            unit={unit}
            judgment={pending[unit.id] ?? judgmentFromUnit(unit)}
            saveState={saving[unit.id] ?? 'idle'}
            busy={busy}
            readOnly={readOnly}
            onJudge={(judgment) => onJudge(unit.id, judgment)}
            onRegenerate={() => onGenerateOne(unit.questionKey)}
          />
        ))}
    </div>
  )
}

/**
 * A question with no pair yet. Never a blank row - it says which state it is
 * in, and carries its own Generate.
 *
 * THAT BUTTON IS NOT A CONVENIENCE. Without it the only way to generate
 * anything is the bulk button, which is every missing question at once - so
 * re-doing one row after a provider hiccup, or getting a single pair to look
 * at, would cost the whole pass. It is also the only affordance that makes the
 * first row cheap to try before committing to a quarter of an hour.
 */
function PendingRow({
  label,
  questionKey,
  running,
  error,
  busy,
  onGenerate,
}: {
  label: string
  questionKey: string
  running: boolean
  error: string | undefined
  busy: boolean
  onGenerate: () => void
}) {
  return (
    <div className="flex items-baseline gap-2 border-b border-stone-light/60 px-4 py-2.5">
      <span className="text-sm text-ink-soft">{label}</span>
      <span className="font-mono text-[11px] text-ink-faint">
        {questionKey}
      </span>
      <span className="ml-auto flex items-center gap-3 text-[11px]">
        {error !== undefined ? (
          <span className="text-destructive" role="alert">
            {error}
          </span>
        ) : running ? (
          <span className="text-ink-faint">generating both replies…</span>
        ) : (
          <span className="text-ink-faint">not generated yet</span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          disabled={busy}
          onClick={onGenerate}
        >
          Generate
        </Button>
      </span>
    </div>
  )
}
