import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'
import { GoldenV1Schema, type GoldenV1 } from '@/lib/schemas/golden'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'

// Loader for /admin/prompt-lab's v1 column. One loader per surface,
// cache()-wrapped, same posture as tests/golden's.
//
// THE WHOLE POINT IS THAT v1 IS NOT CALLED. A v1 arm is a second full
// generation per question - classify, embed, generate - so a 62-question sweep
// that ran both engines would double the spend to re-derive answers that are
// already on disk. v1 moves slowly and the questions are fixed, so the last
// stored answer is the useful one.
//
// WHAT THAT COSTS, and it is rendered rather than left in this comment: the
// stored answer was generated at whatever `PROMPT_VERSION` was current when
// the harness ran. At the time of writing the newest full run is v1.105.0 and
// v1 ships v1.107.0, so the column is a SNAPSHOT and two versions stale. A
// surface that showed it as "v1" flat would be claiming a comparison against
// today's v1 that nobody made. `promptVersion` and `capturedAt` ride every
// cell for exactly that reason.
//
// NEWEST WINS PER QUESTION, not per run. A partial run (`--questions=`) covers
// a handful, so taking the newest RUN would throw away 58 good answers to
// honour a 4-question iteration. Per question, each cell is the freshest real
// answer that exists.
//
// Degrade, do not 500 (app/admin/CLAUDE.md): a missing table or a malformed
// row yields a labelled gap, never an empty column that reads as "v1 said
// nothing".

export interface StoredV1Cell {
  v1: GoldenV1
  /** `PROMPT_VERSION` when this was generated - NOT necessarily today's. */
  promptVersion: string
  /** When the run that produced it started, ISO. */
  capturedAt: string
  gitSha: string | null
}

export interface StoredV1Index {
  /** Keyed by `GOLDEN_QUESTIONS[].key`. Absent means never run, not empty. */
  cells: Record<string, StoredV1Cell>
  /** Rendered as a banner. Null when the read was clean. */
  error: string | null
  /**
   * Distinct `PROMPT_VERSION`s across the cells, newest-first by capture.
   * MORE THAN ONE IS NORMAL and is why this is a list rather than a field: the
   * cells come from different runs, so the column can be a mix of versions and
   * the header has to be able to say so instead of naming one.
   */
  promptVersions: string[]
  newestCapturedAt: string | null
  /**
   * What v1 ships TODAY, read from the code rather than from a run.
   *
   * Here so the header can say the column is behind instead of only naming the
   * version it came from. The gap is invisible otherwise and it is the whole
   * caveat: a stored `v1.106.0` answer beside a live v2 one reads as "v1 says
   * this", and the two `--skip-v1` runs at v1.107.0 mean there is no stored
   * answer at the shipping version at all.
   */
  livePromptVersion: string
}

/** Exported so the page's no-venue branch cannot drift from this shape. */
export const EMPTY_STORED_V1: StoredV1Index = {
  cells: {},
  error: null,
  promptVersions: [],
  newestCapturedAt: null,
  livePromptVersion: PROMPT_VERSION,
}

/** Rows to scan. 20 full runs is ~1,240 units - well inside one select. */
const RUN_LIMIT = 40

export const loadStoredV1 = cache(
  async (venueId: string): Promise<StoredV1Index> => {
    const db = createAdminClient()
    const runs = await db
      .from('golden_runs')
      .select('id, started_at, git_sha')
      .eq('venue_id', venueId)
      .order('started_at', { ascending: false })
      .limit(RUN_LIMIT)
    if (runs.error)
      return {
        ...EMPTY_STORED_V1,
        error: `could not read golden_runs: ${runs.error.message}`,
      }
    if (runs.data.length === 0) return EMPTY_STORED_V1

    const units = await db
      .from('golden_run_units')
      .select('run_id, question_key, v1')
      .in(
        'run_id',
        runs.data.map((r) => r.id),
      )
    if (units.error)
      return {
        ...EMPTY_STORED_V1,
        error: `could not read golden_run_units: ${units.error.message}`,
      }

    const runById = new Map(runs.data.map((r) => [r.id, r]))
    const cells: Record<string, StoredV1Cell> = {}
    let parseFailures = 0

    // Runs come newest-first, so the first acceptable cell per question wins
    // and later (older) ones are skipped.
    const ordered = [...units.data].sort((a, b) => {
      const at = runById.get(a.run_id)?.started_at ?? ''
      const bt = runById.get(b.run_id)?.started_at ?? ''
      return bt.localeCompare(at)
    })

    for (const unit of ordered) {
      if (cells[unit.question_key] !== undefined) continue
      const parsed = GoldenV1Schema.safeParse(unit.v1)
      if (!parsed.success) {
        parseFailures += 1
        continue
      }
      // A `not_run` cell is the harness declining to ask, which on the v1 side
      // means the run was `--skip-v1`. It is NOT an answer, so it must not
      // occupy the slot and hide a real answer from an older run underneath.
      if (!parsed.data.ok && parsed.data.kind === 'not_run') continue
      const run = runById.get(unit.run_id)
      cells[unit.question_key] = {
        v1: parsed.data,
        promptVersion: parsed.data.ok ? parsed.data.promptVersion : 'unknown',
        capturedAt: run?.started_at ?? '',
        gitSha: run?.git_sha ?? null,
      }
    }

    const entries = Object.values(cells).sort((a, b) =>
      b.capturedAt.localeCompare(a.capturedAt),
    )
    return {
      cells,
      error:
        parseFailures === 0
          ? null
          : `${parseFailures} stored v1 answer${parseFailures === 1 ? '' : 's'} failed schema parse and ${parseFailures === 1 ? 'was' : 'were'} skipped`,
      // 'unknown' is excluded: it is what a FAILED v1 arm stores (a failure
      // carries no prompt version), and listing it beside real versions in the
      // header reads as a third version the column was generated at.
      promptVersions: [
        ...new Set(
          entries.map((e) => e.promptVersion).filter((v) => v !== 'unknown'),
        ),
      ],
      newestCapturedAt: entries[0]?.capturedAt ?? null,
      livePromptVersion: PROMPT_VERSION,
    }
  },
)
