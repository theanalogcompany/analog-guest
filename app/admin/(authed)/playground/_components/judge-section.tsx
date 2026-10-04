'use client'

import type { JudgeOutput } from '@/lib/eval/judge'
import type { TurnTrace } from '@/lib/relationship/run-turn'
import { KeyValue } from './inspector-section'

// Judge panel: the seven axes, each a 1-5 score chip with explanation and
// verbatim evidence quotes. After a regenerate, the previous trace's scores
// render beside the new ones so the operator sees what the edit bought. In
// replay mode the judgment of what production actually sent renders below
// the draft's - real replies with known quality are how the judge itself
// gets tuned.
//
// Chip colors follow the StatusDot health palette (internal debug surface,
// not brand tokens): 4-5 green, 3 amber, 1-2 red.
//
// Axis order is declared locally rather than importing JUDGE_AXES: judge.ts
// pulls the AI SDK into whatever bundle imports it, and this is a client
// component. `satisfies Record<keyof JudgeOutput, _>` keeps the local list
// total - adding a seventh axis fails tsc here (the totality gotcha in root
// CLAUDE.md: a readonly array alone is not exhaustiveness-checked).

const AXIS_ORDER = {
  recognition: 0,
  reading_the_guest: 1,
  economy: 2,
  quiet_authority: 3,
  working_the_room: 4,
  host_ownership: 5,
} satisfies Record<keyof JudgeOutput, number>

const JUDGE_AXES = (Object.keys(AXIS_ORDER) as (keyof JudgeOutput)[]).sort(
  (a, b) => AXIS_ORDER[a] - AXIS_ORDER[b],
)

const SCORE_COLOR = (score: number): string => {
  if (score >= 4) return '#16A34A'
  if (score === 3) return '#CA8A04'
  return '#DC2626'
}

function ScoreChip({
  score,
  tested,
  muted = false,
}: {
  score: number
  /** False renders a gray n/a chip - an untested axis has no score to show. */
  tested: boolean
  muted?: boolean
}) {
  if (!tested) {
    return (
      <span
        className={`inline-flex h-5 min-w-5 items-center justify-center rounded-[2px] bg-stone-light px-1 text-[10px] font-semibold text-ink-faint ${muted ? 'opacity-45' : ''}`}
      >
        n/a
      </span>
    )
  }
  return (
    <span
      className={`inline-flex size-5 items-center justify-center rounded-[2px] text-[11px] font-semibold text-white tabular-nums ${muted ? 'opacity-45' : ''}`}
      style={{ backgroundColor: SCORE_COLOR(score) }}
    >
      {score}
    </span>
  )
}

export function JudgeSummaryBadge({ judge }: { judge: TurnTrace['judge'] }) {
  if (judge === null)
    return <span className="text-[11px] text-ink-faint">not run</span>
  if (!judge.ok)
    return <span className="text-[11px] text-destructive">failed</span>
  return (
    <span className="flex gap-0.5">
      {JUDGE_AXES.map((axis) => (
        <ScoreChip
          key={axis}
          score={judge.result.axes[axis].score}
          tested={judge.result.axes[axis].tested}
        />
      ))}
    </span>
  )
}

function AxisRows({
  axes,
  prevAxes,
}: {
  axes: JudgeOutput
  /** Muted comparison chip rendered before each score, when present. */
  prevAxes: JudgeOutput | null
}) {
  return (
    <>
      {JUDGE_AXES.map((axis) => {
        const judgment = axes[axis]
        return (
          <div key={axis} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {prevAxes !== null && (
                <ScoreChip
                  score={prevAxes[axis].score}
                  tested={prevAxes[axis].tested}
                  muted
                />
              )}
              <ScoreChip score={judgment.score} tested={judgment.tested} />
              <span className="text-xs font-medium text-ink">
                {axis.replace(/_/g, ' ')}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-ink-soft">
              {judgment.explanation}
            </p>
            {judgment.evidence.length > 0 && (
              <ul className="flex flex-col gap-0.5 pl-3">
                {judgment.evidence.map((quote, i) => (
                  <li
                    key={i}
                    className="border-l-2 border-stone-light pl-2 text-[11px] italic text-ink-faint"
                  >
                    {quote}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </>
  )
}

export function JudgeSection({
  judge,
  previousJudge,
  actualJudge,
}: {
  judge: TurnTrace['judge']
  /** The replaced trace's judge after a regenerate, for old-vs-new. */
  previousJudge: TurnTrace['judge'] | null
  /** Replay mode: the judge over what production actually sent. */
  actualJudge: TurnTrace['actualJudge']
}) {
  if (judge === null) {
    return (
      <p className="text-xs italic text-ink-faint">
        The judge did not run (generation failed upstream).
      </p>
    )
  }
  if (!judge.ok) {
    return <p className="text-xs text-destructive">{judge.error}</p>
  }

  const prevAxes =
    previousJudge !== null && previousJudge !== undefined && previousJudge.ok
      ? previousJudge.result.axes
      : null

  return (
    <div className="flex flex-col gap-3">
      {prevAxes !== null && (
        <p className="text-[11px] italic text-ink-faint">
          Muted chip: the score before this regenerate.
        </p>
      )}
      <AxisRows axes={judge.result.axes} prevAxes={prevAxes} />
      {actualJudge !== null && (
        <div className="flex flex-col gap-3 border-t border-stone-light/60 pt-3">
          <p className="text-[11px] uppercase tracking-wider text-ink-faint">
            What production actually sent, judged against the same notes
          </p>
          {actualJudge.ok ? (
            <AxisRows axes={actualJudge.result.axes} prevAxes={null} />
          ) : (
            <p className="text-xs text-destructive">{actualJudge.error}</p>
          )}
          <p className="text-[11px] italic text-ink-faint">
            You know whether this real reply was good. If the scores disagree
            with you, that is a judge problem - note the turn for the
            calibration set.
          </p>
        </div>
      )}
      <KeyValue label="judge version">{judge.result.judgeVersion}</KeyValue>
    </div>
  )
}
