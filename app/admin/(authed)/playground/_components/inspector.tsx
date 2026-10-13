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
import type { ComposedPrompt, ComposedTurn } from '@/lib/ai/v2/compose'
import {
  changedBlocks,
  HAND_EDITED_SUFFIX,
  promptToText,
  parsePromptText,
  systemTextOf,
} from '@/lib/ai/v2/prompt-text'
import {
  v2ModelKeyOf,
  V2_DEFAULT_EFFORT,
  V2_GENERATE_MAX_OUTPUT_TOKENS,
  V2_MODEL_KEYS,
  V2_MODEL_PROFILES,
  V2_PLAYGROUND_MAX_OUTPUT_TOKENS,
  type V2EffortRequest,
  type V2ModelKey,
  type V2ModelProfile,
} from '@/lib/ai/v2/model-call'
import {
  resolveV2TemplateSet,
  V2_TEMPLATE_CURRENT,
  V2_TEMPLATE_VERSIONS,
} from '@/lib/ai/v2/template-archive'
import { PromptLibrary } from './prompt-library'
import { evaluationRan } from '@/lib/relationship/evaluation-ran'
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
//
// THE COMPOSED PROMPT AND THE MODEL CALL ARE EDITABLE TOO (owner-ruled
// 2026-10-12: "everything that goes into the model should be experimentable by
// humans in the playground"). Those two sit at the bottom because they
// OUTRANK everything above them:
//
//   - a hand-edited prompt replaces the composer's output wholesale, so the
//     section edits above stop reaching the model. The UI says so when both
//     are present rather than leaving it to be discovered from a reply that
//     ignored an edit.
//   - the model, its effort and its token budget are properties of the CALL,
//     not of the prompt, so they apply either way.
//
// The assessor and the judge are deliberately NOT covered: they are separate
// calls with their own models, and the ruling scoped this to generation.

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
  if (response === undefined) {
    // Restored from a save: the reply was stored, the trace was not
    // (migration 074's ruling). Say so plainly and point at the one action
    // that produces a real trace. The alternative - rendering empty sections,
    // or worse, filling them from the save - would present a prompt, a gate
    // decision and judge scores that were never recorded for this turn.
    if (turn.restored !== undefined) {
      return (
        <div className="p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-ink-soft">
            Trace not saved
          </p>
          <p className="pt-2 text-xs leading-relaxed text-ink">
            This turn was restored from a saved conversation. Saves keep the
            reply, not the trace.
          </p>
          <p className="pt-2 text-xs italic text-ink-faint">
            Hover this turn&apos;s guest message and choose &ldquo;rerun from
            here&rdquo; to run it again and get the full trace. Everything after
            it is discarded, and the session rewinds with it.
          </p>
        </div>
      )
    }
    return <Placeholder text="No trace available." />
  }

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
  knowledgeBriefText: string
  voicePackText: string
  venueProfileText: string
  /**
   * The composed prompt's SYSTEM BLOCKS, serialized - not the transcript.
   *
   * The guest's own words are not an editable field. They are the input the
   * turn is a reply to; editing them makes it a different turn, which the
   * message box above already does honestly. The turns are spliced back on at
   * send time from the trace, so what the model receives is still the whole
   * document.
   */
  promptText: string
  /**
   * An archived template version, or the current one. A SEPARATE axis from
   * `promptText`: the version decides what the composer produces, the text
   * decides what replaces it afterwards. Picking a version re-composes and
   * therefore discards a pending text edit, which the UI says before it does.
   */
  templateVersion: string
  modelKey: V2ModelKey
  /**
   * A REQUEST, so `'none'` is a selectable thing rather than an absence. With
   * `V2_DEFAULT_EFFORT` in place, "unset" no longer means "no effort" - it
   * means the default - so a control that could only be a level or empty had
   * no way to express the arm every pre-default measurement was taken on.
   */
  effort: V2EffortRequest
  /** A STRING, because a number input mid-typing is legitimately empty. */
  maxOutputTokens: string
}

/**
 * The system blocks of a composed prompt. '' when it will not re-parse, which
 * cannot happen for something this module just serialized - the fallback is
 * there so the editor renders rather than throwing inside a render.
 */
