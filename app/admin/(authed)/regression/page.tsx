import { Card } from '@/components/ui/card'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { loadRegressionPage, RUNS_LIMIT } from './_lib/load-regression'
import { RunCard } from './_components/run-card'
import { ScenarioList } from './_components/scenario-list'

// /admin/regression - the v2 template's test cases and their results.
// Scenarios are REGRESSION_SCENARIOS in lib/eval/regression-scenarios.ts
// (decision 0011); this page shows them and owns one write, the enabled
// overlay. Runs come from the measure-template-regression harness, which
// stores verdicts once (scenarioVerdict) - this page renders stored
// verdicts, never re-derives them. Auth is gated by the (authed) layout;
// the write route under api/ carries its own gate.

export const dynamic = 'force-dynamic'

export default async function RegressionPage() {
  const data = await loadRegressionPage()

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        eyebrow={<Eyebrow>Command Center</Eyebrow>}
        title="Template regression"
        subtitle={
          data.degraded
            ? 'degraded'
            : `${data.scenarios.filter((s) => s.enabled).length} enabled scenarios · last ${data.runs.length} runs${data.hasMoreRuns ? ` of more (showing ${RUNS_LIMIT})` : ''}`
        }
      />

      {data.degraded ? (
        <Card className="block rounded-[2px] border-destructive/40 bg-destructive/5 p-4 text-sm">
          {data.degraded}
        </Card>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Scenarios
        </h2>
        <ScenarioList scenarios={data.scenarios} />
        <p className="text-xs text-muted-foreground">
          Each scenario guards a measured lesson from the template changelog,
          and lives in{' '}
          <code className="rounded bg-muted px-1">
            lib/eval/regression-scenarios.ts
          </code>
          . Adding one is a PR against that array - no migration, no SQL. This
          page owns the enabled flag only: disable to silence a case without a
          deploy, clear the override to hand it back to the code. A new template
          lesson ships with a new scenario
          (.claude/rules/v2-template-regression.md).
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Runs
        </h2>
        {data.runs.length === 0 && !data.degraded ? (
          <p className="text-sm text-muted-foreground">
            No stored runs yet. Run{' '}
            <code className="rounded bg-muted px-1">
              npm run measure-template-regression -- --samples=6
            </code>{' '}
            to record one.
          </p>
        ) : (
          data.runs.map((run) => <RunCard key={run.id} run={run} />)
        )}
      </section>
    </div>
  )
}
