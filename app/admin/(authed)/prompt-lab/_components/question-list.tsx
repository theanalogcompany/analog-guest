'use client'

import { Button } from '@/components/ui/button'
import { GOLDEN_GROUPS } from '@/lib/schemas/golden'
import type { StoredV1Index } from '../_lib/load-stored-v1'
import type { StoredSweep } from '../_lib/sweep-store'
import type { LabRow } from '../_lib/types'
import { ComparisonRow } from './comparison-row'

// The golden set as a matrix: one row per question, grouped, with the stored
// v1 answer and this session's live v2 answer side by side.
//
// GROUPS ARE DISPLAY ONLY - nothing branches on them (golden-set.ts says so),
// so they are headings and not filters.
//
// THE HEADER STATES WHAT THE v1 COLUMN IS before any row is read. A stored
// answer and a live one look identical in a cell, and the difference decides
// what the comparison means.

export function QuestionList({
  rows,
  storedV1,
  sweep,
  busy,
  onRunOne,
  onClearSweep,
}: {
  rows: LabRow[]
  storedV1: StoredV1Index
  sweep: StoredSweep | null
  busy: boolean
  onRunOne: (key: string) => void
  /** Absent when no venue is selected. */
  onClearSweep?: () => void
}) {
  const answered = rows.filter((r) => r.v2?.status === 'done').length
  const failed = rows.filter((r) => r.v2?.status === 'error').length
  const notRun = rows.filter((r) => r.v2?.status === 'not_run').length

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-stone-light/60 bg-paper px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium uppercase tracking-wider text-ink-soft">
            {rows.length} questions
          </span>
          {/* Failures counted APART from answers, never folded in: an errored
              arm produces no verdict, and a sweep where a third of the calls
              broke must not read as a sweep with terse replies
              (scripts/CLAUDE.md rule 5). */}
          <span className="text-[11px] tabular-nums text-ink-faint">
            {answered} answered
            {failed > 0 && (
              <span className="pl-1.5 text-destructive">{failed} failed</span>
            )}
            {notRun > 0 && <span className="pl-1.5">{notRun} not run</span>}
          </span>
          {sweep !== null && onClearSweep !== undefined && (
            <button
              type="button"
              onClick={onClearSweep}
              disabled={busy}
              className="ml-auto cursor-pointer text-[11px] uppercase tracking-wider text-ink-faint hover:text-destructive disabled:cursor-default"
            >
              clear sweep
            </button>
          )}
        </div>

        {/* The v1 provenance, stated once at the top rather than per cell.
            This column was NOT generated now and may be several prompt
            versions behind - a surface that showed it as "v1" flat would be
            claiming a comparison against today's v1 that nobody made. */}
        <span className="text-[11px] leading-relaxed text-ink-faint">
          v1 is a <strong>stored snapshot</strong>, not a live call
          {storedV1.promptVersions.length > 0 && (
            <>
              {' '}
              - {storedV1.promptVersions.join(', ')}, captured{' '}
              {storedV1.newestCapturedAt?.slice(0, 10)}
            </>
          )}
          . Bubble counts are not comparable between the columns: v1&apos;s test
          path pins its probabilistic split off.
        </span>
        {/* The GAP, not just the version. A stored answer beside a live one
            reads as "v1 says this"; naming only where it came from leaves the
            reader to notice the shortfall by eye, which is how this was
            caught. */}
        {storedV1.promptVersions.length > 0 &&
          !storedV1.promptVersions.includes(storedV1.livePromptVersion) && (
            <span className="text-[11px] leading-relaxed text-clay-deep">
              v1 ships {storedV1.livePromptVersion} and no stored run holds an
              answer at that version. Re-run{' '}
              <code className="font-mono">npm run measure-golden-set</code>{' '}
              without <code className="font-mono">--skip-v1</code> to refresh
              this column.
            </span>
          )}
        {storedV1.error !== null && (
          <span className="text-[11px] text-destructive" role="alert">
            {storedV1.error}
          </span>
        )}
        {sweep !== null && (
          <span className="text-[11px] leading-relaxed text-ink-soft">
            showing a sweep from{' '}
            {sweep.startedAt.slice(0, 16).replace('T', ' ')} on{' '}
            {sweep.arm.modelKey} · effort {sweep.arm.effort} ·{' '}
            {sweep.arm.templateVersion}
            {sweep.arm.promptEdited && ' · hand-edited system prompt'}
            {sweep.arm.promptName !== '' && ` · "${sweep.arm.promptName}"`}
          </span>
        )}
      </div>

      {GOLDEN_GROUPS.map((group) => {
        const inGroup = rows.filter((r) => r.question.group === group)
        if (inGroup.length === 0) return null
        return (
          <div key={group}>
            <div className="border-b border-stone-light/60 bg-parchment/40 px-4 py-1.5">
              <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                {group}
              </span>
            </div>
            {inGroup.map((row) => (
              <ComparisonRow
                key={row.question.key}
                row={row}
                busy={busy}
                onRun={() => onRunOne(row.question.key)}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

export { Button }
