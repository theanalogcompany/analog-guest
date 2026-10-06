'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { TurnOverrides, TurnTrace } from '@/lib/relationship/run-turn'
import type { GraphStateOption, PlaygroundTurn } from '../_lib/types'
import { GateSection, VerdictBadge } from './gate-section'
import { GraphSection } from './graph-section'
import { InspectorSection, KeyValue, MonoBlock } from './inspector-section'
import { JudgeSection, JudgeSummaryBadge } from './judge-section'
import { SituationsBadge, SituationsSection } from './situations-section'

// The inspector: every stage of the selected turn's TurnTrace, in pipeline
// order, each section collapsible. Brief sections, state and mission are
// editable; Regenerate re-runs the SAME turn with the edits as TurnOverrides
// and the parent swaps the trace in (keeping the old one for the judge
// comparison).
//
// An override is only sent when the edited text differs from what the trace
// actually used - sending every field verbatim would freeze live retrieval
// (knowledge, voice pack) to this turn's snapshot for no reason.

export function Inspector({
  turn,
  busy,
  onRegenerate,
}: {
  turn: PlaygroundTurn | null
  busy: boolean
  onRegenerate: (overrides: TurnOverrides) => void
}) {
  if (turn === null) {
    return (
      <Placeholder text="Send a message (or replay one) and select the reply to inspect the full trace." />
    )
  }
  if (turn.status === 'running' && turn.response === undefined) {
    return <Placeholder text="Running the turn. Three model calls; 15-45s." />
  }
  if (turn.status === 'error' && turn.response === undefined) {
    return (
      <div className="p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-destructive">
          Run failed
        </p>
        <p className="pt-2 text-xs leading-relaxed text-ink">
          {turn.error ?? 'unknown error'}
        </p>
        <p className="pt-2 text-xs italic text-ink-faint">
          Nothing reached the engine, so there is no trace to show. The request
          is kept; fix the cause and send again.
        </p>
      </div>
    )
  }

  const response = turn.response
  if (response === undefined) return <Placeholder text="No trace available." />

  return (
    <TraceInspector
      key={`${turn.id}:${turn.runSeq}`}
      trace={response.trace}
      graphStates={response.graphStates}
      previousTrace={turn.previousTrace ?? null}
      runError={turn.status === 'error' ? (turn.error ?? null) : null}
      busy={busy}
      onRegenerate={onRegenerate}
    />
  )
}

function Placeholder({ text }: { text: string }) {
  return <p className="p-6 text-sm italic text-ink-faint">{text}</p>
}

/** Editable fields, keyed exactly like TurnOverrides. */
interface Edits {
  stateKey: string
  mission: string
  guestProfileText: string
  interactionMemoryText: string
  openMovesText: string
  knowledgeText: string
  voicePackText: string
  venueProfileText: string
}

function editsFromTrace(trace: TurnTrace): Edits {
  return {
    stateKey: trace.state.resolvedKey,
    mission: trace.state.mission,
    guestProfileText: trace.sections.guestProfile,
    interactionMemoryText: trace.sections.interactionMemory,
    openMovesText: trace.sections.openMoves,
    knowledgeText: trace.sections.knowledge,
    voicePackText: trace.sections.voicePack,
    venueProfileText: trace.sections.venueProfile,
  }
}

/** Only the fields that actually changed become overrides. */
function overridesFromEdits(trace: TurnTrace, edits: Edits): TurnOverrides {
  const base = editsFromTrace(trace)
  const overrides: TurnOverrides = {}
  if (edits.stateKey !== base.stateKey) overrides.stateKey = edits.stateKey
  if (edits.mission !== base.mission) overrides.mission = edits.mission
  if (edits.guestProfileText !== base.guestProfileText)
    overrides.guestProfileText = edits.guestProfileText
  if (edits.interactionMemoryText !== base.interactionMemoryText)
    overrides.interactionMemoryText = edits.interactionMemoryText
  if (edits.openMovesText !== base.openMovesText)
    overrides.openMovesText = edits.openMovesText
  if (edits.knowledgeText !== base.knowledgeText)
    overrides.knowledgeText = edits.knowledgeText
  if (edits.voicePackText !== base.voicePackText)
    overrides.voicePackText = edits.voicePackText
  if (edits.venueProfileText !== base.venueProfileText)
    overrides.venueProfileText = edits.venueProfileText
  return overrides
}