function systemOnly(prompt: ComposedPrompt): string {
  const result = systemTextOf(promptToText(prompt))
  return result.ok ? result.text : ''
}

/**
 * The house blocks the COMPOSER produced for this turn, which is the thing a
 * prompt edit is an edit AGAINST.
 *
 * Not `trace.composed` when the turn was hand-edited - that is the edit. See
 * `composedWithoutPromptEdit` for the defect that distinction prevents.
 */
function composedPromptText(trace: TurnTrace): string {
  return systemOnly(trace.composedWithoutPromptEdit ?? trace.composed)
}

function editsFromTrace(trace: TurnTrace): Edits {
  return {
    stateKey: trace.state.resolvedKey,
    mission: trace.state.mission,
    guestProfileText: trace.sections.guestProfile,
    interactionMemoryText: trace.sections.interactionMemory,
    openMovesText: trace.sections.openMoves,
    knowledgeBriefText: trace.sections.knowledgeBrief,
    voicePackText: trace.sections.voicePack,
    venueProfileText: trace.sections.venueProfile,
    // What this turn SENT, which on a hand-edited turn is the edit. So the
    // textarea opens on the blocks that produced the reply being read, and the
    // edit survives a regenerate - the comparison that decides whether to send
    // it is against `composedPromptText`, not against this.
    promptText: systemOnly(trace.composed),
    // Falls back to the default key when the trace names a model no profile
    // claims (a profile removed since). The picker then shows the default
    // while the readout below still shows what actually ran, which is the pair
    // that makes the mismatch visible instead of silently reconciling it.
    // From the COMPOSED prompt, with the hand-edit suffix stripped - that is
    // what the turn ran on. `trace.input.overrides` would be the ask rather
    // than the outcome, and they differ whenever a stored version fell open.
    templateVersion: resolveV2TemplateSet(
      trace.composed.promptVersion.replace(HAND_EDITED_SUFFIX, ''),
    ).version,
    modelKey: v2ModelKeyOf(trace.modelCall.model) ?? V2_MODEL_KEYS[0],
    // null on the trace means none was SENT, which is the `'none'` request.
    effort: trace.modelCall.effort ?? 'none',
    maxOutputTokens: String(trace.modelCall.maxOutputTokens),
  }
}

/**
 * Which fields the operator has moved off what this turn ran with. Drives the
 * footer count and the button, and NOTHING else.
 *
 * Separate from `sendableOverrides` because the two questions are genuinely
 * different, and conflating them is a live defect this split fixes. A
 * regenerate replaces the whole override set
 * (`playground-client.tsx: {...turn.request, overrides}`), and the inspector
 * remounts against the new trace - so a parameter that is only sent "when it
 * differs from what ran" is sent exactly once and then silently reverts to the
 * server default on the next regenerate, while the control still shows it.
 * That is the mislabeling this entire surface exists to prevent.
 */
function dirtyFields(base: Edits, edits: Edits): Array<keyof Edits> {
  const keys: Array<keyof Edits> = [
    'stateKey',
    'mission',
    'guestProfileText',
    'interactionMemoryText',
    'openMovesText',
    'knowledgeBriefText',
    'voicePackText',
    'venueProfileText',
    'promptText',
    'templateVersion',
    'modelKey',
    'effort',
    'maxOutputTokens',
  ]
  return keys.filter((k) => edits[k] !== base[k])
}

/**
 * What to actually send. Two different rules, on purpose:
 *
 * - the rendered sections are sent ONLY when edited, because sending them
 *   verbatim would freeze live retrieval to this turn's snapshot.
 * - the model call is sent ALWAYS, so the request says what the controls say
 *   rather than leaving the server to resolve the environment switch behind
 *   them. Sending `sonnet-4-6` on a turn that already ran on `sonnet-4-6` is a
 *   no-op; NOT sending it is how the model reverts under an unchanged picker.
 * - `promptText` is sent whenever it differs from what the COMPOSER produced,
 *   which is what makes a hand edit survive a regenerate and what makes Reset
 *   mean something.
 */
