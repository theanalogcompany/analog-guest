import { Card } from '@/components/ui/card'
import type { GoldenV1, GoldenV2 } from '@/lib/schemas/golden'
import type { GoldenRunView } from '../_lib/load-golden'

// One stored golden-set run: every question with v1's answer and v2's answer
// side by side. Server component, no client JS - the export is a plain
// <a download> pointing at the export route.
//
// Each bubble renders as its own paragraph in both columns, so a line break
// IS a bubble boundary. NO BUBBLE COUNT IS SHOWN though, and that is
// deliberate: the v1 test path pins the probabilistic sentence split off
// (TEST_RUN_SPLIT_RNG = 0.99), so v1 splits only where a tail earns its own
// bubble, while v2 emits `messages[]` directly. Putting the two counts side
// by side would invite reading part of the harness as a finding about the
// engines.

/**
 * An unreadable stored column, or an arm that errored. Never a blank cell.
 *
 * Typed to the FAILURE members only, so this cannot be handed a successful
 * column and render "ERROR" over a real reply.
 */
type FailedColumn = Extract<GoldenV1 | GoldenV2, { ok: false }>

function NotAReply({ column }: { column: FailedColumn | null }) {
  if (column === null)
    return (
      <p className="text-xs text-destructive">
        stored column fails schema parse - see the JSONL run log
      </p>
    )
  return (
    <p className="text-xs text-destructive">
      ERROR at {column.stage}: {column.error}
    </p>
  )
}

function Bubbles({ messages }: { messages: readonly string[] }) {
  return (
    <div className="flex flex-col gap-1">
      {messages.map((m, i) => (
        <p key={i} className="text-sm">
          {m}
        </p>
      ))}
    </div>
  )
}

const SUBSTITUTE_LABEL = {
  crisis_safety: 'crisis safety reply, not a generation',
  media_only_card: 'no reply - v1 would have raised a blank operator card',
  opt_out_confirmation: 'opt-out confirmation, not a generation',
} as const

function V1Reply({ column }: { column: GoldenV1 | null }) {
  if (column === null || !column.ok) return <NotAReply column={column} />
  // A substitute means v1 answered WITHOUT generating text. Labelled rather
  // than rendered as an empty column: "v1 would have sent this fixed text" and
  // "v1 would have sent nothing and carded it" are different answers, and a
  // comparison surface showing both as silence is lying about one of them.
  if (column.substitute !== null)
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-amber-700">
          {SUBSTITUTE_LABEL[column.substitute]}
        </p>
        <Bubbles messages={column.bubbles} />
      </div>
    )
  return <Bubbles messages={column.bubbles} />
}

function V2Reply({ column }: { column: GoldenV2 | null }) {
  if (column === null || !column.ok) return <NotAReply column={column} />
  return <Bubbles messages={column.messages} />
}

export function RunCard({ run }: { run: GoldenRunView }) {
  const started = new Date(run.startedAt)
  return (
    <Card className="block rounded-[2px] border-stone-light/60 bg-paper p-4 shadow-none">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-medium">
            {run.units.length} question{run.units.length === 1 ? '' : 's'}
          </span>
          <span className="text-xs text-muted-foreground">
            {started.toISOString().replace('T', ' ').slice(0, 16)}Z ·{' '}
            {run.venueName} · venue {run.venueOpenState}
            {run.fullRun ? '' : ' · PARTIAL RUN'}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            v1 {run.v1PromptVersion} · v2 {run.v2PromptVersion}
          </span>
        </div>
        <a
          href={`/admin/tests/golden/api/export?runId=${run.id}`}
          download
          className="text-xs underline"
        >
          Export CSV
        </a>
      </div>

      {run.venueOpenState !== 'open' ? (
        <p className="mt-2 text-xs text-amber-700">
          The venue was {run.venueOpenState} for this run. The prompt carries
          that line, so every reply below reads differently from one taken
          during opening hours - and this run is not comparable with one taken
          in another state.
        </p>
      ) : null}

      <div className="mt-4 flex flex-col divide-y divide-stone-light/60">
        {run.units.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            no stored units for this run
          </p>
        ) : (
          run.units.map((unit, i) => (
            <div key={i} className="flex flex-col gap-2 py-3 first:pt-0">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-sm font-medium">
                  {unit.question?.question ?? '(question no longer in the set)'}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {unit.question?.key ?? unit.orphanKey}
                  {unit.question ? ` · ${unit.question.group}` : ' · orphan'}
                </span>
              </div>
              {unit.parseError ? (
                <p className="text-xs text-destructive">{unit.parseError}</p>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    v1
                    {unit.v1?.ok
                      ? ` · ${unit.v1.category} · ${unit.v1.recognitionState}`
                      : ''}
                  </span>
                  <V1Reply column={unit.v1} />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    v2
                    {unit.v2?.ok ? ` · ${unit.v2.stateKey}` : ''}
                    {unit.v2?.ok && unit.v2.gateVerdict !== null
                      ? ` · gate ${unit.v2.gateVerdict}`
                      : ''}
                    {unit.v2?.ok && unit.v2.gateMatched.length > 0
                      ? ` (${unit.v2.gateMatched.join(', ')})`
                      : ''}
                  </span>
                  <V2Reply column={unit.v2} />
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  )
}
