'use client'

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-set'
import { goldenTurnFor } from '@/lib/eval/golden-turn'
import { V2_TEMPLATE_CURRENT } from '@/lib/ai/v2/template-archive'
import {
  V2_DEFAULT_EFFORT,
  V2_MODEL_KEYS,
  V2_PLAYGROUND_MAX_OUTPUT_TOKENS,
} from '@/lib/ai/v2/model-call'
import type { TurnOverrides } from '@/lib/relationship/run-turn'
import type { VenueListRow } from '../_lib/load-venues'
import { postRun } from '../playground/_lib/api'
import type { RunRequestBody } from '../playground/_lib/types'
import type { StoredV1Index } from './_lib/load-stored-v1'
import type { LabRow, LabV2Settled, LabV2State } from './_lib/types'
import {
  baselineFor,
  baselineServerSnapshot,
  baselineSnapshot,
  rememberBaseline,
  subscribeBaseline,
} from './_lib/baseline-store'
import {
  clearSweep,
  recordSweepResult,
  startSweep,
  subscribeSweep,
  sweepFor,
  sweepServerSnapshot,
  sweepSnapshot,
  type StoredSweepArm,
} from './_lib/sweep-store'
import { PromptPane } from './_components/prompt-pane'
import { QuestionList } from './_components/question-list'

// Client orchestrator for the prompt lab: one prompt, 67 golden questions, a
// stored v1 column and a live v2 one.
//
// FAN-OUT IS CLIENT-SIDE, one request per question through the playground's
// existing run route. Not one 62-way server request: that route's own budget is
// 110s against a 120s platform ceiling, and a sweep is minutes - it would be
// killed mid-flight and hand back nothing. Per question, each request is an
// ordinary turn, results land as they finish, and a failure costs one cell.
//
// CONCURRENCY IS 6 and the reason is the provider, not the browser. Each
// request is a generation plus a semantic check; the harness runs 8 but holds a
// sandbox slot per worker, which this does not need because nothing here
// touches v1 or writes a row.
//
// THE SWEEP IS CHECKPOINTED to localStorage as each answer lands
// (`_lib/sweep-store.ts`), so a reload keeps what was paid for.

const CONCURRENCY = 6

/**
 * Named rather than `V2_MODEL_KEYS[0]`, so reordering that list cannot
 * silently change which model this surface runs. `satisfies` is what makes a
 * rename of the profile key fail `tsc` here instead of at the first request.
 */
const LAB_DEFAULT_MODEL_KEY =
  'haiku-5-5' satisfies (typeof V2_MODEL_KEYS)[number]

