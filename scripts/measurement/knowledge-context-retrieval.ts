/**
 * TAC-547 — does retrieving with conversation context find the entry a
 * follow-up is actually about, without losing what a standalone question
 * finds today?
 *
 * READ-ONLY and DETERMINISTIC: Voyage embeds and the match_knowledge_corpus
 * RPC, nothing else. No model calls, no sends, no writes — not even a
 * `guest_states` row, because the arms build a MINIMAL RuntimeContext
 * carrying only `venue.id` (the one field retrieveKnowledgeStage reads)
 * instead of calling buildRuntimeContext, and the conversation context comes
 * from the fixture's own strings. No guest is touched at all.
 *
 * ARMS (`--arms`, comma-separated)
 *   control        — the current message alone. Exactly production today.
 *   ctx1/ctx2/ctx3 — the contextual query at window 1, 2 and 3. When any is
 *                    requested the two merge rules are applied against
 *                    control and both are reported.
 *
 * A failed embed DISQUALIFIES its unit rather than counting as a miss: a
 * broken run must not read as a clean one (CLAUDE.md, measurement harness
 * convention). Failures are counted per arm and printed.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createAdminClient } from '@/lib/db/admin'
import {
  KNOWLEDGE_RELEVANCE_FLOOR,
  KNOWLEDGE_RETRIEVE_LIMIT,
  retrieveKnowledgeStage,
} from '@/lib/agent/stages'
import {
  mergeKnowledgeMatches,
  type MergeRule,
} from '@/lib/agent/retrieval-context'
import type { MessageCategory } from '@/lib/ai/types'
import type { KnowledgeMatch, RuntimeContext } from '@/lib/agent/types'
import { createRunLog } from './run-log'
import { runBhadraE2E } from './knowledge-context-e2e'

const VENUE_SLUG = 'le-mils-coffee'

export type Fixture = {
  id: string
  kind?: string
  prevGuest: string
  agentReply: string
  followUp: string
  target: string
  category: MessageCategory | null
}

type ArmResult = { ids: string[]; scores: number[] } | { failed: string }

/** The one field retrieveKnowledgeStage reads. Everything else stays absent. */
function minimalCtx(venueId: string): RuntimeContext {
  return { venue: { id: venueId } } as unknown as RuntimeContext
}

/**
 * The contextual query, built from the fixture's strings rather than from
 * ctx.recentMessages, so this needs no guest and writes nothing. The SHAPE
 * matches lib/agent/retrieval-context.ts's builder: the last `window` turns
 * that reached the guest, chronological, current message last,
 * newline-joined. A fixture carries exactly two prior turns, so window 3 is
 * necessarily equal to window 2 here — reported as such, and ctx1 differing
 * from ctx2 is the check that the window parameter is wired at all.
 */
export function contextQuery(f: Fixture, window: number): string {
  return [...[f.prevGuest, f.agentReply].slice(-window), f.followUp].join('\n')
}

function queryForArm(f: Fixture, arm: string): string {
  return arm === 'control' ? f.followUp : contextQuery(f, Number(arm.slice(3)))
}

