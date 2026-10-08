import { Card } from '@/components/ui/card'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { CommitGroup } from './_components/commit-group'
import { loadGoldenPage, RUNS_LIMIT } from './_lib/load-golden'

// /admin/tests/golden - the questions a guest actually asks, with v1's answer
// and v2's answer side by side, grouped by the commit the run was made at.
//
// NOTHING HERE IS SCORED. There is no expected answer, no grader and no
// pass/fail: the page exists to be read. Runs come from
// `npm run measure-golden-set`; the questions are code
// (lib/eval/golden-set.ts), so the set shown is always the set the harness
// would run.

export const dynamic = 'force-dynamic'

export default async function GoldenPage() {
  const data = await loadGoldenPage()
  const runCount = data.groups.reduce((n, g) => n + g.runs.length, 0)

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        eyebrow={<Eyebrow>Command Center</Eyebrow>}
        title="Golden set"
        subtitle={
          data.degraded
            ? 'degraded'
            : `${data.questionCount} questions · ${runCount} run${runCount === 1 ? '' : 's'}${data.hasMoreRuns ? ` of more (showing the newest ${RUNS_LIMIT})` : ''}`
        }
      />

      {data.degraded ? (
        <Card className="block rounded-[2px] border-destructive/40 bg-destructive/5 p-4 text-sm">
          {data.degraded}
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Every question is a cold open - the guest&apos;s first ever message - so
        both engines see a stranger with no history. In both columns a line
        break is a real bubble boundary, but the COUNTS are not comparable: v2
        emits its bubbles directly, while the v1 test path pins the
        probabilistic sentence split off, so a v1 reply only splits where a tail
        earns its own bubble (the further-help offer, the getting-to-know-you
        question). Route is not comparable either - v1&apos;s test draft stops
        before the approval triggers, so only v2 reports a gate verdict. Add or
        reword a question in{' '}
        <code className="rounded bg-muted px-1">lib/eval/golden-set.ts</code> -
        no SQL, no apply.
      </p>

      {runCount === 0 && !data.degraded ? (
        <p className="text-sm text-muted-foreground">
          No stored runs yet. Run{' '}
          <code className="rounded bg-muted px-1">
            npm run measure-golden-set
          </code>{' '}
          during the venue&apos;s open hours to record one.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {data.groups.map((group) => (
            <CommitGroup key={group.gitSha ?? 'none'} group={group} />
          ))}
        </div>
      )}
    </div>
  )
}