function sendableOverrides(trace: TurnTrace, edits: Edits): TurnOverrides {
  const base: Edits = editsFromTrace(trace)
  const overrides: TurnOverrides = {}
  if (edits.stateKey !== base.stateKey) overrides.stateKey = edits.stateKey
  if (edits.mission !== base.mission) overrides.mission = edits.mission
  if (edits.guestProfileText !== base.guestProfileText)
    overrides.guestProfileText = edits.guestProfileText
  if (edits.interactionMemoryText !== base.interactionMemoryText)
    overrides.interactionMemoryText = edits.interactionMemoryText
  if (edits.openMovesText !== base.openMovesText)
    overrides.openMovesText = edits.openMovesText
  if (edits.knowledgeBriefText !== base.knowledgeBriefText)
    overrides.knowledgeBriefText = edits.knowledgeBriefText
  if (edits.voicePackText !== base.voicePackText)
    overrides.voicePackText = edits.voicePackText
  if (edits.venueProfileText !== base.venueProfileText)
    overrides.venueProfileText = edits.venueProfileText
  // ALWAYS SET, empty included, for the same reason the model call is: this is
  // what makes the active prompt (_lib/active-prompt.ts) a single source of
  // truth. An absent set would read as "no opinion", and the client would keep
  // applying the pinned blocks after a Reset.
  //
  // The transcript is unreachable from here by construction - a block override
  // names a SYSTEM block, and the editor holds nothing else.
  //
  // NOTHING IS SENT WHEN THE TEMPLATE VERSION CHANGED, and that is the whole
  // trap this guards. The editor was seeded from the trace, so its diff is
  // against the OLD template's blocks; sending it would replace the new
  // version's blocks with the old version's text and the reply would be the
  // old template wearing a new version number - a version comparison that
  // compares nothing, reported as one that did. Change the version, read the
  // reply, then edit. `editBlocker` refuses the combination out loud rather
  // than letting this silently drop an edit someone typed.
  if (edits.templateVersion === base.templateVersion) {
    const diff = changedBlocks(composedPromptText(trace), edits.promptText)
    overrides.promptBlocks = diff.ok ? diff.blocks : []
  } else {
    overrides.promptBlocks = []
  }
  // Sent only when it is NOT this build's own, so a turn on the current
  // template carries no version override at all - the absence is what keeps a
  // saved conversation from pinning a version that was current when it was
  // saved and is a fixture now.
  if (edits.templateVersion !== V2_TEMPLATE_CURRENT.version)
    overrides.templateVersion = edits.templateVersion
  overrides.modelKey = edits.modelKey
  // Sent as given, `'none'` included - it is a value the route accepts, not an
  // absence, because an absent effort now resolves to V2_DEFAULT_EFFORT.
  overrides.effort = edits.effort
  // Parsed, not coerced. `Number('')` is 0 and `Number('12x')` is NaN, and
  // either would travel to the Zod boundary as a number that fails there with
  // a message about the schema rather than about the field. `editBlocker`
  // refuses the regenerate before it can get here.
  const tokens = Number.parseInt(edits.maxOutputTokens, 10)
  if (Number.isInteger(tokens)) overrides.maxOutputTokens = tokens
  return overrides
}

/**
 * Why a regenerate is refused, or null when it is fine.
 *
 * SEPARATE FROM `overridesFromEdits`, because a field that cannot be sent is
 * not the same as a field that was not changed - and the version of this that
 * silently dropped both would let an operator press Regenerate on a broken
 * prompt and read the unchanged reply as evidence about their edit.
 */
