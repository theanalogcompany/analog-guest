'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { GoldenTranscript } from '@/app/admin/_components/golden-transcript'
import {
  needsPreference,
  type HumanEvalJudgment,
  type HumanEvalPreference,
  type HumanEvalVerdict,
} from '@/lib/eval/human-eval'
import type { GoldenQuestion, GoldenV1, GoldenV2 } from '@/lib/schemas/golden'
import type { HumanEvalUnitView } from '../_lib/types'

// One question, blind: the input both engines were given, then their two
// replies as A and B with nothing saying which is which.
//
// ONE AT A TIME, NOT SIDE BY SIDE. A is graded first and B is not on screen
// until it has been - see `showB`. Two replies rendered together are read
// against each other, and "is this an acceptable reply" becomes "which of
// these is better" without anyone deciding to change the question.
//
// WHAT THIS COMPONENT DELIBERATELY DOES NOT RENDER, and why each one matters -
// every item here is something /admin/prompt-lab's comparison row DOES show,
// and any one of them hands the rater the answer:
//
//   * COLOUR. The prompt lab tints v2's bubbles blue and outlines v1's so the
//     eye lands on v2. Here both replies are the same outlined bubble.
//   * the prompt version, the model, the effort, the duration - v1 and v2
//     never carry the same values, so one glance at a meta line identifies
//     both columns.
//   * v2's gate verdict and v1's category and recognition band, which only
//     one engine has at all.
//   * v1's `substitute` label. "v1 sends its fixed crisis-safety reply" names
//     the engine in the sentence. A row where one arm sent nothing renders
//     `[no reply]` in the SAME shape either reply would take, so the absence
//     does not read as a label.
//
// NONE OF IT IS AVAILABLE FROM THIS PAGE AT ALL. There is no reveal: the CSV
// export is the only place A and B are named, so the rater cannot unblind a
// row they are still judging, or the next one. A surface that CAN unblind has
// to be audited to be believed - one that cannot does not.
//
// THE ORDER COMES FROM THE ROW, not from this render. `aArm` was decided and
// stored by the server when the pair was generated, so a re-render, a reload
// and the CSV all agree about what the rater was looking at.

