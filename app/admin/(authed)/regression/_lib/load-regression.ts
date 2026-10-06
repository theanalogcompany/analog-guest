// Loader for /admin/regression. One loader per surface, cache()-wrapped.
//
// Degrade, do not 500: before migration 069 is applied both selects fail
// with "relation does not exist" - that renders as a banner telling the
// operator which migration to apply, never as an empty page (an unlabelled
// empty list reads as "no scenarios", a false absolute claim).

import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'
import {
  type RegressionSample,
  type RegressionScenario,
  RegressionSampleSchema,
  RegressionScenarioSchema,
  RegressionVerdictsSchema,
} from '@/lib/schemas/regression'

export const RUNS_LIMIT = 10

export interface ScenarioListItem extends RegressionScenario {
  createdAt: string
  /** Set when the stored row failed schema parse - rendered, not hidden. */
  parseError: string | null
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
  /** Set when the tables are unreadable - almost always "apply migration 069". */
  degraded: string | null
  scenarios: ScenarioListItem[]
  runs: RunListItem[]
  hasMoreRuns: boolean
}

export const loadRegressionPage = cache(
  async (): Promise<RegressionPageData> => {
    const supabase = createAdminClient()

    const scenariosResult = await supabase
      .from('regression_scenarios')
      .select(
        'key, lesson, script, target, expect_first_name, no_turn_one_name_ask, expect_reply_contains, forbid_policy_keys, enabled, created_at',
      )
      .order('created_at', { ascending: true })
    if (scenariosResult.error) {
      return {
        degraded: `regression tables unreadable (${scenariosResult.error.message}) - have migrations 069 and 070 been applied in Supabase Studio?`,
        scenarios: [],
        runs: [],
        hasMoreRuns: false,
      }
    }

    const scenarios: ScenarioListItem[] = (scenariosResult.data ?? []).map(
      (row) => {
        const parsed = RegressionScenarioSchema.safeParse({
          key: row.key,
          lesson: row.lesson,
          script: row.script,
          target: row.target,
          expectFirstName: row.expect_first_name,
          noTurnOneNameAsk: row.no_turn_one_name_ask,
          expectReplyContains: row.expect_reply_contains,
          forbidPolicyKeys: row.forbid_policy_keys,
          enabled: row.enabled,
        })
        if (parsed.success) {
          return {
            ...parsed.data,
            createdAt: row.created_at,
            parseError: null,
          }
        }
        // Render the malformed row with its error rather than dropping it -
        // the harness refuses the whole set over this row, so it must be
        // visible here.
        return {
          key: row.key,
          lesson: row.lesson,
          script: [],
          target: [],
          expectFirstName: null,
          noTurnOneNameAsk: false,
          expectReplyContains: null,
          forbidPolicyKeys: [],
          enabled: row.enabled,
          createdAt: row.created_at,
          parseError: parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        }
      },
    )

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
        degraded: `regression_runs unreadable (${runsResult.error.message})`,
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

    return { degraded: null, scenarios, runs, hasMoreRuns }
  },
)
