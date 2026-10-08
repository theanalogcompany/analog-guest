// Loader for /admin/tests/golden. One loader per surface, cache()-wrapped.
//
// The QUESTIONS are not loaded: they are GOLDEN_QUESTIONS in
// lib/eval/golden-set.ts, so the question half of this page cannot degrade
// and cannot disagree with what the harness ran. Only the run half reads the
// database.
//
// Degrade, do not 500: before migration 078 is applied the select fails with
// "relation does not exist", which renders as a banner naming the migration -
// never as an empty page, because an unlabelled empty list reads as "no runs
// have ever been made", a false absolute claim.

import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-set'
import {
  GoldenV1Schema,
  GoldenV2Schema,
  type GoldenQuestion,
  type GoldenV1,
  type GoldenV2,
} from '@/lib/schemas/golden'

export const RUNS_LIMIT = 20

export interface GoldenUnitView {
  question: GoldenQuestion | null
  /** Set when the stored key is not in GOLDEN_QUESTIONS - an orphan, rendered. */
  orphanKey: string | null
  v1: GoldenV1 | null
  v2: GoldenV2 | null
  /** Set when a stored column failed schema parse - rendered, never dropped. */
  parseError: string | null
}

export interface GoldenRunView {
  id: string
  venueName: string
  gitSha: string | null
  gitSubject: string | null
  gitDirty: boolean
  v1PromptVersion: string
  v2PromptVersion: string
  venueOpenState: string
  questionsTotal: number
  fullRun: boolean
  startedAt: string
  finishedAt: string | null
  units: GoldenUnitView[]
}

export interface CommitGroup {
  gitSha: string | null
  gitSubject: string | null
  /** Any run in this group was made over a dirty tree. */
  anyDirty: boolean
  runs: GoldenRunView[]
}

export interface GoldenPageData {
  /** Set when the tables are unreadable - almost always "apply migration 078". */
  degraded: string | null
  questionCount: number
  groups: CommitGroup[]
  hasMoreRuns: boolean
}

export const loadGoldenPage = cache(async (): Promise<GoldenPageData> => {
  const supabase = createAdminClient()
  const byKey = new Map(GOLDEN_QUESTIONS.map((q) => [q.key, q]))

  // Newest-first window + LIMIT+1 so the page can state the cap honestly:
  // comparing rows.length to the cap cannot tell exactly-N from more-than-N,
  // and the page states the cap as fact.
  const runsResult = await supabase
    .from('golden_runs')
    .select(
      'id, git_sha, git_subject, git_dirty, v1_prompt_version, v2_prompt_version, venue_open_state, questions_total, full_run, started_at, finished_at, venues(name)',
    )
    .order('started_at', { ascending: false })
    .limit(RUNS_LIMIT + 1)
  if (runsResult.error) {
    return {
      degraded: `golden_runs unreadable (${runsResult.error.message}) - has migration 078 been applied?`,
      questionCount: GOLDEN_QUESTIONS.length,
      groups: [],
      hasMoreRuns: false,
    }
  }
  const runRows = (runsResult.data ?? []).slice(0, RUNS_LIMIT)
  const hasMoreRuns = (runsResult.data ?? []).length > RUNS_LIMIT

  const unitsResult =
    runRows.length === 0
      ? { data: [], error: null }
      : await supabase
          .from('golden_run_units')
          .select('run_id, question_key, v1, v2')
          .in(
            'run_id',
            runRows.map((r) => r.id),
          )

  const unitsByRun = new Map<string, GoldenUnitView[]>()
  for (const row of unitsResult.data ?? []) {
    const v1 = GoldenV1Schema.safeParse(row.v1)
    const v2 = GoldenV2Schema.safeParse(row.v2)
    const question = byKey.get(row.question_key) ?? null
    const list = unitsByRun.get(row.run_id) ?? []
    list.push({
      question,
      // A key with no code definition: the question was reworded or removed
      // after this run. Surfaced rather than dropped - the answer was still
      // given, and silently hiding it would make an old run look shorter than
      // it was.
      orphanKey: question === null ? row.question_key : null,
      v1: v1.success ? v1.data : null,
      v2: v2.success ? v2.data : null,
      parseError:
        [
          v1.success ? null : `v1: ${v1.error.issues[0]?.message ?? 'invalid'}`,
          v2.success ? null : `v2: ${v2.error.issues[0]?.message ?? 'invalid'}`,
        ]
          .filter((s): s is string => s !== null)
          .join('; ') || null,
    })
    unitsByRun.set(row.run_id, list)
  }

  // Units come back unordered; render them in GOLDEN_QUESTIONS order so two
  // runs read down the page the same way and orphans land at the end.
  const order = new Map(GOLDEN_QUESTIONS.map((q, i) => [q.key, i]))
  const runs: GoldenRunView[] = runRows.map((row) => ({
    id: row.id,
    venueName: row.venues?.name ?? '(deleted venue)',
    gitSha: row.git_sha,
    gitSubject: row.git_subject,
    gitDirty: row.git_dirty,
    v1PromptVersion: row.v1_prompt_version,
    v2PromptVersion: row.v2_prompt_version,
    venueOpenState: row.venue_open_state,
    questionsTotal: row.questions_total,
    fullRun: row.full_run,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    units: (unitsByRun.get(row.id) ?? []).sort(
      (a, b) =>
        (order.get(a.question?.key ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.question?.key ?? '') ?? Number.MAX_SAFE_INTEGER),
    ),
  }))

  // Group by commit, preserving the newest-first run order: the first run of
  // each sha fixes that group's position.
  const groups: CommitGroup[] = []
  for (const run of runs) {
    const existing = groups.find((g) => g.gitSha === run.gitSha)
    if (existing) {
      existing.runs.push(run)
      existing.anyDirty = existing.anyDirty || run.gitDirty
      continue
    }
    groups.push({
      gitSha: run.gitSha,
      gitSubject: run.gitSubject,
      anyDirty: run.gitDirty,
      runs: [run],
    })
  }

  return {
    degraded: null,
    questionCount: GOLDEN_QUESTIONS.length,
    groups,
    hasMoreRuns,
  }
})
