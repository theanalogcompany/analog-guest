// Loader for /admin/regression. One loader per surface, cache()-wrapped.
//
// Scenario definitions come from REGRESSION_SCENARIOS in code, never from the
// database (decision 0011) - so this page cannot show a different set from
// the one the harness runs, and the list is never empty. The table is read
// only for the `enabled` overlay, through the same resolveScenarios the
// harness calls.
//
// Degrade, do not 500: the runs tables can still be unreadable, and an
// unreadable overlay still renders every scenario (with the code flags) plus
// a banner - an unlabelled empty list reads as "no scenarios", a false
// absolute claim.

import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'
import {
  type ResolvedScenario,
  resolveScenarios,
} from '@/lib/eval/regression-scenarios'
import {
  type RegressionSample,
  RegressionSampleSchema,
  RegressionVerdictsSchema,
} from '@/lib/schemas/regression'

export const RUNS_LIMIT = 10

export interface ScenarioListItem extends ResolvedScenario {
  /**
   * 'code' is a real scenario. 'orphan' is an overlay row whose key is in no
   * code definition: it does NOT run, and it is rendered so it cannot sit in
   * the table looking like a guard.
   */
  source: 'code' | 'orphan'
}

export interface RunListItem {
  id: string
  venueName: string
  venueSlug: string
  promptVersion: string
  judgeVersion: string
  samples: number
  gitSha: string | null
  packRows: number
  verdicts: Record<string, string>
  scenariosPassed: number
  scenariosTotal: number
  fullRun: boolean
  startedAt: string
  units: Array<{
    scenarioKey: string
    sample: number
    unit: RegressionSample | null
  }>
}

export interface RegressionPageData {
  /** Set when the overlay or the runs tables are unreadable. */
  degraded: string | null
  scenarios: ScenarioListItem[]
  runs: RunListItem[]
  hasMoreRuns: boolean
}

export const loadRegressionPage = cache(
  async (): Promise<RegressionPageData> => {
    const supabase = createAdminClient()

    const overlayResult = await supabase
      .from('regression_scenarios')
      .select('key, enabled')
    const overlayDegraded = overlayResult.error
      ? `the enabled overlay is unreadable (${overlayResult.error.message}) - every scenario below shows its code default, and the harness would run those. Has migration 077 been applied in Supabase Studio?`
      : null

    const resolved = resolveScenarios(overlayResult.data ?? [])
    const scenarios: ScenarioListItem[] = [
      ...resolved.scenarios.map((scenario) => ({
        ...scenario,
        source: 'code' as const,
      })),
      // Orphans last: a row nothing in code defines. Rendered with the empty
      // definition it has, because that is the truth about it.
      ...resolved.orphanKeys.map((key) => ({
        key,
        lesson:
          'No code definition for this key, so this row is not a scenario and the harness does not run it. Either add it to REGRESSION_SCENARIOS in lib/eval/regression-scenarios.ts, or clear the row.',
        script: [],
        target: [],
        expectFirstName: null,
        noTurnOneNameAsk: false,
        expectReplyContains: null,
        forbidPolicyKeys: [],
        expectPolicyKeys: [],
        enabled: false,
        enabledOverridden: false,
        source: 'orphan' as const,
      })),
    ]

    // Newest-first window + LIMIT+1 so the page can state the cap honestly.
    const runsResult = await supabase
      .from('regression_runs')
      .select(
        'id, venue_id, prompt_version, judge_version, samples, git_sha, pack_rows, verdicts, scenarios_passed, scenarios_total, full_run, started_at, venues(name, slug)',
      )
      .order('started_at', { ascending: false })
      .limit(RUNS_LIMIT + 1)
    if (runsResult.error) {
      return {
        degraded: [
          overlayDegraded,
          `regression_runs unreadable (${runsResult.error.message})`,
        ]
          .filter((m) => m !== null)
          .join(' · '),
        scenarios,
        runs: [],
        hasMoreRuns: false,
      }
    }
    const runRows = (runsResult.data ?? []).slice(0, RUNS_LIMIT)
    const hasMoreRuns = (runsResult.data ?? []).length > RUNS_LIMIT

    const unitsResult =
      runRows.length === 0
        ? { data: [], error: null }
        : await supabase
            .from('regression_run_units')
            .select('run_id, scenario_key, sample, unit')
            .in(
              'run_id',
              runRows.map((r) => r.id),
            )
            .order('sample', { ascending: true })

    const unitsByRun = new Map<
      string,
      Array<{
        scenarioKey: string
        sample: number
        unit: RegressionSample | null
      }>
    >()
    for (const row of unitsResult.data ?? []) {
      const parsed = RegressionSampleSchema.safeParse(row.unit)
      const list = unitsByRun.get(row.run_id) ?? []
      list.push({
        scenarioKey: row.scenario_key,
        sample: row.sample,
        // null = stored unit failed parse; rendered as such, never dropped.
        unit: parsed.success ? parsed.data : null,
      })
      unitsByRun.set(row.run_id, list)
    }

    const runs: RunListItem[] = runRows.map((row) => {
      const verdictsParsed = RegressionVerdictsSchema.safeParse(row.verdicts)
      return {
        id: row.id,
        venueName: row.venues?.name ?? '(deleted venue)',
        venueSlug: row.venues?.slug ?? '',
        promptVersion: row.prompt_version,
        judgeVersion: row.judge_version,
        samples: row.samples,
        gitSha: row.git_sha,
        packRows: row.pack_rows,
        verdicts: verdictsParsed.success ? verdictsParsed.data : {},
        scenariosPassed: row.scenarios_passed,
        scenariosTotal: row.scenarios_total,
        fullRun: row.full_run,
        startedAt: row.started_at,
        units: unitsByRun.get(row.id) ?? [],
      }
    })

    return { degraded: overlayDegraded, scenarios, runs, hasMoreRuns }
  },
)