async function runArm(
  venueId: string,
  f: Fixture,
  arm: string,
): Promise<{ result: ArmResult; rows: KnowledgeMatch[] }> {
  try {
    const rows = await retrieveKnowledgeStage(
      minimalCtx(venueId),
      f.category,
      queryForArm(f, arm),
    )
    return {
      rows,
      result: {
        ids: rows.map((r) => r.knowledgeCorpusId),
        scores: rows.map((r) => Number(r.similarity.toFixed(4))),
      },
    }
  } catch (e) {
    return {
      rows: [],
      result: { failed: e instanceof Error ? e.message : String(e) },
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const mode = readFlag(args, '--mode') ?? 'retrieval'
  const arms = (readFlag(args, '--arms') ?? 'control')
    .split(',')
    .map((a) => a.trim())

  if (mode === 'e2e') {
    await runBhadraE2E({ reps: Number(readFlag(args, '--reps') ?? '10') })
    return
  }
  if (mode !== 'retrieval') throw new Error(`unknown --mode ${mode}`)

  const db = createAdminClient()
  const { data: venue, error: venueErr } = await db
    .from('venues')
    .select('id, slug')
    .eq('slug', VENUE_SLUG)
    .maybeSingle()
  if (venueErr || !venue)
    throw new Error(`venue lookup failed: ${venueErr?.message ?? 'not found'}`)

  const raw = JSON.parse(
    readFileSync(
      resolve(__dirname, 'fixtures/knowledge-context-retrieval.json'),
      'utf8',
    ),
  ) as { followUps: Fixture[]; standalone: Fixture[] }

  const log = createRunLog({
    name: 'tac547-knowledge-context-retrieval',
    meta: {
      arm: arms.join('+'),
      venue: venue.slug,
      venueId: venue.id,
      knowledgeRetrieveLimit: KNOWLEDGE_RETRIEVE_LIMIT,
      fixtureCounts: {
        followUps: raw.followUps.length,
        standalone: raw.standalone.length,
      },
    },
  })

  const tally: Record<string, { hit: number; total: number; failed: number }> =
    {}
  const bump = (key: string, hit: boolean, failed: boolean) => {
    tally[key] ??= { hit: 0, total: 0, failed: 0 }
    if (failed) tally[key].failed += 1
    else {
      tally[key].total += 1
      if (hit) tally[key].hit += 1
    }
  }

  for (const [population, rows] of [
    ['followUp', raw.followUps],
    ['standalone', raw.standalone],
  ] as const) {
    for (const f of rows) {
      const perArm: Record<string, ArmResult> = {}
      const rowsByArm: Record<string, KnowledgeMatch[]> = {}
      for (const arm of arms) {
        const { result, rows } = await runArm(venue.id, f, arm)
        perArm[arm] = result
        rowsByArm[arm] = rows
        const failed = 'failed' in result
        bump(
          `${population}:${arm}`,
          !failed && result.ids.includes(f.target),
          failed,
        )
      }

      // Merge every context arm against control, under both rules. A unit
      // whose control or context arm failed is disqualified rather than
      // merged from a half-empty input.
      const merged: Record<string, { ids: string[]; lostVsControl: string[] }> =
        {}
      const controlOk =
        perArm.control !== undefined && !('failed' in perArm.control)
      for (const arm of arms.filter((a) => a !== 'control')) {
        const armOk = perArm[arm] !== undefined && !('failed' in perArm[arm])
        for (const rule of [
          'best-score',
          'interleave',
        ] as const satisfies readonly MergeRule[]) {
          const key = `${arm}:${rule}`
          if (!controlOk || !armOk) {
            bump(`${population}:${key}`, false, true)
            continue
          }
          const out = mergeKnowledgeMatches(
            [rowsByArm.control, rowsByArm[arm]],
            {
              rule,
              limit: KNOWLEDGE_RETRIEVE_LIMIT,
              floor: KNOWLEDGE_RELEVANCE_FLOOR,
            },
          )
          const ids = out.map((r) => r.knowledgeCorpusId)
          const controlIds = (perArm.control as { ids: string[] }).ids
          merged[key] = {
            ids,
            lostVsControl: controlIds.filter((c) => !ids.includes(c)),
          }
          bump(`${population}:${key}`, ids.includes(f.target), false)
        }
      }

      // The voice probe that lived here (evidence for TAC-547's "leave voice
      // retrieval alone") was removed with the mechanism it observed: voice is
      // a static pack (decision 0008), so there is no per-query voice
      // similarity left to measure.
      log.appendUnit({
        population,
        fixture: f.id,
        kind: f.kind ?? null,
        target: f.target,
        followUp: f.followUp,
        queries: Object.fromEntries(arms.map((a) => [a, queryForArm(f, a)])),
        perArm,
        merged,
        targetRank: Object.fromEntries(
          arms.map((a) => {
            const r = perArm[a]
            return [a, 'failed' in r ? null : r.ids.indexOf(f.target)]
          }),
        ),
      })
      process.stdout.write('.')
    }
  }

  process.stdout.write('\n\n')
  for (const [key, t] of Object.entries(tally)) {
    console.log(
      `${key.padEnd(24)} hit ${t.hit}/${t.total}${t.failed > 0 ? `  DISQUALIFIED ${t.failed}` : ''}`,
    )
  }
  console.log(`\nrun log: ${log.path}`)
}

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
