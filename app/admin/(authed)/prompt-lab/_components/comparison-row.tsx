'use client'

import { Button } from '@/components/ui/button'
import { GoldenTranscript } from '@/app/admin/_components/golden-transcript'
import { goldenTurnFor } from '@/lib/eval/golden-turn'
import type { LabRow, LabV2State } from '../_lib/types'

// One question, v1 beside v2.
//
// `substitute` COPY IS NOT COPIED HERE. The golden page already states what v1
// does on a crisis, an opt-out, a media-only card and a bare close, and
// app/admin/CLAUDE.md is explicit that a pasted string renders identically to a
// read one until the constant changes. This imports the meaning by naming the
// four cases and nothing else; if the wording matters to a reader they are on
// /admin/tests/golden, which is the surface that owns it.

const SUBSTITUTE_LABEL: Record<string, string> = {
  crisis_safety: 'v1 sends its fixed crisis-safety reply, never generated',
  media_only_card: 'v1 sends no text - it writes a blank operator card',
  no_reply_needed: 'v1 sends nothing at all, by design',
  opt_out_confirmation:
    'v1 records the opt-out and sends its fixed confirmation',
}

export function ComparisonRow({
  row,
  busy,
  onRun,
}: {
  row: LabRow
  busy: boolean
  onRun: () => void
}) {
  const { question, storedV1, v2 } = row
  // No Run button where there is nothing to run. The alternative - a button
  // that returns the same "not run" every time - invites the reader to press
  // it and conclude the gap is intermittent.
  const runnable = goldenTurnFor(question).skip === null
  return (
    <div className="grid grid-cols-[1fr_1fr] gap-3 border-b border-stone-light/60 px-4 py-3">
      <div className="col-span-2 flex items-center gap-2">
        <span className="text-xs text-ink">{question.question}</span>
        <span className="font-mono text-[11px] text-ink-faint">
          {question.key}
          {(question.history ?? []).length === 0 && ' · cold open'}
        </span>
        {runnable && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto h-6 px-2 text-[11px]"
            disabled={busy}
            onClick={onRun}
          >
            Run
          </Button>
        )}
      </div>

      {/* The INPUT, not a count of it. A badge reading "3 prior turns" told
          the reader there was history without telling them what it said, and
          on a burst the header line above is a display label rather than the
          messages the engines were handed - so the row was reporting an input
          neither engine received. Same component /admin/tests/golden renders,
          for the reason given there: these answers are unreadable without it. */}
      <div className="col-span-2">
        <GoldenTranscript question={question} />
      </div>

      <Column label="v1 · stored">
        {storedV1 === null ? (
          // NOT an empty bubble. "No run ever recorded an answer" and "v1
          // answered with nothing" are different facts and the column has to
          // be able to say which.
          <Muted>never run against this question</Muted>
        ) : !storedV1.v1.ok ? (
          <Failed>
            v1 failed at {storedV1.v1.stage}: {storedV1.v1.error}
          </Failed>
        ) : (
          <>
            {storedV1.v1.bubbles.map((b, i) => (
              <Bubble key={i} tone="v1">
                {b}
              </Bubble>
            ))}
            {storedV1.v1.substitute !== null && (
              <Muted>
                {SUBSTITUTE_LABEL[storedV1.v1.substitute] ??
                  storedV1.v1.substitute}
              </Muted>
            )}
            <Meta>
              {storedV1.v1.category} · {storedV1.promptVersion} ·{' '}
              {storedV1.capturedAt.slice(0, 10)}
            </Meta>
          </>
        )}
      </Column>

      <Column label="v2 · live">
        <V2Cell state={v2} />
      </Column>
    </div>
  )
}

function V2Cell({ state }: { state: LabV2State | undefined }) {
  if (state === undefined) return <Muted>not asked yet</Muted>
  if (state.status === 'running') return <Muted>running…</Muted>
  if (state.status === 'error') return <Failed>{state.error}</Failed>
  // GREY, not red: a capability gap reported as a failure is a finding about
  // the agent that is not true.
  if (state.status === 'not_run') return <Muted>not run - {state.reason}</Muted>
  return (
    <>
      {state.bubbles.map((b, i) => (
        <Bubble key={i} tone="v2">
          {b}
        </Bubble>
      ))}
      <Meta>
        {state.promptVersion} · {state.model}
        {state.effort !== null && ` · effort ${state.effort}`}
        {state.verdict !== null && state.verdict !== 'send' && (
          <span className="pl-1 text-clay-deep">gate: {state.verdict}</span>
        )}
        {state.thinkingTokens !== null &&
          state.thinkingTokens > 0 &&
          ` · ${state.thinkingTokens} thinking`}
      </Meta>
    </>
  )
}

function Column({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      {children}
    </div>
  )
}

/** v2 takes the live blue; v1 is outlined, so the eye lands on v2. */
function Bubble({
  tone,
  children,
}: {
  tone: 'v1' | 'v2'
  children: React.ReactNode
}) {
  return (
    <div
      className={`w-fit max-w-full rounded-2xl px-3 py-1.5 text-xs leading-snug ${
        tone === 'v2'
          ? 'bg-[#1b8cff] text-white'
          : 'border border-stone-light bg-paper text-ink'
      }`}
    >
      {children}
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] italic text-ink-faint">{children}</span>
}

function Failed({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] text-destructive" role="alert">
      {children}
    </span>
  )
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-ink-faint">{children}</span>
}