function TraceInspector({
  trace,
  graphStates,
  previousTrace,
  runError,
  busy,
  onRegenerate,
}: {
  trace: TurnTrace
  graphStates: GraphStateOption[]
  previousTrace: TurnTrace | null
  /** A later regenerate failed; the shown trace is the previous good one. */
  runError: string | null
  busy: boolean
  onRegenerate: (overrides: TurnOverrides) => void
}) {
  const [edits, setEdits] = useState<Edits>(() => editsFromTrace(trace))
  const overrides = overridesFromEdits(trace, edits)
  const overrideCount = Object.keys(overrides).length

  const set = <K extends keyof Edits>(key: K, value: Edits[K]) =>
    setEdits((e) => ({ ...e, [key]: value }))

  const generation = trace.generation
  const assessor = trace.assessor

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runError !== null && (
          <p className="border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-xs text-destructive">
            Regenerate failed: {runError}. Showing the last good trace.
          </p>
        )}

        <InspectorSection
          title="Graph"
          badge={
            trace.graph.fellBack ? (
              <span className="text-[11px] text-destructive">fell back</span>
            ) : undefined
          }
        >
          <GraphSection
            graph={trace.graph}
            currentKey={trace.state.resolvedKey}
            facts={trace.facts}
          />
        </InspectorSection>

        <InspectorSection
          title="State"
          defaultOpen
          badge={
            trace.state.overridden ? (
              <span className="rounded-[2px] bg-clay-soft/50 px-1.5 py-0.5 text-[11px] font-medium text-clay-deep">
                overridden
              </span>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-2">
            <KeyValue label="resolved">
              {trace.state.label} ({trace.state.resolvedKey})
            </KeyValue>
            {trace.state.evidence.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {trace.state.evidence.map((line, i) => (
                  <li key={i} className="text-[11px] text-ink-faint">
                    {line}
                  </li>
                ))}
              </ul>
            )}
            <EditLabel>state for regenerate</EditLabel>
            <Select
              value={edits.stateKey}
              onValueChange={(v) => set('stateKey', v)}
              disabled={busy}
            >
              <SelectTrigger className="w-full" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {graphStates.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label} ({s.key})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <EditLabel>mission</EditLabel>
            <EditArea
              value={edits.mission}
              onChange={(v) => set('mission', v)}
              disabled={busy}
            />
          </div>
        </InspectorSection>

        <BriefSection
          title="Guest profile"
          value={edits.guestProfileText}
          onChange={(v) => set('guestProfileText', v)}
          busy={busy}
        />
        <BriefSection
          title="Interaction memory"
          value={edits.interactionMemoryText}
          onChange={(v) => set('interactionMemoryText', v)}
          busy={busy}
        />
        <BriefSection
          title="Open moves"
          value={edits.openMovesText}
          onChange={(v) => set('openMovesText', v)}
          busy={busy}
        />
        <BriefSection
          title="Knowledge"
          value={edits.knowledgeText}
          onChange={(v) => set('knowledgeText', v)}
          busy={busy}
        />
        <BriefSection
          title="Voice pack"
          value={edits.voicePackText}
          onChange={(v) => set('voicePackText', v)}
          busy={busy}
        />
        <BriefSection
          title="Venue profile"
          value={edits.venueProfileText}
          onChange={(v) => set('venueProfileText', v)}
          busy={busy}
          note={<VenueProfileNote render={trace.venueProfileRender} />}
        />

        <InspectorSection title="Composed prompt">
          <div className="flex flex-col gap-2">
            {trace.composed.system.map((block, i) => (
              <div key={i} className="flex flex-col gap-1">
                <EditLabel>
                  system block {i + 1}
                  {block.cacheBreakpoint ? ' · cache breakpoint' : ''}
                </EditLabel>
                <MonoBlock text={block.text} />
              </div>
            ))}
            {trace.composed.turns.map((t, i) => (
              <div key={i} className="flex flex-col gap-1">
                <EditLabel>
                  turn {i + 1} · {t.role}
                </EditLabel>
                <MonoBlock text={t.text} />
              </div>
            ))}
            <KeyValue label="chars">
              <span className="tabular-nums">
                {trace.composed.promptCharCount}
              </span>
            </KeyValue>
          </div>
        </InspectorSection>

        <InspectorSection
          title="Generation"
          defaultOpen
          badge={
            generation.ok ? undefined : (
              <span className="text-[11px] text-destructive">failed</span>
            )
          }
        >
          {generation.ok ? (
            <div className="flex flex-col gap-2">
              {generation.output.messages.map((m, i) => (
                <MonoBlock key={i} text={m} />
              ))}
              {(generation.output.actions ?? []).length > 0 && (
                <div className="flex flex-col gap-1">
                  <EditLabel>declared actions</EditLabel>
                  {(generation.output.actions ?? []).map((a, i) => (
                    <div key={i} className="text-xs text-ink">
                      <span className="font-medium">{a.type}</span>: {a.detail}{' '}
                      <span className="text-ink-faint">({a.reason})</span>
                    </div>
                  ))}
                </div>
              )}
              <KeyValue label="tokens">
                in {generation.usage.inputTokens ?? '?'} · out{' '}
                {generation.usage.outputTokens ?? '?'}
              </KeyValue>
              <KeyValue label="duration">
                <span className="tabular-nums">{generation.durationMs}ms</span>
              </KeyValue>
            </div>
          ) : (
            <p className="text-xs text-destructive">{generation.error}</p>
          )}
        </InspectorSection>

        <InspectorSection
          title="Situations"
          badge={<SituationsBadge situations={trace.situations} />}
        >
          <SituationsSection situations={trace.situations} />
        </InspectorSection>

        <InspectorSection
          title="Policy gate"
          defaultOpen
          badge={
            trace.gate !== null ? (
              <VerdictBadge verdict={trace.gate.verdict} />
            ) : undefined
          }
        >
          <GateSection gate={trace.gate} semantic={trace.semantic} />
        </InspectorSection>

        <InspectorSection
          title="Judge"
          defaultOpen
          badge={<JudgeSummaryBadge judge={trace.judge} />}
        >
          <JudgeSection
            judge={trace.judge}
            previousJudge={previousTrace?.judge ?? null}
            actualJudge={trace.actualJudge}
          />
        </InspectorSection>

        <InspectorSection
          title="Assessor"
          badge={
            assessor !== null && !assessor.ok ? (
              <span className="text-[11px] text-destructive">failed</span>
            ) : undefined
          }
        >
          <AssessorSection
            assessor={assessor}
            turnStateKey={trace.state.resolvedKey}
          />
        </InspectorSection>

        <InspectorSection title="Timings">
          <div className="flex flex-col gap-1">
            {trace.situations !== null && (
              <KeyValue label="situations (inbound)">
                <span className="tabular-nums">
                  {trace.situations.durationMs}ms
                </span>
              </KeyValue>
            )}
            {generation.ok && (
              <KeyValue label="generate">
                <span className="tabular-nums">{generation.durationMs}ms</span>
              </KeyValue>
            )}
            {trace.semantic !== null && (
              <KeyValue label="semantic check">
                <span className="tabular-nums">
                  {trace.semantic.durationMs}ms
                </span>
              </KeyValue>
            )}
            {trace.judge !== null && trace.judge.ok && (
              <KeyValue label="judge">
                <span className="tabular-nums">{trace.judge.durationMs}ms</span>
              </KeyValue>
            )}
            {trace.actualJudge !== null && trace.actualJudge.ok && (
              <KeyValue label="judge (actual reply)">
                <span className="tabular-nums">
                  {trace.actualJudge.durationMs}ms
                </span>
              </KeyValue>
            )}
            {trace.assessor !== null && trace.assessor.ok && (
              <KeyValue label="assessor">
                <span className="tabular-nums">
                  {trace.assessor.durationMs}ms
                </span>
              </KeyValue>
            )}
            <KeyValue label="total">
              <span className="tabular-nums">{trace.totalDurationMs}ms</span>{' '}
              (semantic, judge and assessor run concurrently; in production only
              generate + semantic sit in the guest&apos;s latency path)
            </KeyValue>
          </div>
        </InspectorSection>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-stone-light/60 bg-paper px-4 py-3">
        <Button
          type="button"
          size="sm"
          disabled={busy || overrideCount === 0}
          onClick={() => onRegenerate(overrides)}
        >
          {busy ? 'Running' : 'Regenerate'}
        </Button>
        <span className="text-xs text-ink-faint">
          {overrideCount === 0
            ? 'edit a section above to enable'
            : `${overrideCount} override${overrideCount === 1 ? '' : 's'}`}
        </span>
      </div>
    </div>
  )
}

