// Post-PR-#304 generation-pipeline measurement: replay real inbound turns
// through the real reply path, timing each stage, then run the five
// post-generation checks OFF the clock and record their verdicts.
//
// The two questions this answers, per the 2026-09-30 request:
//   1. p50/p90 reply-path latency after the latency work (Jev classify,
//      static voice pack, checks post-send) — per stage, so each change is
//      attributable.
//   2. do generated replies still pass the verifiers — the five checks run
//      exactly as post-send-checks.ts runs them, just without the event
//      capture layer, and their verdict rates are compared against the
//      pre-change production baseline as PRE-REGISTERED CEILINGS
//      (generation-latency-pure.ts), evaluated in code.
//
// REPLAY, not reproduction. Turns are the venue's most recent real inbound
// messages (TAC-519 pattern), re-dated to now: `## Right now` reflects the
// run moment, and the conversation history already contains production's
// own answer to the replayed message, so the model sees a repeat question.
// Fine for latency (the time is model round trips); recorded in the run-log
// meta because it can nudge fidelity and verifier rates. The venue clock
// state is recorded PER UNIT (convention rule 10 — a held-fixed variable is
// an instrument too), and verifier ceilings are only meaningful like-for-like
// against the open-state production baseline.
//
// Matches production where the older harnesses have drifted: knowledge
// retrieval uses the two-arm retrieveKnowledgeWithContextStage (TAC-547),
// and the gate call is handle-inbound.ts's post-decision-0003 shape — the
// neutral literals plus the live cancellation resolution.
//
// WRITES: none on the reply path (decision-only gate, no dispatch, no
// persist). Two known side channels, both recorded: buildRuntimeContext's
// computeGuestState can persist a guest_states row on a band change (the
// harness counts the venue's rows before and after and prints the delta —
// a hand check, same as TAC-519's), and the stages' own PostHog/Langfuse
// emission runs as it does for every measurement harness. Traces land as
// `measurement.generation-latency`, joining no `agent.*` percentile.

import { randomUUID } from 'node:crypto'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  applyApprovalPolicyStage,
  classifyStage,
  generateStage,
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
  verifyCancellationClaimStage,
  verifyClosedVenueArrivalStage,
  verifyMechanicOfferStage,
  verifyProsePromiseStage,
} from '@/lib/agent/stages'
import { resolveVenueOpenState } from '@/lib/agent/venue-open-state'
import {
  CLASSIFY_JEV_PROMPT_VERSION,
  JEV_CLASSIFICATION_ENABLED,
} from '@/lib/ai/classify-message-jev'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { resolveCancellation } from '@/lib/schemas/guest-commitment'
import { parseMessageChannel } from '@/lib/schemas/message-channel'

import {
  evaluateCeilings,
  PRE_CHANGE_BASELINE,
  STAGE_FIELDS,
  summarize,
  VERIFIER_FIELDS,
  type HarnessUnit,
} from './generation-latency-pure'
import { createRunLog } from './run-log'

const DEFAULT_LIMIT = 30

function parseArgs(argv: readonly string[]): { venue?: string; limit: number } {
  const out: { venue?: string; limit: number } = { limit: DEFAULT_LIMIT }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--venue') out.venue = argv[++i]
    else if (argv[i] === '--limit') out.limit = Number(argv[++i])
  }
  return out
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = performance.now()
  const value = await fn()
  return { value, ms: Math.round(performance.now() - start) }
}

