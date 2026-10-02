/**
 * TAC-547 AC 2 — the device case, re-run end to end.
 *
 *   guest: does the badra taste good
 *   agent: ...best with milk to balance it out, as espresso or moka pot...
 *   guest: got it and how should o brew it
 *
 * Runs the REAL classify, retrieve and generate.
 *
 * Two arms, one variable — whether the contextual retrieval arm runs. Context
 * is built ONCE and cloned per rep, because `buildRuntimeContext` can persist
 * a `guest_states` row on a recognition-band change; the run reports that row
 * count before and after. Nothing else is written: no send, no message row,
 * no ledger row.
 */
import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  classifyStage,
  generateStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import { startAgentTrace } from '@/lib/observability/langfuse'
import type { AgentRunId, RuntimeContext } from '@/lib/agent/types'
import type { RecentMessage } from '@/lib/ai/types'
import { classifyBhadraReply, meetsBar } from './knowledge-context-language'
import { createRunLog } from './run-log'

const VENUE_SLUG = 'le-mils-coffee'
const GUEST_ID = '4e280c28-c28d-4532-959c-e0c76e03a2ff'

const PREV_GUEST = 'does the badra taste good'
const AGENT_REPLY =
  "Bhadra's our strongest — 100% Indian Robusta, about twice the caffeine of an Arabica. " +
  'Dark chocolate and tobacco notes. Best with milk to balance it out, as espresso or moka pot.'
const FOLLOW_UP = 'got it and how should o brew it'

export async function runBhadraE2E({ reps }: { reps: number }) {
  const db = createAdminClient()
  const { data: venue, error } = await db
    .from('venues')
    .select('id, slug')
    .eq('slug', VENUE_SLUG)
    .maybeSingle()
  if (error || !venue)
    throw new Error(`venue lookup failed: ${error?.message ?? 'not found'}`)

  const statesBefore = await countGuestStates(db, venue.id)

  const trace = startAgentTrace({
    name: 'tac547-e2e',
    agentRunId: 'tac547',
    metadata: { venueId: venue.id, guestId: GUEST_ID },
  })

  const base = await buildRuntimeContext({
    agentRunId: 'tac547' as AgentRunId,
    guestId: GUEST_ID,
    venueId: venue.id,
    trace,
    currentMessage: {
      // A real uuid that matches no row: build-runtime-context excludes the
      // current inbound with .neq('id', ...) on a uuid column, so a label
      // would be rejected by Postgres.
      id: randomUUID(),
      providerMessageId: 'tac547-synthetic',
      body: FOLLOW_UP,
      receivedAt: new Date(),
      // This guest is Instagram-only (no phone). Setting 'text' left the
      // channel UNRESOLVED, which hands generation the channel-neutral copy
      // instead of what production would use — a second variable on a run
      // that is meant to have one.
      channel: 'instagram',
      referralSource: null,
    },
  })

  const statesAfterBuild = await countGuestStates(db, venue.id)

  // The two prior turns, replacing whatever real history this guest carries,
  // so both arms see exactly the device exchange and nothing else.
  const history: RecentMessage[] = [
    {
      direction: 'inbound',
      body: PREV_GUEST,
      delivery: 'delivered',
      createdAt: new Date(Date.now() - 6 * 60_000),
    },
    {
      direction: 'outbound',
      body: AGENT_REPLY,
      delivery: 'delivered',
      createdAt: new Date(Date.now() - 5 * 60_000),
    },
  ]

  const log = createRunLog({
    name: 'tac547-bhadra-e2e',
    meta: {
      arm: 'control+change',
      venue: venue.slug,
      guestId: GUEST_ID,
      reps,
      followUp: FOLLOW_UP,
    },
  })

  const summary: Record<string, { met: number; ran: number; failed: number }> =
    {}

  for (const arm of ['control', 'change'] as const) {
    summary[arm] = { met: 0, ran: 0, failed: 0 }
    for (let rep = 0; rep < reps; rep += 1) {
      const ctx: RuntimeContext = { ...base, recentMessages: [...history] }
      try {
        ctx.classification = await classifyStage(ctx)
        ctx.corpus = await retrieveCorpusStage(ctx)
        ctx.knowledgeCorpus =
          arm === 'control'
            ? await retrieveKnowledgeStage(
                ctx,
                ctx.classification.category,
                FOLLOW_UP,
              )
            : await retrieveKnowledgeWithContextStage(
                ctx,
                ctx.classification.category,
                FOLLOW_UP,
              )

        const gen = await generateStage(ctx, ctx.classification.category)
        if (gen.status !== 'success') {
          summary[arm].failed += 1
          log.appendUnit({ arm, rep, outcome: gen.status })
          process.stdout.write('!')
          continue
        }
        const verdict = classifyBhadraReply(gen.result.body)
        const met = meetsBar(verdict)
        summary[arm].ran += 1
        if (met) summary[arm].met += 1

        log.appendUnit({
          arm,
          rep,
          body: gen.result.body,
          met,
          verdict,
          retrievedEntries: ctx.knowledgeCorpus.map((c) => ({
            id: c.knowledgeCorpusId,
            similarity: Number(c.similarity.toFixed(4)),
            text: c.text.slice(0, 70),
          })),
        })
        process.stdout.write(met ? '+' : '-')
      } catch (e) {
        summary[arm].failed += 1
        log.appendUnit({
          arm,
          rep,
          error: e instanceof Error ? e.message : String(e),
        })
        process.stdout.write('!')
      }
    }
    process.stdout.write('\n')
  }

  const statesAfter = await countGuestStates(db, venue.id)
  await trace.flushAsync()

  console.log('')
  for (const [arm, s] of Object.entries(summary)) {
    console.log(
      `${arm.padEnd(8)} meets bar ${s.met}/${s.ran}` +
        `${s.failed > 0 ? `  DISQUALIFIED ${s.failed}` : ''}`,
    )
  }
  console.log(
    `\nguest_states rows: before=${statesBefore} afterContextBuild=${statesAfterBuild} after=${statesAfter}`,
  )
  console.log(`run log: ${log.path}`)
}

async function countGuestStates(
  db: ReturnType<typeof createAdminClient>,
  venueId: string,
): Promise<number | null> {
  const { count } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  return count ?? null
}