function BriefSection({
  title,
  value,
  onChange,
  busy,
  note,
}: {
  title: string
  value: string
  onChange: (value: string) => void
  busy: boolean
  note?: React.ReactNode
}) {
  return (
    <InspectorSection title={title}>
      {note}
      <EditArea value={value} onChange={onChange} disabled={busy} />
    </InspectorSection>
  )
}

function EditArea({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
}) {
  return (
    <Textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      rows={5}
      className="min-h-20 font-mono text-[11px] leading-[1.5]"
    />
  )
}

/**
 * The venue profile used to be a 4000-char slice of the venue_info JSON, which
 * silently dropped the address at Le Mil's and got two fabricated ones sent.
 * There is no budget now, so the only thing left to watch is a stored key that
 * reached no renderer - shown here loudly rather than left to be inferred from
 * a bad reply (lib/ai/v2/venue-profile.ts).
 */
function VenueProfileNote({
  render,
}: {
  render: TurnTrace['venueProfileRender']
}) {
  if (render === null)
    return <EditLabel>no venue_info row for this venue</EditLabel>
  return (
    <div className="flex flex-col gap-1">
      <EditLabel>
        {render.charCount.toLocaleString()} chars rendered
        {render.overridden ? ' · OVERRIDDEN, not the venue’s own' : ''}
      </EditLabel>
      {render.unrendered.length > 0 && (
        <span
          className="text-[11px] font-bold uppercase tracking-wider text-red-700"
          role="alert"
        >
          {render.unrendered.length} stored key
          {render.unrendered.length === 1 ? '' : 's'} reached no renderer:{' '}
          {render.unrendered.join(', ')}
        </span>
      )}
    </div>
  )
}

function EditLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] uppercase tracking-wider text-ink-faint">
      {children}
    </span>
  )
}

function AssessorSection({
  assessor,
  turnStateKey,
}: {
  assessor: TurnTrace['assessor']
  /** The state the turn ran in; a pick equal to it is a no-op, not a rejection. */
  turnStateKey: string
}) {
  if (assessor === null) {
    return (
      <p className="text-xs italic text-ink-faint">
        The assessor did not run (generation failed upstream).
      </p>
    )
  }
  if (!assessor.ok) {
    return <p className="text-xs text-destructive">{assessor.error}</p>
  }

  const output = assessor.result.output
  return (
    <div className="flex flex-col gap-2">
      <KeyValue label="state pick">
        {/* The engine only validates a pick that would CHANGE the state
            (lib/relationship/assessor.ts), so validatedStateKey is null both
            for "picked the current state" and "rejected" - disambiguate. */}
        {output.statePick.trim().length === 0 ||
        output.statePick === turnStateKey
          ? 'stay'
          : `${output.statePick} (validated: ${assessor.result.validatedStateKey ?? 'rejected - outside the frontier'})`}
      </KeyValue>
      <KeyValue label="next session state">
        {assessor.nextSession.stateKey}
      </KeyValue>
      {output.profileFieldUpdates.length > 0 && (
        <div>
          <EditLabel>profile field updates</EditLabel>
          {output.profileFieldUpdates.map((u, i) => (
            <div key={i} className="text-xs text-ink">
              {u.field}: {u.value}
            </div>
          ))}
        </div>
      )}
      {output.newFacts.length > 0 && (
        <div>
          <EditLabel>new facts</EditLabel>
          {output.newFacts.map((f, i) => (
            <div key={i} className="text-xs text-ink">
              {f}
            </div>
          ))}
        </div>
      )}
      {output.memoryEntries.length > 0 && (
        <div>
          <EditLabel>memory entries</EditLabel>
          {output.memoryEntries.map((e, i) => (
            <div key={i} className="text-xs text-ink">
              [{e.kind}] {e.note}
            </div>
          ))}
        </div>
      )}
      {output.memoryOutcomes.length > 0 && (
        <div>
          <EditLabel>memory outcomes</EditLabel>
          {output.memoryOutcomes.map((o, i) => (
            <div key={i} className="text-xs text-ink">
              {o.note}: {o.outcome}
            </div>
          ))}
        </div>
      )}
      <KeyValue label="flags">
        {output.flags.length > 0 ? output.flags.join(', ') : 'none'}
      </KeyValue>
      <details>
        <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-ink-faint">
          reasoning
        </summary>
        <p className="pt-1 text-xs leading-relaxed text-ink-soft">
          {output.reasoning}
        </p>
      </details>
    </div>
  )
}
