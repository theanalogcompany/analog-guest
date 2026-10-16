import { cache } from 'react'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { resolveV2ModelProfile } from '@/lib/ai/v2/model-call'
import { V2_PROMPT_VERSION } from '@/lib/ai/v2/template'
import { createAdminClient } from '@/lib/db/admin'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-set'
import { humanEvalExcluded, humanEvalQuestions } from '@/lib/eval/human-eval'
import { mark } from '../../../_lib/request-timing'
import {
  HUMAN_EVAL_UNIT_COLUMNS,
  sortUnitsByQuestionOrder,
  unitViewFromRow,
  type HumanEvalUnitRow,
} from './map-unit'
import type {
  HumanEvalPageData,
  HumanEvalSessionSummary,
  HumanEvalSessionView,
} from './types'

// Loader for /admin/tests/human-eval. One loader per surface, cache()-wrapped.
//
// The QUESTIONS are not loaded - they are GOLDEN_QUESTIONS in
// lib/eval/golden-set.ts - so the half of this page that says what a pass
// covers cannot degrade and cannot disagree with what was generated. Only the
// pass itself reads the database.
//
// Degrade, do not 500: before migration 083 is applied the select fails with
// "relation does not exist", which renders as a banner naming the migration.
// Never as an empty page - an unlabelled empty list reads as "nobody has ever
// run a pass", a false absolute claim.

export const SESSIONS_LIMIT = 20

/**
 * What about a pass's stamped code state no longer matches the code reading
 * it, as a sentence, or null when it all matches.
 *
 * THE SAME THREE STAMPS THE SESSIONS ROUTE WRITES, compared against the same
 * three sources it wrote them from - so "current" here and "current" at
 * creation cannot drift apart. The model counts alongside the two prompt
 * versions: answers from Sonnet 4.6 are no more evidence about Sonnet 5.5
 * than v2.18's are about v2.21.
 *
 * NOT the venue's open state, which also rides the pass and also changes what
 * was generated. That one is a fact about the clock rather than about the
 * code, it flips back and forth all day, and treating it as staleness would
 * mean a pass taken this morning goes stale at closing time and un-stales
 * tomorrow. It stays on the provenance line, where a reader can weigh it.
 */
export function passStaleness(pass: {
  v1_prompt_version: string
  v2_prompt_version: string
  v2_model: string
}): string | null {
  const current = {
    v1: PROMPT_VERSION,
    v2: V2_PROMPT_VERSION,
    model: resolveV2ModelProfile().id,
  }
  const drift: string[] = []
  if (pass.v1_prompt_version !== current.v1)
    drift.push(`v1 ${pass.v1_prompt_version}, now ${current.v1}`)
  if (pass.v2_prompt_version !== current.v2)
    drift.push(`v2 ${pass.v2_prompt_version}, now ${current.v2}`)
  if (pass.v2_model !== current.model)
    drift.push(`${pass.v2_model}, now ${current.model}`)
  return drift.length === 0 ? null : drift.join(' · ')
}

export const EMPTY_HUMAN_EVAL: HumanEvalPageData = {
  degraded: null,
  questionCount: GOLDEN_QUESTIONS.length,
  judgeableCount: humanEvalQuestions().length,
  excluded: humanEvalExcluded(),
  sessions: [],
  session: null,
  hasMoreSessions: false,
}

/**
 * Every pass for this venue, plus one in full - the newest, or whichever
 * `?session=` names.
 *
 * The unit rows come back on the SELECTED session only. A pass is up to 58
 * question/answer pairs with two replies each, and loading every stored pass
 * in full would put a megabyte of replies through the page to render one.
 */