export function BlindRow({
  question,
  unit,
  judgment,
  saveState,
  busy,
  readOnly,
  onJudge,
  onRegenerate,
}: {
  /** Null for an orphan key - a question reworded or removed after the pass. */
  question: GoldenQuestion | null
  unit: HumanEvalUnitView
  /**
   * What the rater has decided - the stored row's judgment, or the one they
   * have clicked that is still being written. EVERY control reads this rather
   * than `unit`, so a second click composes with the first instead of with a
   * row that has not caught up yet (the parent's `onJudge` has the failure
   * this prevents).
   */
  judgment: HumanEvalJudgment
  saveState: 'idle' | 'saving' | 'saved' | { error: string }
  busy: boolean
  /**
   * The pass was submitted, so nothing here can change. Every control is
   * disabled rather than hidden - the judgments are still the thing worth
   * reading, and a row stripped of its verdict buttons would read as
   * unjudged. The routes refuse the writes too (migration 084).
   */
  readOnly: boolean
  onJudge: (judgment: HumanEvalJudgment) => void
  onRegenerate: () => void
}) {
  // The note is typed, so it is held locally and committed on blur - a write
  // per keystroke would be a request per keystroke.
  //
  // RE-SEEDED DURING RENDER (React's own adjusting-state-when-props-change
  // pattern), not in an effect: an effect would render the stale draft once
  // first, and the point of re-seeding is that a change arriving from anywhere
  // else - a regenerate clearing the row - lands in the box immediately.
  const [draft, setDraft] = useState({
    id: unit.id,
    committed: judgment.note,
    text: judgment.note,
  })
  if (draft.id !== unit.id || draft.committed !== judgment.note)
    setDraft({ id: unit.id, committed: judgment.note, text: judgment.note })
  const note = draft.id === unit.id ? draft.text : judgment.note

  // One condition, two things hang off it: something failed, so there is a
  // better-reply question to ask and a comment the row cannot do without
  // (`judgmentComplete` in lib/eval/human-eval.ts is the same predicate).
  const askPreference = needsPreference(judgment.aVerdict, judgment.bVerdict)
  const noteMissing = askPreference && note.trim().length === 0

  // ONE REPLY AT A TIME. B is withheld until A has a verdict, because two
  // replies on screen together are judged against each other - the second one
  // read becomes the yardstick for the first, and "is this an acceptable
  // reply" quietly turns into "which of these two is better", which is a
  // different question and the one the preference control asks separately.
  //
  // `|| bVerdict !== null` so clearing A after grading B does not yank B off
  // the screen mid-row. Clearing both hides it again, which is the honest
  // state: nothing has been judged here.
  const showB = judgment.aVerdict !== null || judgment.bVerdict !== null

  // A row where either engine produced nothing is not judgeable: there is no
  // pair to compare, and a verdict on an error message is not a verdict on a
  // reply. Shown with the failure, counted apart, and the form withheld
  // rather than inviting a judgment that would mean nothing.
  const aColumn = unit.aArm === 'v1' ? unit.v1 : unit.v2
  const bColumn = unit.aArm === 'v1' ? unit.v2 : unit.v1
  const broken =
    unit.v1 === null || unit.v2 === null || !unit.v1.ok || !unit.v2.ok

  const judge = (patch: Partial<HumanEvalJudgment>): void => {
    const next: HumanEvalJudgment = { ...judgment, note, ...patch }
    // A preference only exists while something has failed. Cleared here
    // rather than refused at the route, so flipping the last failing verdict
    // to `pass` cannot leave a stored preference adjudicating nothing - the
    // route would reject the write outright, and the rater would see a failed
    // save for a change that was perfectly sensible.
    if (!needsPreference(next.aVerdict, next.bVerdict)) next.preference = null
    onJudge(next)
  }

  return (
    <div className="flex flex-col gap-3 border-b border-stone-light/60 px-4 py-4">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-ink">
          {question?.question ?? '(question no longer in the set)'}
        </span>
        <span className="font-mono text-[11px] text-ink-faint">
          {unit.questionKey}
          {question !== null &&
            (question.history ?? []).length === 0 &&
            ' · cold open'}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <SaveState state={saveState} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            disabled={busy || readOnly}
            title={
              readOnly
                ? 'This pass was submitted - its replies are what the CSV quotes'
                : undefined
            }
            onClick={onRegenerate}
          >
            Regenerate
          </Button>
        </span>
      </div>

      {question !== null ? <GoldenTranscript question={question} /> : null}

      {unit.parseError !== null ? (
        <p className="text-xs text-destructive" role="alert">
          {unit.parseError}
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        <Reply
          label="Reply A"
          reply={aColumn}
          verdict={judgment.aVerdict}
          disabled={broken || readOnly}
          onVerdict={(v) => judge({ aVerdict: v })}
        />
        {showB ? (
          <Reply
            label="Reply B"
            reply={bColumn}
            verdict={judgment.bVerdict}
            disabled={broken || readOnly}
            onVerdict={(v) => judge({ bVerdict: v })}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <span className="text-[11px] uppercase tracking-wider text-ink-faint">
              Reply B
            </span>
            <span className="text-[11px] italic text-ink-faint">
              Grade reply A first. B stays hidden until then, so the first read
              of A is not an argument with something already on screen.
            </span>
          </div>
        )}
      </div>

      {broken ? (
        <p className="text-[11px] italic text-ink-faint">
          One engine produced no reply, so there is nothing to compare. Not
          judgeable - regenerate it, or leave it as the finding it is.
        </p>
      ) : (
        <>
          {askPreference ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                Better reply
              </span>
              {(
                [
                  ['a', 'A'],
                  ['b', 'B'],
                  ['neither', 'Neither'],
                ] as Array<[HumanEvalPreference, string]>
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={
                    judgment.preference === value ? 'default' : 'outline'
                  }
                  className="h-6 px-2 text-[11px]"
                  disabled={readOnly}
                  onClick={() =>
                    judge({
                      preference: judgment.preference === value ? null : value,
                    })
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
          ) : null}

          {/* A frozen row with nothing written reads better as nothing than
              as an empty box that can never be filled in. */}
          {readOnly && note.trim().length === 0 ? null : (
            <Textarea
              value={note}
              onChange={(e) =>
                setDraft({
                  id: unit.id,
                  committed: judgment.note,
                  text: e.target.value,
                })
              }
              // Committed on blur, and only when it actually changed - a tab
              // through the field must not cost a write.
              onBlur={() => {
                if (note !== judgment.note) judge({ note })
              }}
              rows={2}
              readOnly={readOnly}
              placeholder={
                askPreference
                  ? 'Required - what is wrong with the failing reply?'
                  : 'Anything worth noting (optional)'
              }
              // Marked on the box itself rather than only in the line below:
              // the rater is looking at the control they have to fill in, and a
              // message somewhere else on a row this tall is a message they
              // scroll past.
              className={
                noteMissing
                  ? 'border-destructive text-xs focus-visible:ring-destructive/40'
                  : 'text-xs'
              }
              aria-invalid={noteMissing}
            />
          )}

          {noteMissing ? (
            // Not an error - nothing failed to save. The verdict IS stored;
            // this says the row is not finished, which is what the count in
            // the bar above is counting.
            <p className="text-[11px] text-destructive">
              A comment is required once either reply is a fail - the verdict is
              saved, the finding is what the pass is for.
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * One reply and its verdict. The two blocks are byte-identical in styling -
 * see the header for why that is the whole point.
 */
function Reply({
  label,
  reply,
  verdict,
  disabled,
  onVerdict,
}: {
  label: string
  /**
   * Either engine's stored answer. THE UNION IS THE POINT: this component is
   * handed v1's column or v2's depending on the scramble, and typing it as
   * either one would make the other a cast - which is how a renderer ends up
   * quietly reading a field only one engine has.
   */
  reply: GoldenV1 | GoldenV2 | null
  verdict: HumanEvalVerdict | null
  disabled: boolean
  onVerdict: (verdict: HumanEvalVerdict | null) => void
}) {
  // `bubbles` on v1, `messages` on v2 - the two engines name the same thing
  // differently and the rater must not be able to tell which they are reading.
  const bubbles =
    reply === null || !reply.ok
      ? []
      : 'bubbles' in reply
        ? reply.bubbles
        : reply.messages
  return (
    // Stacked, one reply above the other, each with its buttons directly
    // under it - the replies are graded one at a time, so a control shared
    // between two columns or aligned across them would belong to neither.
    <div className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      {reply === null ? (
        <span className="text-[11px] text-destructive" role="alert">
          unreadable stored answer
        </span>
      ) : !reply.ok ? (
        <span className="text-[11px] text-destructive" role="alert">
          no reply - failed at {reply.stage}: {reply.error}
        </span>
      ) : bubbles.length === 0 ? (
        // An engine that deliberately sent nothing. Rendered in the same
        // shape as a reply, because "sent nothing, by design" is an answer and
        // a blank cell would read as a missing one.
        <span className="w-fit rounded-2xl border border-stone-light bg-parchment px-3 py-1.5 text-xs italic text-ink-faint">
          [no reply sent]
        </span>
      ) : (
        bubbles.map((b, i) => (
          // Capped at the width a text bubble actually has. Full-width in a
          // stacked layout, a two-line reply reads as a paragraph of prose,
          // which is not what the guest would see and not what is being
          // judged.
          <div
            key={i}
            className="w-fit max-w-[32rem] rounded-2xl border border-stone-light bg-paper px-3 py-1.5 text-xs leading-snug text-ink"
          >
            {b}
          </div>
        ))
      )}
      <div className="flex items-center gap-2 pt-1">
        {(['pass', 'fail'] as const).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={
              verdict === value
                ? value === 'fail'
                  ? 'destructive'
                  : 'default'
                : 'outline'
            }
            className="h-6 px-3 text-[11px]"
            disabled={disabled}
            // Clicking the selected verdict clears it. A judgment surface
            // needs an undo for a mis-click, and "unjudged" is a real state
            // here - it is what the counts and the export call not answered.
            onClick={() => onVerdict(verdict === value ? null : value)}
          >
            {value}
          </Button>
        ))}
      </div>
    </div>
  )
}

function SaveState({
  state,
}: {
  state: 'idle' | 'saving' | 'saved' | { error: string }
}) {
  if (state === 'idle') return null
  if (state === 'saving')
    return <span className="text-[11px] text-ink-faint">saving…</span>
  if (state === 'saved')
    return <span className="text-[11px] text-ink-faint">saved</span>
  // LOUD, and it stays. A verdict that did not persist while the row looks
  // judged is the one failure this surface cannot absorb: the rater moves on
  // and nothing anywhere says the answer was lost.
  return (
    <span className="text-[11px] text-destructive" role="alert">
      not saved - {state.error}
    </span>
  )
}