async function countGuestStates(
  supabase: ReturnType<typeof createAdminClient>,
  venueId: string,
): Promise<number | null> {
  const { count, error } = await supabase
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  if (error) {
    console.warn(`guest_states count unavailable: ${error.message}`)
    return null
  }
  return count
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.venue || !Number.isInteger(args.limit) || args.limit < 1) {
    console.error(
      '✗ usage: tsx scripts/measurement/generation-latency.ts --venue <slug> [--limit N]',
    )
    process.exit(2)
  }

  const supabase = createAdminClient()
  const { data: venue } = await supabase
    .from('venues')
    .select('id, slug')
    .eq('slug', args.venue)
    .maybeSingle()
  if (!venue) {
    console.error(`✗ venue ${args.venue} not found`)
    process.exit(1)
  }

  // Selection: the venue's most recent real inbound turns. Over-fetch, then
  // drop empty bodies (media/reactions — no prompt to build) and demo guests
  // (every verifier skips isDemo, so a demo unit measures nothing). Skips are
  // reported, never silently dropped.
  const { data: inboundRows, error: selErr } = await supabase
    .from('messages')
    .select(
      'id, guest_id, body, channel, provider_message_id, referral_source, created_at',
    )
    .eq('venue_id', venue.id)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(args.limit * 3)
  if (selErr) {
    console.error(`✗ inbound select failed: ${selErr.message}`)
    process.exit(1)
  }

  const nonEmpty = (inboundRows ?? []).filter((r) => r.body.trim().length > 0)
  const emptySkipped = (inboundRows ?? []).length - nonEmpty.length

  const guestIds = [...new Set(nonEmpty.map((r) => r.guest_id))]
  const { data: guests, error: guestErr } = await supabase
    .from('guests')
    .select('id, is_demo')
    .in('id', guestIds)
  if (guestErr) {
    console.error(`✗ guest select failed: ${guestErr.message}`)
    process.exit(1)
  }
  const demoGuestIds = new Set(
    (guests ?? []).filter((g) => g.is_demo === true).map((g) => g.id),
  )
  const eligible = nonEmpty.filter((r) => !demoGuestIds.has(r.guest_id))
  const demoSkipped = nonEmpty.length - eligible.length
  const turns = eligible.slice(0, args.limit)

  if (turns.length === 0) {
    console.error('✗ no replayable inbound turns found')
    process.exit(1)
  }

  const guestStatesBefore = await countGuestStates(supabase, venue.id)

  const log = createRunLog({
    name: 'generation-latency',
    meta: {
      arm: 'post-pr304-replay-local',
      question:
        'reply-path p50/p90 per stage after the latency work, and do replies still pass the five verifiers',
      venue: venue.slug,
      promptVersion: PROMPT_VERSION,
      jevEnabled: JEV_CLASSIFICATION_ENABLED,
      jevPromptVersion: CLASSIFY_JEV_PROMPT_VERSION,
      requested: args.limit,
      replayed: turns.length,
      skipped: { emptyBody: emptySkipped, demoGuest: demoSkipped },
      serial: true,
      baseline: PRE_CHANGE_BASELINE,
      baselineWindow:
        '2026-09-23T05:50:05Z..2026-09-30T05:50:05Z (production, pre-merge)',
      note:
        'replay re-dated to now; history contains the production answer to each replayed message. ' +
        'Latency unaffected; fidelity/verifier rates carry that caveat. Local machine, not Vercel.',
    },
  })
  console.log(`run log: ${log.path}`)
  console.log(
    `${turns.length} turns (requested ${args.limit}; skipped ${emptySkipped} empty, ${demoSkipped} demo)\n`,
  )

  const units: HarnessUnit[] = []

  for (const [i, turn] of turns.entries()) {
    const agentRunId = randomUUID()
    const trace = startAgentTrace({
      name: 'measurement.generation-latency',
      agentRunId,
      metadata: { venueId: venue.id, guestId: turn.guest_id },
    })

    const base: HarnessUnit = {
      outcome: 'failed',
      openState: 'unknown',
      inboundId: turn.id,
      guestId: turn.guest_id,
      originalCreatedAt: turn.created_at,
      channel: turn.channel,
    }

    try {
      const contextBuild = await timed(() =>
        buildRuntimeContext({
          agentRunId,
          guestId: turn.guest_id,
          venueId: venue.id,
          trace,
          currentMessage: {
            id: randomUUID(),
            providerMessageId: `replay-${turn.id}`,
            body: turn.body,
            receivedAt: new Date(),
            channel: parseMessageChannel(turn.channel) ?? 'text',
            referralSource: turn.referral_source,
          },
        }),
      )
      const ctx = contextBuild.value
      base.contextBuildMs = contextBuild.ms
      base.openState = resolveVenueOpenState(ctx.venue, new Date()).state

      const classify = await timed(() => classifyStage(ctx))
      ctx.classification = classify.value
      base.classifyMs = classify.ms
      base.classifierModelId = classify.value.modelId
      base.category = classify.value.category

      if (classify.value.crisisSafety) {
        // Production short-circuits to a fixed reply before any retrieval or
        // generation (TAC-348), so there is nothing downstream to measure.
        base.outcome = 'crisis_short_circuit'
        units.push(base)
        log.appendUnit(base)
        console.log(
          `· ${i + 1}/${turns.length} crisis short-circuit (${turn.id.slice(0, 8)})`,
        )
        continue
      }

      const voice = await timed(() => retrieveCorpusStage(ctx))
      ctx.corpus = voice.value
      base.retrieveVoiceMs = voice.ms

      const knowledge = await timed(() =>
        retrieveKnowledgeWithContextStage(
          ctx,
          classify.value.category,
          turn.body,
        ),
      )
      ctx.knowledgeCorpus = knowledge.value
      base.retrieveKnowledgeMs = knowledge.ms

      const generate = await timed(() =>
        generateStage(ctx, classify.value.category),
      )
      base.generateMs = generate.ms

      if (generate.value.status === 'failed') {
        base.outcome = 'failed'
        base.errorMessage = generate.value.error
        units.push(base)
        log.appendUnit(base)
        console.log(
          `✗ ${i + 1}/${turns.length} generate failed: ${generate.value.error}`,
        )
        continue
      }
      if (generate.value.status === 'refused') {
        base.outcome = 'refused'
        base.attemptCount = generate.value.attemptScores.length
        base.attemptScores = generate.value.attemptScores
        base.finalScore = generate.value.finalScore
        units.push(base)
        log.appendUnit(base)
        console.log(
          `✗ ${i + 1}/${turns.length} REFUSED at fidelity ${generate.value.finalScore.toFixed(2)}`,
        )
        continue
      }

      const result = generate.value.result
      base.attemptCount = result.attemptScores.length
      base.attemptScores = result.attemptScores
      base.voiceFidelity = result.voiceFidelity
      base.replyBody = result.body

      // The gate as handle-inbound.ts calls it since decision 0003's rewrite:
      // neutral literals for the deferred checks, the LIVE cancellation
      // resolution computed inline. Decision-only — nothing persists.
      const gate = await timed(() =>
        applyApprovalPolicyStage(
          ctx,
          result,
          { status: 'skipped' },
          { status: 'skipped' },
          {
            resolution: resolveCancellation(
              result.cancelsCommitmentId,
              ctx.activeCommitments,
            ),
            claim: 'skipped',
          },
          { status: 'skipped' },
        ),
      )
      base.gateMs = gate.ms
      base.approvalAction = gate.value.action
      if (gate.value.action === 'queue') {
        base.primaryTrigger = gate.value.primaryTrigger
        base.triggers = gate.value.triggers
      }

      base.replyPathMs =
        contextBuild.ms +
        classify.ms +
        voice.ms +
        knowledge.ms +
        generate.ms +
        gate.ms

      // The four checks, concurrently as post-send-checks.ts runs them, off
      // the reply-path clock. A rejection here is a unit FAILURE (rule 5),
      // not a silent 'ran clean' — the stages themselves fail closed with
      // status values, so a rejection is something genuinely broken.
      const verifiersStart = performance.now()
      const [
        mechanicOffer,
        prosePromise,
        cancellationClaim,
        closedVenueArrival,
      ] = await Promise.allSettled([
        timed(() => verifyMechanicOfferStage(ctx, result)),
        timed(() => verifyProsePromiseStage(ctx, result)),
        timed(() => verifyCancellationClaimStage(ctx, result)),
        timed(() => verifyClosedVenueArrivalStage(ctx, result)),
      ])
      base.verifierBlockMs = Math.round(performance.now() - verifiersStart)

      const rejections: string[] = []
      const record = (
        field: (typeof VERIFIER_FIELDS)[number],
        settled: PromiseSettledResult<{ value: unknown; ms: number }>,
        status: (value: never) => string,
      ) => {
        if (settled.status === 'rejected') {
          rejections.push(`${field}: ${String(settled.reason)}`)
          return
        }
        base[field] = status(settled.value.value as never)
        base[`${field}Ms`] = settled.value.ms
      }
      record(
        'mechanicOffer',
        mechanicOffer,
        (r: { status: string }) => r.status,
      )
      record('prosePromise', prosePromise, (r: { status: string }) => r.status)
      record(
        'cancellationClaim',
        cancellationClaim,
        (r: { claim: string }) => r.claim,
      )
      record(
        'closedVenueArrival',
        closedVenueArrival,
        (r: { status: string }) => r.status,
      )

      if (rejections.length > 0) {
        base.outcome = 'failed'
        base.errorMessage = `verifier rejected: ${rejections.join('; ')}`
      } else {
        base.outcome = 'ok'
      }

      units.push(base)
      log.appendUnit(base)
      const flags = VERIFIER_FIELDS.filter((f) => base[f] === 'flagged')
      console.log(
        `${base.outcome === 'ok' ? '·' : '✗'} ${i + 1}/${turns.length} ` +
          `reply ${base.replyPathMs}ms (gen ${generate.ms}ms) ` +
          `fidelity ${result.voiceFidelity.toFixed(2)} ${String(base.approvalAction)}` +
          `${flags.length > 0 ? ` FLAGGED[${flags.join(',')}]` : ''}`,
      )
    } catch (e: unknown) {
      base.outcome = 'failed'
      base.errorMessage = e instanceof Error ? e.message : String(e)
      units.push(base)
      log.appendUnit(base)
      console.log(`✗ ${i + 1}/${turns.length} failed: ${base.errorMessage}`)
    } finally {
      await trace.flushAsync()
    }
  }

  const guestStatesAfter = await countGuestStates(supabase, venue.id)
  const summary = summarize(units)
  const ceilings = evaluateCeilings(summary)
  log.appendUnit({
    __summary__: true,
    summary,
    ceilings,
    guestStatesBefore,
    guestStatesAfter,
  })

  console.log(
    '\n=== stage latency (ms) — this run vs pre-change production p50 ===',
  )
  const baselineByStage: Partial<
    Record<(typeof STAGE_FIELDS)[number], number>
  > = {
    classifyMs: PRE_CHANGE_BASELINE.classifyP50Ms,
    retrieveVoiceMs: PRE_CHANGE_BASELINE.retrieveVoiceP50Ms,
    retrieveKnowledgeMs: PRE_CHANGE_BASELINE.retrieveKnowledgeP50Ms,
    generateMs: PRE_CHANGE_BASELINE.generateP50Ms,
  }
  for (const field of STAGE_FIELDS) {
    const s = summary.stages[field]
    const baseline = baselineByStage[field]
    console.log(
      `${field.padEnd(20)} n=${String(s.n).padStart(3)}  p50=${fmt(s.p50)}  p90=${fmt(s.p90)}` +
        `${baseline !== undefined ? `  (was p50 ${baseline})` : ''}`,
    )
  }

  console.log('\n=== verifier verdicts ===')
  for (const field of VERIFIER_FIELDS) {
    const v = summary.verifiers[field]
    console.log(`${field.padEnd(20)} ${JSON.stringify(v.counts)}`)
  }
  console.log(`\noutcomes: ${JSON.stringify(summary.outcomes)}`)
  console.log(
    `regen: ${summary.regen.regenerated}/${summary.regen.generations}`,
  )
  console.log(`venue clock states: ${JSON.stringify(summary.openStates)}`)
  console.log(
    `guest_states rows: before=${String(guestStatesBefore)} after=${String(guestStatesAfter)}` +
      (guestStatesBefore !== guestStatesAfter
        ? '  ← CHANGED, note in report'
        : ''),
  )

  console.log('\n=== pre-registered ceilings ===')
  for (const v of ceilings.verdicts) {
    console.log(
      `${v.pass ? 'PASS' : 'FAIL'}  ${v.name}: ${v.actual} (limit ${v.limit})`,
    )
  }
  if (ceilings.disqualified) {
    console.log(
      `\nRUN DISQUALIFIED: ${summary.outcomes.failed} unit(s) failed — an errored call is not a result.`,
    )
  }
  console.log(
    ceilings.allPass
      ? '\nAll ceilings pass.'
      : '\nNOT a clean pass — see above.',
  )
  console.log(`\nDone: ${log.path}`)
  process.exit(ceilings.allPass ? 0 : 1)
}

function fmt(v: number | null): string {
  return v === null ? '    -' : String(Math.round(v)).padStart(5)
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