export const loadHumanEvalPage = cache(
  async (
    venueId: string,
    requestedSessionId: string | null,
  ): Promise<HumanEvalPageData> => {
    const supabase = createAdminClient()
    const base = { ...EMPTY_HUMAN_EVAL }

    // Newest-first window + LIMIT+1, so the page can state the cap honestly:
    // comparing rows.length to the cap cannot tell exactly-N from
    // more-than-N (app/admin/CLAUDE.md).
    const sessionsResult = await supabase
      .from('human_eval_sessions')
      .select(
        'id, venue_id, rated_by, v1_prompt_version, v2_prompt_version, v2_model, venue_open_state, git_sha, started_at, submitted_at, venues(name)',
      )
      .eq('venue_id', venueId)
      .order('started_at', { ascending: false })
      .limit(SESSIONS_LIMIT + 1)
    mark('sessions')
    if (sessionsResult.error)
      return {
        ...base,
        degraded: `human_eval_sessions unreadable (${sessionsResult.error.message}) - has migration 083 been applied?`,
      }

    const rows = sessionsResult.data ?? []
    const windowed = rows.slice(0, SESSIONS_LIMIT)
    const hasMoreSessions = rows.length > SESSIONS_LIMIT
    if (windowed.length === 0) return { ...base, hasMoreSessions: false }

    // Scoped against the loaded list rather than trusted: `?session=` is a URL
    // parameter, and this query is what applied the venue scope. An id naming
    // another venue's pass falls back rather than 404ing, the same posture
    // `?venue=` has on the prompt lab.
    //
    // WHAT THE PAGE OPENS ON IS THE NEWEST PASS GENERATED UNDER THE CURRENT
    // CODE, not the newest pass. Those were the same thing until the engine
    // moved on, and then the page handed a rater 58 rows generated three
    // prompt revisions ago with nothing on screen distinguishing them from
    // fresh ones - an hour of judging that is not evidence about the engine
    // being shipped. The versions were already stamped on the pass for exactly
    // this reason; nothing had ever compared them.
    //
    // NULL IS A VALID ANSWER AND IS NOT A DEGRADED ONE. A venue whose every
    // pass is stale opens on the empty state, where the only control is the
    // one that generates - which is the honest reading of "there is nothing
    // here worth judging yet".
    //
    // An explicit `?session=` still wins, stale or not: the picker lists every
    // pass, a submitted one is the only route to its CSV, and asking for one
    // by id is a deliberate act. It arrives carrying `stale`, and the page
    // says so.
    const requested =
      requestedSessionId === null
        ? undefined
        : windowed.find((s) => s.id === requestedSessionId)
    const selected =
      requested ?? windowed.find((s) => passStaleness(s) === null) ?? null

    // Counts for the picker. One query over the window rather than per
    // session, and only the three columns a count needs - 20 passes of 58
    // rows is 1,160 of them, and the replies are the expensive part.
    //
    // BEFORE the selection is acted on, because the picker is rendered even
    // when nothing is selected - every pass being stale is exactly that case,
    // and a picker reporting "0/0 judged" for passes that have rows would be
    // the page lying about the one thing the picker is for.
    //
    // JUDGED MEANS BOTH VERDICTS, not `judged_at is not null`: that instant is
    // stamped by the first verdict on a row, so counting it would report a row
    // with one reply marked and the other untouched as done, and a pass would
    // read as finished while half of every comparison was missing.
    const countsResult = await supabase
      .from('human_eval_units')
      .select('session_id, a_verdict, b_verdict')
      .in(
        'session_id',
        windowed.map((s) => s.id),
      )
    mark('counts')
    if (countsResult.error)
      return {
        ...base,
        degraded: `human_eval_units unreadable (${countsResult.error.message}) - has migration 083 been applied?`,
      }
    const generated = new Map<string, number>()
    const judged = new Map<string, number>()
    for (const row of countsResult.data ?? []) {
      generated.set(row.session_id, (generated.get(row.session_id) ?? 0) + 1)
      if (row.a_verdict !== null && row.b_verdict !== null)
        judged.set(row.session_id, (judged.get(row.session_id) ?? 0) + 1)
    }

    const sessions: HumanEvalSessionSummary[] = windowed.map((s) => ({
      id: s.id,
      startedAt: s.started_at,
      venueOpenState: s.venue_open_state,
      v2Model: s.v2_model,
      generated: generated.get(s.id) ?? 0,
      judged: judged.get(s.id) ?? 0,
      submittedAt: s.submitted_at,
      stale: passStaleness(s) !== null,
    }))

    // Every pass this venue has is stale, so there is nothing current to open
    // on. The picker still lists them all and the empty state invites a new
    // pass - what does NOT happen is old answers arriving on screen looking
    // like something to judge.
    if (selected === null) return { ...base, sessions, hasMoreSessions }

    const unitsResult = await supabase
      .from('human_eval_units')
      .select(HUMAN_EVAL_UNIT_COLUMNS)
      .eq('session_id', selected.id)
    mark('units')
    if (unitsResult.error)
      return {
        ...base,
        degraded: `human_eval_units unreadable (${unitsResult.error.message}) - has migration 083 been applied?`,
      }

    // Rendered in GOLDEN_QUESTIONS order so two passes read down the page the
    // same way, with orphans last.
    const units = sortUnitsByQuestionOrder(
      (unitsResult.data as HumanEvalUnitRow[]).map(unitViewFromRow),
    )

    const session: HumanEvalSessionView = {
      id: selected.id,
      venueId: selected.venue_id,
      venueName: selected.venues?.name ?? '(deleted venue)',
      ratedBy: selected.rated_by,
      v1PromptVersion: selected.v1_prompt_version,
      v2PromptVersion: selected.v2_prompt_version,
      v2Model: selected.v2_model,
      venueOpenState: selected.venue_open_state,
      gitSha: selected.git_sha,
      startedAt: selected.started_at,
      submittedAt: selected.submitted_at,
      // Non-null only on a pass that was asked for by id - the fallback above
      // cannot select a stale one.
      stale: passStaleness(selected),
      units,
    }

    return { ...base, sessions, session, hasMoreSessions }
  },
)
