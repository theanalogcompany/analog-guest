'use client'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  humanEvalBlockers,
  type HumanEvalCompleteness,
} from '@/lib/eval/human-eval'
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
//
// SUBMIT IS THE FINISH LINE AND IT IS ONE-WAY. It is disabled until the pass
// is complete, with the label naming exactly what is missing rather than a
// tooltip nobody hovers; it freezes the pass; and until it has been pressed
// there is no CSV link, because the export route refuses an unsubmitted pass.
// The counts here are advisory - `humanEvalCompleteness` is re-run server-side
// by the submit route, which is what actually decides (migration 084).
//
// NEW PASS IS ITS OWN CONTROL, and before it existed there was none: the
// client only ever opened a pass when the venue had none at all, so a venue
// with one pass could never start a second, and a venue whose pass was
// submitted was frozen onto a read-only page for good. It confirms, because
// one press is the same 58 x 2 generations the Generate button prices.
//
// A STALE PASS SAYS SO, LOUDLY AND IN PLACE. The loader will not open one by
// itself, so this only ever fires on a pass picked by hand - and then the
// thing worth saying is not which versions differ but that judging it proves
// nothing about what is shipping now.

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
  completeness,
  submitting,
  submitError,
  onGenerate,
  onCancel,
  onSubmit,
  onNewPass,
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
  /** What is still in the way of submitting. Null before a pass exists. */
  completeness: HumanEvalCompleteness | null
  submitting: boolean
  submitError: string | null
  onGenerate: () => void
  onCancel: () => void
  onSubmit: () => void
  onNewPass: () => void
}) {
  const submitted = session?.submittedAt ?? null
  const blockers = completeness === null ? [] : humanEvalBlockers(completeness)
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
                    {s.startedAt.slice(0, 16).replace('T', ' ')} ·{' '}
                    {s.submittedAt !== null
                      ? 'submitted'
                      : `${s.judged}/${s.generated} judged`}{' '}
                    · {s.v2Model} · {s.venueOpenState}
                    {/* Marked in the list rather than only after it is open,
                        so picking one is an informed choice instead of a
                        surprise. */}
                    {s.stale ? ' · old engine' : ''}
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
          {needComment > 0 && submitted === null ? (
            <span className="text-xs text-destructive">
              {needComment} need a comment
            </span>
          ) : null}
          {/* Always available, including on a submitted pass - a frozen pass
              used to be a dead end with no way out of it. */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={venueId === null || busy}
            onClick={onNewPass}
          >
            New pass
          </Button>

          {submitted !== null ? null : busy ? (
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
              variant="outline"
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

          {/* THE FINISH LINE, and the only route to a CSV. Before: a Submit
              that says what is missing. After: the instant, and the file.
              Never both, because a pass is in exactly one of those states. */}
          {session === null ? null : submitted !== null ? (
            <span className="flex items-center gap-3 text-xs text-ink-faint">
              submitted {submitted.slice(0, 16).replace('T', ' ')}
              <a
                className="underline underline-offset-4"
                href={`/admin/tests/human-eval/api/export?sessionId=${session.id}`}
              >
                Download CSV
              </a>
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              // The label carries the reason. A disabled button with the
              // reason in a tooltip is a button that reads as broken, and
              // "what is left to do" is the one thing a rater on row 50 of 58
              // actually wants from this bar.
              disabled={busy || submitting || blockers.length > 0}
              onClick={onSubmit}
            >
              {submitting
                ? 'Submitting…'
                : blockers.length > 0
                  ? `Submit - ${blockers.join(', ')}`
                  : `Submit ${judged} judged rows`}
            </Button>
          )}
        </div>
      </div>

      {submitError !== null ? (
        // The submit route re-checks completeness itself, so this can disagree
        // with the button - and when it does, the route is right. Shown
        // verbatim rather than summarised.
        <p className="text-xs text-destructive" role="alert">
          {submitError}
        </p>
      ) : null}

      {session?.stale != null ? (
        // Not a tooltip and not grey: the provenance line below has carried
        // these versions all along and nobody reads it, which is how a pass
        // three prompt revisions old got judged as if it were current.
        <p
          className="text-xs text-destructive"
          role="status"
          data-testid="stale-pass"
        >
          This pass was generated under an older engine ({session.stale}).
          Verdicts on it are not evidence about what is shipping now - start a
          new pass to judge the current one.
        </p>
      ) : null}

      {submitted === null &&
      completeness !== null &&
      completeness.broken > 0 ? (
        // Named, because these rows cannot be judged and therefore cannot be
        // what is blocking Submit - without this line, "3 rows have no
        // verdict" and "Submit" being enabled look like a contradiction.
        <p className="text-[11px] text-ink-faint">
          {completeness.broken} row{completeness.broken === 1 ? '' : 's'}{' '}
          produced no reply from one engine - not judgeable, exported with the
          failure, and not blocking submission.
        </p>
      ) : null}

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