export function PromptLabClient({
  venues,
  venueId,
  storedV1,
}: {
  venues: VenueListRow[]
  venueId: string | null
  storedV1: StoredV1Index
}) {
  const stored = useSyncExternalStore(
    subscribeSweep,
    sweepSnapshot,
    sweepServerSnapshot,
  )
  const sweep = sweepFor(stored, venueId)

  const baselines = useSyncExternalStore(
    subscribeBaseline,
    baselineSnapshot,
    baselineServerSnapshot,
  )

  /**
   * Live run state, keyed by question. SEPARATE from the stored sweep because
   * `running` is deliberately not storable - a restored spinner with nothing
   * driving it reads as a hung page.
   */
  const [live, setLive] = useState<Record<string, LabV2State>>({})
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef(false)

  // The prompt and call parameters the next run uses. Held here rather than in
  // the pane so a sweep and a single run cannot disagree about what they ran.
  const [systemText, setSystemText] = useState<string | null>(null)
  // Read inside `runOne`, which must see the CURRENT edit state rather than
  // whatever was captured when the callback was built.
  const systemTextRef = useRef(systemText)
  systemTextRef.current = systemText
  const [promptName, setPromptName] = useState('')
  const [templateVersion, setTemplateVersion] = useState(
    V2_TEMPLATE_CURRENT.version,
  )
  // The LAB's defaults, which are not production's. Haiku because a sweep is
  // 58 generations of prompt iteration and it is the cheap seat, and 20k
  // because thinking is charged against the same budget as the reply - `high`
  // on haiku spent 213 of 1,000 on a measured turn and `max` truncates at that
  // ceiling every time, which surfaces as the model failing rather than as a
  // budget. Production still sends V2_GENERATE_MAX_OUTPUT_TOKENS, and the
  // field says so underneath it.
  const [modelKey, setModelKey] = useState<string>(LAB_DEFAULT_MODEL_KEY)
  const [effort, setEffort] = useState<string>(V2_DEFAULT_EFFORT)
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    V2_PLAYGROUND_MAX_OUTPUT_TOKENS,
  )

  /**
   * The editable baseline: the stable system blocks for this venue at this
   * template version, as the composer last built them. '' until a question has
   * been run at least once in some session - it SURVIVES a reload, which is
   * the point, because a restored sweep with an empty editor reads as a
   * surface that lost the prompt it was built to edit.
   */
  const composedSystemText = baselineFor(baselines, venueId, templateVersion)

  const rows: LabRow[] = useMemo(
    () =>
      GOLDEN_QUESTIONS.map((question) => {
        const { skip } = goldenTurnFor(question)
        return {
          question,
          storedV1: storedV1.cells[question.key] ?? null,
          // Live wins over stored: a question just re-run shows the new
          // answer, not the one the sweep checkpointed before it. A scenario
          // v2 cannot be asked shows its reason WITHOUT being asked first -
          // `goldenTurnFor` is pure, so the gap is knowable here, and a gap
          // rendered as "not asked yet" reads as work left to do.
          v2:
            live[question.key] ??
            sweep?.results[question.key] ??
            (skip === null
              ? undefined
              : { status: 'not_run', reason: `${skip.stage}: ${skip.error}` }),
        }
      }),
    [storedV1, live, sweep],
  )

  const armOf = useCallback(
    (): StoredSweepArm => ({
      promptName,
      promptEdited: systemText !== null,
      templateVersion,
      modelKey,
      effort,
      maxOutputTokens,
    }),
    [
      promptName,
      systemText,
      templateVersion,
      modelKey,
      effort,
      maxOutputTokens,
    ],
  )

  const overridesOf = useCallback((): TurnOverrides => {
    const o: TurnOverrides = {
      modelKey: modelKey as TurnOverrides['modelKey'],
      effort: effort as TurnOverrides['effort'],
      maxOutputTokens,
    }
    if (systemText !== null) o.systemText = systemText
    if (templateVersion !== V2_TEMPLATE_CURRENT.version)
      o.templateVersion = templateVersion
    return o
  }, [systemText, modelKey, effort, maxOutputTokens, templateVersion])

  /** One question, live. Returns the state it settled on. */
  const runOne = useCallback(
    async (key: string): Promise<LabV2Settled> => {
      const question = GOLDEN_QUESTIONS.find((q) => q.key === key)
      if (question === undefined)
        return { status: 'error', error: 'no such question' }
      const { turn, skip } = goldenTurnFor(question)
      // Declined, not failed - the same refusal the harness makes, from the
      // same function, so the two surfaces cannot ask v2 different things.
      if (skip !== null)
        return { status: 'not_run', reason: `${skip.stage}: ${skip.error}` }
      if (venueId === null)
        return { status: 'error', error: 'no venue selected' }

      const request: RunRequestBody = {
        venueId,
        guestId: null,
        inbound: turn.inbound,
        sessionHistory: turn.history,
        // Proactive scenarios run as v2 outreach turns (goldenTurnFor is the
        // one place that decides which, so this surface and the harness agree).
        ...(turn.outreach !== undefined ? { outreach: turn.outreach } : {}),
        overrides: overridesOf(),
      }
      const result = await postRun(request)
      if (!result.ok) return { status: 'error', error: result.error }
      const trace = result.data.trace
      // `composedWithoutPromptEdit` and not `composed`: the editor's baseline
      // has to be the prompt the composer builds, or an edit would be diffed
      // against its own output and the next run would carry nothing.
      const base = trace.composedWithoutPromptEdit ?? trace.composed
      // PLAIN concatenation, in block order, with no delimiters. This is the
      // document the operator edits and the exact string that goes back as
      // `systemText`, so what is on screen and what is sent are the same bytes
      // rather than two serializations that have to agree.
      const asText = base.system.map((b) => b.text).join('\n\n')
      // Recorded on EVERY run, not only the first, so a template edited under
      // a reused version string cannot leave a stale baseline behind for an
      // edit to be diffed against - but NEVER while an edit is open, because
      // replacing the baseline under an open edit would silently swap what
      // Reset goes back to. `systemTextRef` and not `systemText`: this closure
      // is rebuilt per run and would otherwise capture the state from before
      // it.
      if (systemTextRef.current === null)
        rememberBaseline({
          venueId,
          templateVersion: base.promptVersion,
          text: asText,
        })
      const g = trace.generation
      if (!g.ok) return { status: 'error', error: g.error }
      return {
        status: 'done',
        bubbles: g.output.messages,
        verdict: trace.gate?.verdict ?? null,
        promptVersion: trace.composed.promptVersion,
        model: trace.modelCall.model,
        effort: trace.modelCall.effort,
        durationMs: g.durationMs,
        thinkingTokens: g.thinkingTokens,
      }
    },
    [venueId, overridesOf],
  )

  const onRunOne = useCallback(
    (key: string) => {
      if (busy || venueId === null) return
      setBusy(true)
      setLive((p) => ({ ...p, [key]: { status: 'running' } }))
      void runOne(key).then((state) => {
        setLive((p) => ({ ...p, [key]: state }))
        recordSweepResult(venueId, key, state, {
          arm: armOf(),
          startedAt: new Date().toISOString(),
        })
        setBusy(false)
      })
    },
    [busy, venueId, runOne, armOf],
  )

  const onRunAll = useCallback(() => {
    if (busy || venueId === null) return
    cancelRef.current = false
    setBusy(true)
    setLive({})
    const startedAt = new Date().toISOString()
    startSweep(venueId, armOf(), startedAt)

    // Only what v2 can actually be asked. The rest already render their
    // reason from `goldenTurnFor`, so queueing them would spend six slots to
    // re-derive a constant and make the progress count read as work.
    const queue = GOLDEN_QUESTIONS.filter(
      (q) => goldenTurnFor(q).skip === null,
    ).map((q) => q.key)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (cancelRef.current) return
        const i = next++
        if (i >= queue.length) return
        const key = queue[i]
        setLive((p) => ({ ...p, [key]: { status: 'running' } }))
        const state = await runOne(key)
        setLive((p) => ({ ...p, [key]: state }))
        // Checkpointed here, one at a time, rather than once at the end: the
        // expensive half is the model calls and losing them to a late failure
        // in the cheap half is the specific failure being prevented.
        recordSweepResult(venueId, key, state, {
          arm: armOf(),
          startedAt: startedAt,
        })
      }
    }
    void Promise.all(
      Array.from({ length: CONCURRENCY }, () => worker()),
    ).finally(() => setBusy(false))
  }, [busy, venueId, armOf, runOne])

  const onCancel = useCallback(() => {
    cancelRef.current = true
  }, [])

  const askable = GOLDEN_QUESTIONS.filter(
    (q) => goldenTurnFor(q).skip === null,
  ).length

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-0 flex-col overflow-hidden rounded-[2px] border border-stone-light/60 bg-paper">
      <div className="flex h-14 shrink-0 items-center gap-4 border-b border-stone-light/60 px-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider text-ink-soft">
            Venue
          </span>
          <Select
            value={venueId ?? ''}
            onValueChange={(v) => {
              window.location.search = `?venue=${v}`
            }}
            disabled={busy}
          >
            <SelectTrigger className="min-w-[14rem]" size="sm">
              <SelectValue placeholder="pick a venue" />
            </SelectTrigger>
            <SelectContent>
              {venues.map((v) => (
                <SelectItem key={v.venueId} value={v.venueId}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* The COUNT and the cost ride the button, because a sweep is 62
              live generations and a button reading "Run all" hides that. Same
              posture as the playground's "also run v1 · 2x spend". */}
          <span className="text-xs text-ink-faint">
            {askable} live v2 generations
          </span>
          {busy ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onCancel}
            >
              Stop
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={onRunAll}>
              Run all
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[420px_1fr]">
        <div className="min-h-0 overflow-y-auto border-r border-stone-light/60">
          <PromptPane
            venueId={venueId}
            composedSystemText={composedSystemText}
            systemText={systemText}
            onSystemText={setSystemText}
            promptName={promptName}
            onPromptName={setPromptName}
            templateVersion={templateVersion}
            onTemplateVersion={setTemplateVersion}
            modelKey={modelKey}
            onModelKey={setModelKey}
            effort={effort}
            onEffort={setEffort}
            maxOutputTokens={maxOutputTokens}
            onMaxOutputTokens={setMaxOutputTokens}
            busy={busy}
          />
        </div>
        <div className="min-h-0 overflow-y-auto">
          <QuestionList
            rows={rows}
            storedV1={storedV1}
            sweep={sweep}
            busy={busy}
            onRunOne={onRunOne}
            onClearSweep={
              venueId === null ? undefined : () => clearSweep(venueId)
            }
          />
        </div>
      </div>
    </div>
  )
}