function editBlocker(
  edits: Edits,
  base: Edits,
  composedText: string,
): string | null {
  // ONE AT A TIME, refused rather than silently resolved. Both are edits to
  // what the model is sent and they are defined against each other: the block
  // diff only means anything relative to the template that produced it.
  if (
    edits.templateVersion !== base.templateVersion &&
    edits.promptText !== base.promptText
  )
    return 'a template version and a prompt edit at once - the edit is diffed against the old version\u2019s blocks, so it would quietly undo the version change. Reset the prompt, run the version, then edit.'
  if (edits.promptText !== base.promptText) {
    const parsed = parsePromptText(edits.promptText)
    if (!parsed.ok) return `prompt will not parse - ${parsed.error}`
    if (parsed.prompt.system.length === 0)
      return 'the prompt has no SYSTEM blocks left'
    if (!parsed.houseNotesFound)
      return 'the prompt has no "SYSTEM: HOUSE NOTES" block, so the judge would be handed an empty situation brief'
    // A renamed, added or removed block has nothing to match against on a
    // later turn, which is what `changedBlocks` refuses - checked here rather
    // than swallowed at send time.
    const diff = changedBlocks(composedText, edits.promptText)
    if (!diff.ok) return diff.error
  }
  // Annotated, because `satisfies` narrows each entry's `allowedEfforts` to
  // its own literal tuple and `includes` then refuses to be asked about a
  // level that entry does not list - which is the exact question here.
  const profile: V2ModelProfile = V2_MODEL_PROFILES[edits.modelKey]
  if (edits.effort !== 'none' && !profile.allowedEfforts.includes(edits.effort))
    return `${profile.id} does not accept effort "${edits.effort}" (accepts: ${profile.allowedEfforts.join(', ')})`
  const tokens = Number.parseInt(edits.maxOutputTokens, 10)
  if (!Number.isInteger(tokens) || String(tokens) !== edits.maxOutputTokens)
    return 'max output tokens is not a whole number'
  if (tokens < 100 || tokens > V2_PLAYGROUND_MAX_OUTPUT_TOKENS)
    return `max output tokens must be between 100 and ${V2_PLAYGROUND_MAX_OUTPUT_TOKENS.toLocaleString()}`
  return null
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
  const baseEdits = editsFromTrace(trace)
  const dirty = dirtyFields(baseEdits, edits)
  const blocker = editBlocker(edits, baseEdits, composedPromptText(trace))
  // The Reset target, and the comparison that decides whether the prompt is
  // sent. On a hand-edited turn this is NOT what the textarea opens on.
  const composedText = composedPromptText(trace)

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
          title="What you know"
          value={edits.knowledgeBriefText}
          onChange={(v) => set('knowledgeBriefText', v)}
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

        <ModelCallSection
          templateVersion={edits.templateVersion}
          onTemplateVersion={(v) => set('templateVersion', v)}
          modelKey={edits.modelKey}
          effort={edits.effort}
          maxOutputTokens={edits.maxOutputTokens}
          onModelKey={(v) => set('modelKey', v)}
          onEffort={(v) => set('effort', v)}
          onMaxOutputTokens={(v) => set('maxOutputTokens', v)}
          ran={trace.modelCall}
          busy={busy}
        />

        <PromptSection
          value={edits.promptText}
          composed={composedText}
          onChange={(v) => set('promptText', v)}
          handEdited={trace.composedWithoutPromptEdit !== null}
          promptVersion={trace.composed.promptVersion}
          venueId={trace.input.venueId}
          turns={trace.composed.turns}
          sectionOverridesIgnored={
            edits.promptText !== composedText &&
            SECTION_OVERRIDE_KEYS.some((k) => dirty.includes(k))
          }
          busy={busy}
        />

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
              {/* `in` above INCLUDES both cache buckets, so these are a share
                  of it rather than extra on top - the trap documented at
                  AgentUsage. 0% on a first turn is correct, not a fault. */}
              <KeyValue label="prompt cache">
                {generation.cacheHitRate === null ? (
                  'not reported'
                ) : (
                  <span className="tabular-nums">
                    {(generation.cacheHitRate * 100).toFixed(1)}% read
                    {generation.usage.cachedInputTokens
                      ? ` (${generation.usage.cachedInputTokens} tok)`
                      : ''}
                    {generation.usage.inputTokenDetails?.cacheWriteTokens
                      ? ` · ${generation.usage.inputTokenDetails.cacheWriteTokens} written`
                      : ''}
                  </span>
                )}
              </KeyValue>
              {/* Thinking is charged against the SAME output budget, which is
                  why this sits next to the token line: at effort `max` a
                  1,000-token budget was spent entirely on thinking and the
                  turn returned no reply at all. "not reported" is not zero -
                  claude-sonnet-4-6 omits the key at every level. */}
              <KeyValue label="thinking">
                {generation.thinkingTokens === null ? (
                  'not reported by the provider'
                ) : (
                  <span className="tabular-nums">
                    {generation.thinkingTokens} tok of{' '}
                    {trace.modelCall.maxOutputTokens} budget
                  </span>
                )}
              </KeyValue>
              {/* Said here and not only on the model picker, because this is
                  the line a reader reaches for when a reply moved between two
                  runs of a byte-identical prompt. */}
              <KeyValue label="temperature">
                {generation.temperature === null
                  ? 'not sent - this model rejects the parameter, so replies vary run to run'
                  : generation.temperature}
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
            evaluationRan(assessor) && !assessor.ok ? (
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
            {evaluationRan(trace.judge) && trace.judge.ok && (
              <KeyValue label="judge">
                <span className="tabular-nums">{trace.judge.durationMs}ms</span>
              </KeyValue>
            )}
            {evaluationRan(trace.actualJudge) && trace.actualJudge.ok && (
              <KeyValue label="judge (actual reply)">
                <span className="tabular-nums">
                  {trace.actualJudge.durationMs}ms
                </span>
              </KeyValue>
            )}
            {evaluationRan(trace.assessor) && trace.assessor.ok && (
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
          disabled={busy || blocker !== null}
          onClick={() => onRegenerate(sendableOverrides(trace, edits))}
        >
          {busy ? 'Running' : 'Regenerate'}
        </Button>
        {/* The blocker wins over the count. A refusal that said "3 overrides"
            next to a dead button would read as the button being broken. */}
        <span
          className={
            blocker !== null
              ? 'text-xs text-destructive'
              : 'text-xs text-ink-faint'
          }
        >
          {/* ENABLED WITH NO CHANGES, deliberately. Two things make a
              no-edit rerun a real action rather than a misclick: the v1 arm is
              a live toggle that lives outside this panel, so "tick it and
              rerun" has to be reachable; and generation no longer runs at
              temperature 0 on the 5.x profiles, so the same prompt genuinely
              gives a different reply. */}
          {blocker !== null
            ? blocker
            : dirty.length === 0
              ? 'no changes - reruns this turn as it is'
              : `${dirty.length} change${dirty.length === 1 ? '' : 's'}: ${dirty.join(', ')}`}
        </span>
      </div>
    </div>
  )
}

/**
 * The override keys a hand-edited prompt makes INVISIBLE to the model.
 *
 * `satisfies` against the override type, so a new rendered-section override
 * fails `tsc` here rather than quietly joining the set of edits that silently
 * stop applying once the prompt is pinned.
 */
const SECTION_OVERRIDE_KEYS = [
  'stateKey',
  'mission',
  'guestProfileText',
  'interactionMemoryText',
  'openMovesText',
  'knowledgeBriefText',
  'voicePackText',
  'venueProfileText',
] as const satisfies ReadonlyArray<keyof TurnOverrides>

/**
 * The house blocks as ONE textarea, with the transcript read-only beneath.
 *
 * The blocks rendered as a read-only list before, which is right for reading -
 * but the frame, the hard lines and the section order are only editable as
 * text, and those are exactly the units an ablation lands on
 * (`.claude/skills/ablate-a-bad-reply` step 4 said the only way to ablate the
 * frame was to edit `lib/ai/prompts/` locally and revert). One document with
 * its own delimiters is the only shape that reaches all of them;
 * `lib/ai/v2/prompt-text.ts` owns the format.
 *
 * THE TRANSCRIPT IS NOT IN THE TEXTAREA. It is shown, because it is part of
 * what the model receives and the point of this panel is that every byte is
 * visible - but the guest's words are the input, not a setting. Typing a
 * different question into them and then reading the reply is how you end up
 * with an answer to a turn that never happened; the message box above is the
 * honest way to ask something else.
 */
function PromptSection({
  value,
  composed,
  onChange,
  handEdited,
  promptVersion,
  venueId,
  turns,
  sectionOverridesIgnored,
  busy,
}: {
  value: string
  /** The composer's own house blocks, for Reset and the dirty comparison. */
  composed: string
  onChange: (value: string) => void
  /** This trace already RAN on a hand-edited prompt. */
  handEdited: boolean
  promptVersion: string
  /** Saved prompts are per venue - they are mostly that venue's own data. */
  venueId: string
  /** Read-only: what the model received after the house blocks. */
  turns: ComposedTurn[]
  sectionOverridesIgnored: boolean
  busy: boolean
}) {
  const dirty = value !== composed
  // Local to this section: a load failure is about the two texts being
  // spliced, which neither the edit state nor the footer's blocker knows
  // anything about.
  const [loadNote, setLoadNote] = useState<{
    tone: 'note' | 'error'
    text: string
  } | null>(null)

  /**
   * A saved prompt's house blocks into the editor.
   *
   * Stripped again on the way in rather than trusted: a prompt saved before
   * the split carries the conversation it was saved against, and loading that
   * into a textarea the transcript is no longer part of would put someone
   * else's turns back in as editable text.
   */
  const onLoadSystem = (savedSystemText: string) => {
    const stripped = systemTextOf(savedSystemText)
    if (!stripped.ok) {
      setLoadNote({ tone: 'error', text: stripped.error })
      return
    }
    onChange(stripped.text)
    setLoadNote(
      stripped.droppedTurns === 0
        ? null
        : {
            tone: 'note',
            text: `loaded the house blocks and dropped ${stripped.droppedTurns} transcript turn${stripped.droppedTurns === 1 ? '' : 's'} the saved prompt was carrying - this turn's own transcript is unchanged`,
          },
    )
  }

  return (
    <InspectorSection
      title="Composed prompt"
      badge={
        handEdited ? (
          <span className="rounded-[2px] bg-clay-soft/50 px-1.5 py-0.5 text-[11px] font-medium text-clay-deep">
            hand-edited
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2">
        <EditLabel>
          the house blocks, in the order the model reads them. the{' '}
          <span className="font-mono">&lt;&lt;&lt; ... &gt;&gt;&gt;</span> lines
          are block delimiters and are parsed, not sent
        </EditLabel>
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={busy}
          rows={24}
          className="max-h-[32rem] min-h-72 overflow-y-auto font-mono text-[11px] leading-[1.5]"
          spellCheck={false}
        />
        <div className="flex items-center gap-3">
          <KeyValue label="chars">
            <span className="tabular-nums">
              {value.length.toLocaleString()}
            </span>
          </KeyValue>
          <KeyValue label="version">{promptVersion}</KeyValue>
          {dirty && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onChange(composed)}
            >
              Reset to composed
            </Button>
          )}
        </div>
        {dirty && (
          <p className="text-[11px] leading-relaxed text-ink-soft">
            A turn run on this is stamped{' '}
            <span className="font-mono">+hand-edited</span> and is not evidence
            about the template.
          </p>
        )}

        <EditLabel>
          transcript · sent after the blocks above · not editable here
        </EditLabel>
        {turns.length === 0 ? (
          <span className="text-[11px] italic text-ink-faint">
            no turns - a cold open
          </span>
        ) : (
          turns.map((t, i) => (
            <div key={i} className="flex flex-col gap-1">
              <EditLabel>
                {t.role === 'user' ? 'guest' : 'venue'}
                {t.cacheBreakpoint === true ? ' · cache breakpoint' : ''}
              </EditLabel>
              <MonoBlock text={t.text} />
            </div>
          ))
        )}
        {/* Said out loud, because the alternative is an operator editing the
            knowledge section, pressing Regenerate, and reading a reply that
            ignored it as a finding about the agent. */}
        {sectionOverridesIgnored && (
          <p
            className="text-[11px] font-bold uppercase tracking-wider text-red-700"
            role="alert"
          >
            the section edits above will not reach the model while this prompt
            is edited - this text is what gets sent. reset it, or paste the
            edits in here.
          </p>
        )}
        {loadNote !== null && (
          <p
            className={
              loadNote.tone === 'error'
                ? 'text-[11px] leading-relaxed text-destructive'
                : 'text-[11px] leading-relaxed text-ink-soft'
            }
            role={loadNote.tone === 'error' ? 'alert' : undefined}
          >
            {loadNote.text}
          </p>
        )}
        <PromptLibrary
          venueId={venueId}
          promptVersion={promptVersion}
          text={value}
          onLoad={onLoadSystem}
          busy={busy}
        />
      </div>
    </InspectorSection>
  )
}

/**
 * The model, its thinking effort and its output budget - what the call is made
 * WITH, as opposed to what it is made OF.
 *
 * The readout above the controls is not decoration: the controls say what the
 * NEXT run will ask for and the readout says what THIS run asked for, and a
 * surface showing only the former would show an operator their own pending
 * edit and let them read it as the trace.
 */
function ModelCallSection({
  templateVersion,
  onTemplateVersion,
  modelKey,
  effort,
  maxOutputTokens,
  onModelKey,
  onEffort,
  onMaxOutputTokens,
  ran,
  busy,
}: {
  templateVersion: string
  onTemplateVersion: (value: string) => void
  modelKey: V2ModelKey
  effort: V2EffortRequest
  maxOutputTokens: string
  onModelKey: (value: V2ModelKey) => void
  onEffort: (value: V2EffortRequest) => void
  onMaxOutputTokens: (value: string) => void
  ran: TurnTrace['modelCall']
  busy: boolean
}) {
  const profile = V2_MODEL_PROFILES[modelKey]
  return (
    <InspectorSection title="Model call" defaultOpen>
      <div className="flex flex-col gap-2">
        <KeyValue label="this turn ran">
          {ran.model}
          {ran.effort === null ? ', no effort sent' : `, effort ${ran.effort}`},
          max{' '}
          <span className="tabular-nums">
            {ran.maxOutputTokens.toLocaleString()}
          </span>{' '}
          out
        </KeyValue>

        <EditLabel>template version</EditLabel>
        {/* The template is a property of the CALL in the same sense the model
            is - it decides what gets sent - so it sits here rather than in the
            prompt section, which edits what the composer produced. */}
        <Select
          value={templateVersion}
          onValueChange={onTemplateVersion}
          disabled={busy}
        >
          <SelectTrigger className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {V2_TEMPLATE_VERSIONS.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
                {v === V2_TEMPLATE_CURRENT.version
                  ? ' (this build)'
                  : ' (archived fixture)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Said at the control, because the obvious reading of a version
            picker is time travel and this is not that. */}
        {templateVersion !== V2_TEMPLATE_CURRENT.version && (
          <span className="text-[11px] leading-relaxed text-clay-deep">
            An archived version is frozen WORDING only. The venue data, voice
            pack, graph and model are today&apos;s, so this says what that
            wording does now - not what the agent did then.
            {resolveV2TemplateSet(templateVersion).usesRetrieval &&
              ' It also restores the knowledge retrieval lane that v2.18.0 removed.'}
          </span>
        )}

        <EditLabel>model for regenerate</EditLabel>
        <Select
          value={modelKey}
          onValueChange={(v) => onModelKey(v as V2ModelKey)}
          disabled={busy}
        >
          <SelectTrigger className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {V2_MODEL_KEYS.map((key) => (
              <SelectItem key={key} value={key}>
                {V2_MODEL_PROFILES[key].id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <EditLabel>thinking effort</EditLabel>
        {/* Only this model's accepted levels are offered. They DISAGREE -
            claude-sonnet-4-6 refuses `xhigh` by name - and offering a level
            the model rejects turns an experiment into a failed generation. */}
        <Select
          value={effort}
          onValueChange={(v) => onEffort(v as V2EffortRequest)}
          disabled={busy}
        >
          <SelectTrigger className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {profile.allowedEfforts.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
                {level === V2_DEFAULT_EFFORT ? ' (default)' : ''}
              </SelectItem>
            ))}
            {/* Kept as an explicit arm, not offered as "off": every measured
                lesson in the template changelog was taken with no effort sent,
                so this is how one of those numbers is reproduced. */}
            <SelectItem value="none">
              none - send no effort, as every pre-default measurement did
            </SelectItem>
          </SelectContent>
        </Select>
        {/* The level is a ceiling, not a dose - and the thinking comes out of
            the OUTPUT budget, which is the thing that bites. Stated where the
            control is, because the obvious reading of a five-level picker is
            that each level thinks proportionally more. */}
        <span className="text-[11px] leading-relaxed text-ink-faint">
          Measured 2026-10-12 on claude-haiku-5-5: a full turn spent 213
          thinking tokens at <span className="font-mono">high</span> and 2,971
          to 5,091 at <span className="font-mono">max</span>. The level sets a
          ceiling; the prompt decides how much is used, and zero is a normal
          answer. claude-sonnet-4-6 reports no breakdown at any level, which is
          the provider not saying rather than a zero.
        </span>

        <EditLabel>max output tokens</EditLabel>
        <input
          type="number"
          inputMode="numeric"
          min={100}
          max={V2_PLAYGROUND_MAX_OUTPUT_TOKENS}
          step={100}
          value={maxOutputTokens}
          onChange={(e) => onMaxOutputTokens(e.target.value)}
          disabled={busy}
          className="w-full rounded-[3px] border border-stone-light bg-paper px-2 py-1 font-mono text-[11px] tabular-nums text-ink disabled:opacity-50"
        />
        <span className="text-[11px] leading-relaxed text-ink-faint">
          Production sends{' '}
          <span className="tabular-nums">
            {V2_GENERATE_MAX_OUTPUT_TOKENS.toLocaleString()}
          </span>
          ; this surface allows up to{' '}
          <span className="tabular-nums">
            {V2_PLAYGROUND_MAX_OUTPUT_TOKENS.toLocaleString()}
          </span>
          . Thinking is charged against the same budget, so{' '}
          <span className="font-mono">max</span> effort at{' '}
          <span className="tabular-nums">
            {V2_GENERATE_MAX_OUTPUT_TOKENS.toLocaleString()}
          </span>{' '}
          returns no reply at all.
        </span>

        {!profile.sendsTemperature && (
          <span className="text-[11px] leading-relaxed text-ink-soft">
            {profile.id} rejects <span className="font-mono">temperature</span>,
            so this turn is NOT at temperature 0 - replies vary run to run and a
            single sample is not a result.
          </span>
        )}
      </div>
    </InspectorSection>
  )
}

/**
 * The char count rides the COLLAPSED header, which is the other half of the
 * "this section is not used" fix. A collapsed row is identical whether the
 * section holds 40,960 characters or nothing, so the only way to tell an empty
 * section from a full one was to open it - and opening it was the thing that
 * appeared to do nothing. Now the rail answers "is there anything in here"
 * without a click.
 */
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
    <InspectorSection
      title={title}
      badge={
        <span className="text-[11px] tabular-nums text-ink-faint">
          {value.length === 0
            ? 'empty'
            : `${value.length.toLocaleString()} chars`}
        </span>
      }
    >
      {note}
      <EditArea value={value} onChange={onChange} disabled={busy} />
    </InspectorSection>
  )
}

/**
 * CAPPED, and the cap is the fix for a real defect rather than taste.
 *
 * The shadcn Textarea carries `field-sizing-content`, so it grows to fit its
 * value with no bound. Le Mil's knowledge brief is 40,960 characters, which
 * made this element 28,473px tall and the inspector rail 30,383px of scroll
 * against a 537px viewport - so every section after it (voice pack, venue
 * profile, model call, the composed prompt, the gate, the judge) sat ~56
 * screens down and was effectively unreachable.
 *
 * `max-h-64` with the textarea's own scrollbar keeps a long section long
 * inside its own box instead of inside the page.
 */
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
      className="max-h-64 min-h-20 overflow-y-auto font-mono text-[11px] leading-[1.5]"
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
  // Declined, not failed, and NOT the same as the null above. No
  // `nextSession` was produced, so a chained conversation would carry nothing
  // forward - worth saying outright rather than rendering an empty section.
  if (!evaluationRan(assessor)) {
    return (
      <p className="text-xs italic text-ink-faint">
        The assessor was skipped for this turn, so there is no next session:
        nothing learned here carries into a following turn.
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
