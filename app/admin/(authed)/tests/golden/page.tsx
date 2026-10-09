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
            : `${data.questionCount} scenarios, ${data.runnableCount} runnable · ${runCount} run${runCount === 1 ? '' : 's'}${data.hasMoreRuns ? ` of more (showing the newest ${RUNS_LIMIT})` : ''}`
        }
      />

      {data.degraded ? (
        <Card className="block rounded-[2px] border-destructive/40 bg-destructive/5 p-4 text-sm">
          {data.degraded}
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground">
        A scenario with no prior messages is a cold open - the guest&apos;s
        first ever message - and both engines then see a stranger with no
        history. A scenario that needs a conversation behind it carries its own
        past messages, authored in code, and both arms read the same transcript;
        nothing is seeded and no visit is declared. In both columns a line break
        is a real bubble boundary, but the COUNTS are not comparable: v2 emits
        its bubbles directly, while the v1 test path pins the probabilistic
        sentence split off, so a v1 reply only splits where a tail earns its own
        bubble (the further-help offer, the getting-to-know-you question). Route
        is not comparable either - v1&apos;s test draft stops before the
        approval triggers, so only v2 reports a gate verdict. Add or reword a
        scenario in{' '}
        <code className="rounded bg-muted px-1">lib/eval/golden-set.ts</code> -
        no SQL, no apply.
      </p>

      {data.gaps.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            In the set, not run ({data.gaps.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            Every one of these is a real production path whose only entry point
            SENDS, so there is no reply to read without new test-mode plumbing
            in <code className="rounded bg-muted px-1">lib/agent/</code>. They
            are listed rather than dropped: a run covering {data.runnableCount}{' '}
            of {data.questionCount} would otherwise read as the whole set.
          </p>
          <div className="flex flex-col gap-2">
            {data.gaps.map((gap) => (
              <div key={gap.key} className="flex flex-col">
                <span className="text-sm">
                  {gap.question}{' '}
                  <span className="font-mono text-xs text-muted-foreground">
                    {gap.key} · {gap.driver}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {gap.reason}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

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
