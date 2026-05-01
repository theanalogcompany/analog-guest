'use client'

import type { TraceObservation, TraceStage } from '../lib/select-trace-stages'
import {
  KvList,
  KvRow,
  LongText,
  SubSection,
  readContent,
  readNumber,
  readRecord,
  readString,
} from './_primitives'

// generate drill-down. Top-level: per-call score / attempt count / prompt
// version (operator's "did this regen and what did it score" lookup).
// CAPTURED CONTENT carries the prompt assembly the model actually saw —
// these are the longest fields in any drill-down so the LongText preview/
// expand pattern matters here. Attempts list as a nested sub-section if
// more than 1 attempt happened.

export function GenerateDetail({ stage }: { stage: TraceStage }) {
  const output = readRecord(stage.observation.output)
  const voiceFidelity = readNumber(output?.voiceFidelity)
  const attempts = readNumber(output?.attempts)
  const promptVersion = readString(output?.promptVersion)
  const bodyLength = readNumber(output?.bodyLength)
  const attemptScores = parseScores(output?.attemptScores)

  const content = readContent(stage.observation.output)
  const systemPrompt = readString(content?.systemPrompt)
  const userPrompt = readString(content?.userPrompt)
  const model = readString(content?.model)

  const hasCaptured = systemPrompt !== null || userPrompt !== null || model !== null
  const hasAttempts = stage.attempts && stage.attempts.length > 0

  return (
    <div className="flex flex-col gap-2.5">
      <KvList>
        {voiceFidelity !== null ? (
          <KvRow label="voiceFidelity" value={voiceFidelity.toFixed(2)} />
        ) : null}
        {attempts !== null ? <KvRow label="attempts" value={attempts} /> : null}
        {attemptScores.length > 0 ? (
          <KvRow
            label="attemptScores"
            value={attemptScores.map((n) => n.toFixed(2)).join(' · ')}
          />
        ) : null}
        {promptVersion !== null ? <KvRow label="promptVersion" value={promptVersion} /> : null}
        {bodyLength !== null ? <KvRow label="bodyLength" value={bodyLength} /> : null}
      </KvList>

      {hasCaptured ? (
        <SubSection title="Captured content" defaultOpen>
          <KvList>
            {model !== null ? <KvRow label="model" value={model} /> : null}
            {systemPrompt !== null ? (
              <KvRow label="systemPrompt" value={<LongText text={systemPrompt} />} />
            ) : null}
            {userPrompt !== null ? (
              <KvRow label="userPrompt" value={<LongText text={userPrompt} />} />
            ) : null}
          </KvList>
        </SubSection>
      ) : null}

      {hasAttempts ? (
        <SubSection
          title={`Attempts · ${stage.attempts!.length}`}
          defaultOpen={(stage.attempts!.length > 1)}
        >
          <div className="flex flex-col gap-2">
            {stage.attempts!.map((a, i) => (
              <AttemptRow key={a.id} attempt={a} index={i + 1} />
            ))}
          </div>
        </SubSection>
      ) : null}
    </div>
  )
}

function AttemptRow({ attempt, index }: { attempt: TraceObservation; index: number }) {
  const output = readRecord(attempt.output)
  const fidelity = readNumber(output?.voiceFidelity)
  const content = readContent(attempt.output)
  const body = readString(content?.body)
  const reasoning = readString(content?.reasoning)
  const isError = attempt.level === 'ERROR'

  return (
    <div className="border border-stone-light/60 rounded p-2 bg-paper/40 flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-faint uppercase tracking-wider font-medium">
          Attempt {index}
        </span>
        <span className="flex items-center gap-2">
          {fidelity !== null ? (
            <span className="text-ink-soft tabular-nums">fidelity {fidelity.toFixed(2)}</span>
          ) : null}
          {isError ? (
            <span className="px-1.5 py-0.5 rounded bg-clay/15 text-clay">ERROR</span>
          ) : null}
        </span>
      </div>
      {body !== null ? (
        <span className="text-sm text-ink whitespace-pre-wrap break-words">{body}</span>
      ) : null}
      {reasoning !== null ? (
        <span className="text-xs text-ink-soft whitespace-pre-wrap break-words italic">
          {reasoning}
        </span>
      ) : null}
    </div>
  )
}

function parseScores(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
}
