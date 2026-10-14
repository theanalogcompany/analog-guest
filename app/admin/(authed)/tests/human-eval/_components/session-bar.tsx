'use client'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { VenueListRow } from '../../../_lib/load-venues'
import type {
  HumanEvalSessionSummary,
  HumanEvalSessionView,
} from '../_lib/types'

// The pass's controls and its provenance.
//
// THE COUNT AND THE COST RIDE THE BUTTON, the same posture the prompt lab's
// "Run all" has: one press is up to 58 questions times TWO live generations,
// and a button reading "Generate" hides that.
//
// IT ONLY EVER GENERATES WHAT IS MISSING. There is no bulk re-generate, and
// that is a safety property rather than an omission: re-generating a question
// clears its verdicts, so one wrong click on a finished pass would destroy an
// hour of human judgment. Re-doing a single row is a button on that row.

export function SessionBar({
  venues,
  venueId,
  sessions,
  session,
  missing,
  generated,
  judged,
  needComment,
  judgeable,
  running,
  busy,
  onGenerate,
  onCancel,
}: {
  venues: VenueListRow[]
  venueId: string | null
  sessions: HumanEvalSessionSummary[]
  session: HumanEvalSessionView | null
  missing: number
  generated: number
  judged: number
  /** Judged rows with a fail and no comment - the pass is not done yet. */
  needComment: number
  judgeable: number
  running: number
  busy: boolean
  onGenerate: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-stone-light/60 px-4 py-3">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Venue">
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
        </Field>

        {sessions.length > 0 && venueId !== null ? (
          <Field label="Pass">
            <Select
              value={session?.id ?? ''}
              onValueChange={(v) => {
                window.location.search = `?venue=${venueId}&session=${v}`
              }}
              disabled={busy}
            >
              <SelectTrigger className="min-w-[20rem]" size="sm">
                <SelectValue placeholder="pick a pass" />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.startedAt.slice(0, 16).replace('T', ' ')} · {s.judged}/
                    {s.generated} judged · {s.v2Model} · {s.venueOpenState}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-ink-faint">
            {/* "0/0 judged" on a pass that has not generated anything reads as
                a finished pass of nothing. Before the first pair lands the
                only true statement is how much there is to do. */}
            {generated === 0
              ? `nothing generated yet · ${judgeable} to go`
              : `${judged}/${generated} judged`}
            {generated > 0 && generated < judgeable
              ? ` · ${generated} of ${judgeable} generated`
              : ''}
            {running > 0 ? ` · ${running} in flight` : ''}
          </span>
          {/* Loud, and beside the count it qualifies: "58/58 judged" next to
              four findings nobody wrote down is a pass that looks finished
              and is not. */}
          {needComment > 0 ? (
            <span className="text-xs text-destructive">
              {needComment} need a comment
            </span>
          ) : null}
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
            <Button
              type="button"
              size="sm"
              disabled={venueId === null || missing === 0}
              onClick={onGenerate}
              title={
                missing === 0
                  ? 'Every question both engines can answer already has a pair - use a row’s Regenerate to redo one'
                  : undefined
              }
            >
              {missing === 0
                ? 'All generated'
                : `Generate ${missing} × 2 replies`}
            </Button>
          )}
          {session !== null ? (
            <a
              className="text-xs underline underline-offset-4"
              href={`/admin/tests/human-eval/api/export?sessionId=${session.id}`}
            >
              CSV
            </a>
          ) : null}
        </div>
      </div>

      {session !== null ? (
        // The code state the answers were generated under. On the pass rather
        // than read live, because a verdict given today against v2.3 is not
        // evidence about v2.4 - and the open state because the prompt carries
        // an open/closed line, so a pass taken after close hedged its way
        // through every scenario in it.
        <p className="text-[11px] text-ink-faint">
          v1 {session.v1PromptVersion} · v2 {session.v2PromptVersion} ·{' '}
          {session.v2Model} · venue {session.venueOpenState} · started{' '}
          {session.startedAt.slice(0, 16).replace('T', ' ')}
          {session.gitSha !== null
            ? ` · ${session.gitSha.slice(0, 7)}`
            : ' · no commit recorded (local dev)'}
        </p>
      ) : null}
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider text-ink-soft">
        {label}
      </span>
      {children}
    </div>
  )
}
