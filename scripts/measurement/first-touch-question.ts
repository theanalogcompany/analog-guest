// TAC-423 pre-flight: with the opener's scripted question gone, does the
// first-touch reply still ask anything? Generate-only. NOTHING IS SENT.
//
// ONE WRITE IS POSSIBLE and it is not this script's: buildRuntimeContext runs
// computeGuestState, which persists a `guest_states` row when a guest's
// recognition band actually changes. It does not fire for a guest whose band
// is stable, which is every guest this is worth running against — verified on
// the 2026-09-22 run, 6 rows before and 6 after, newest unchanged. Stated
// rather than claimed away, because "writes nothing" is the kind of sentence
// that stops being true without anyone noticing.
//
// The change under test removes the opener's own question and leaves the ask
// to the intention line rendered beneath it. TAC-519 measured what that line
// achieves in production at Le Mil's: 4 intention asks in 9 days,
// understand_order armed 5 and asked 1, learn_name armed 7 and asked 0. So the
// realistic risk is an opener that greets and asks nothing, and the ticket's
// whole point is a first touch that asks what the guest got.
//
// THE TWO ARMS DIFFER IN EXACTLY ONE VARIABLE: the opener paragraph. The
// prompt pair is composed ONCE per rep, and the BEFORE arm is that same pair
// with the shipped opener string replaced by v1.52.0's. Everything else —
// venue config, corpora, retrieval, classification, recognition, the intention
// lines, the restraint paragraph — is byte-identical between arms. A
// replacement that does not match exactly once makes the unit INVALID rather
// than silently measuring two prompts that differ in more than the opener.
//
// WHAT THIS IS NOT. It replicates generateMessage's single model call (same
// model, same system prompt plus the fidelity instruction, same schema, same
// token cap) but NOT its regeneration loop or its fidelity floor. Both arms
// share that limitation identically. It matters least for this metric: the
// regen loop fires on dashes, self-talk and unverified links, none of which
// decide whether a question is present.
//
// THE TURN IS SYNTHESISED, and it has to be. firstTouchAfterQrScan requires a
// guest's true first message, and every scanned guest at Le Mil's already has
// history, so no live guest can produce this turn. The context is built from a
// REAL venue and guest and then four fields are overridden to make it the
// opener turn: the guest's origin and creation time, an empty history, and the
// two intentions the real derivation opens there. Both arms get that same
// object. Creating a guest row instead would be a write, which a measurement
// does not get to make.
//
// TELEMETRY: run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL
// unset so the stages' events go inert.

import { randomUUID } from 'node:crypto'
import { generateObject } from 'ai'

import { createAdminClient } from '@/lib/db/admin'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from '@/lib/agent/stages'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
  VOICE_FIDELITY_INSTRUCTION,
} from '@/lib/ai/generate-message'
import { getGenerationModel } from '@/lib/ai/client'
import { firstTouchOpenerFor } from '@/lib/ai/prompts/serializers'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { INTENTION_DEFINITION_BY_KEY } from '@/lib/agent/intentions/definitions'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { createRunLog } from './run-log'
import { classifyFirstTouchReply } from './first-touch-question-detector'

// v1.52.0's opener, transcribed from the commit it shipped in, not rebuilt
// from the current source. This is the BEFORE arm and it must not drift with
// the code under test.
const OPENER_BEFORE =
  "This is the guest's first message on this number, sent right after they scanned your sign at pickup. They've already ordered and have it in hand. You don't know what it was. Say hello and let them know who they're texting, in your own words. If their message doesn't ask you anything, this is also the moment to thank them for coming in and ask what they got, one question, then let their answer lead. If they did ask something, answer that instead; the question isn't worth spending their first reply on."

const SCENARIOS = [
  {
    id: 'prefill',
    // Le Mil's live qrEnrollmentMessage, read from production 2026-09-22.
    // THE PRIMARY SCENARIO: the modal scan, no question of the guest's own,
    // which is the only turn on which either opener licenses an ask at all.
    body: "Hi Le Mil's!",
  },
  {
    id: 'prefill-plus-question',
    // The case ruling 2 deliberately changed. BEFORE holds its question back
    // ("the question isn't worth spending their first reply on"); AFTER is
    // governed by the restraint paragraph, which permits one short question on
    // the end of a finished answer. A LOWER ask rate here on the AFTER arm
    // would mean the ruling did not land.
    body: "Hi Le Mil's! are you open right now?",
  },
] as const

const ARMS = ['before', 'after'] as const

function parseArgs(argv: readonly string[]): { venue?: string; guest?: string; reps: number } {
  const out: { venue?: string; guest?: string; reps: number } = { reps: 20 }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--venue') out.venue = argv[++i]
    else if (argv[i] === '--guest') out.guest = argv[++i]
    else if (argv[i] === '--reps') out.reps = Number(argv[++i])
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.venue || !args.guest || !Number.isInteger(args.reps) || args.reps < 1) {
    console.error(
      '✗ usage: tsx scripts/measurement/first-touch-question.ts --venue <slug> --guest <uuid> [--reps N]',
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

  const openerAfter = firstTouchOpenerFor('text')
  const log = createRunLog({
    name: 'tac423-first-touch-question',
    meta: {
      arm: 'both',
      promptVersion: PROMPT_VERSION,
      venue: venue.slug,
      guestId: args.guest,
      reps: args.reps,
      scenarios: SCENARIOS.map((s) => s.id),
      openerBefore: OPENER_BEFORE,
      openerAfter,
      note: 'generate-only; nothing sent. Single attempt per arm, no regen loop. buildRuntimeContext can persist a guest_states row on a band change; none observed.',
    },
  })
  console.log(`run log: ${log.path}`)
  console.log(`${SCENARIOS.length} scenarios x ${ARMS.length} arms x ${args.reps} reps\n`)

  const trace = startAgentTrace({
    name: 'measurement.tac423-first-touch-question',
    agentRunId: randomUUID(),
    metadata: { venueId: venue.id, guestId: args.guest },
  })

  const tally: Record<string, { n: number; question: number; order: number; invalid: number }> = {}
  const bump = (k: string) => (tally[k] ??= { n: 0, question: 0, order: 0, invalid: 0 })

  for (const scenario of SCENARIOS) {
    for (let rep = 0; rep < args.reps; rep += 1) {
      const ctx = await buildRuntimeContext({
        agentRunId: randomUUID(),
        guestId: args.guest,
        venueId: venue.id,
        trace,
        currentMessage: {
          id: randomUUID(),
          providerMessageId: `measurement-${scenario.id}-${rep}`,
          body: scenario.body,
          receivedAt: new Date(),
          channel: 'text',
        },
      })

      // Make it the opener turn. computeFirstTouchAfterQrScan reads exactly
      // these three, and the intentions are what the real derivation opens on
      // a first-ever message: understand_order (priority 10, ungated) and
      // learn_name (the only one waived to zero on a first message).
      const now = new Date()
      ctx.guest.createdVia = 'qr_scan'
      ctx.guest.createdAt = now
      ctx.recentMessages = []
      ctx.recentVisits = []
      ctx.activeCommitments = []
      ctx.openIntentions = (['understand_order', 'learn_name'] as const).map((key) => ({
        key,
        promptLine: INTENTION_DEFINITION_BY_KEY[key].promptLine,
        eligibleAt: now,
      }))

      const classification = await classifyStage(ctx)
      ctx.classification = classification
      ctx.corpus = await retrieveCorpusStage(ctx)
      ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
        ? await retrieveKnowledgeStage(ctx, classification.category, scenario.body)
        : []

      const runtime = buildAiRuntime(ctx)
      const input = {
        persona: ctx.venue.brandPersona,
        venueInfo: ctx.venue.venueInfo,
        ragChunks: ctx.corpus ?? [],
        knowledgeChunks: ctx.knowledgeCorpus ?? [],
        runtime,
        category: classification.category,
        channel: ctx.conversationChannel,
      }
      const composed = composePrompt(input as Parameters<typeof composePrompt>[0])

      for (const arm of ARMS) {
        const key = `${scenario.id}|${arm}`
        const t = bump(key)

        let userPrompt = composed.userPrompt
        if (arm === 'before') {
          const hits = composed.userPrompt.split(openerAfter).length - 1
          if (hits !== 1) {
            t.invalid += 1
            log.appendUnit({
              scenarioId: scenario.id,
              rep,
              arm,
              invalid: `opener matched ${hits} times in the composed prompt, expected 1`,
            })
            console.log(`! ${scenario.id} rep${rep} ${arm} INVALID (opener matched ${hits}x)`)
            continue
          }
          userPrompt = composed.userPrompt.replace(openerAfter, OPENER_BEFORE)
        }

        let body: string | null = null
        let error: string | null = null
        try {
          const { object } = await generateObject({
            model: getGenerationModel(),
            system: `${composed.systemPrompt}\n\n${VOICE_FIDELITY_INSTRUCTION}`,
            prompt: userPrompt,
            schema: GeneratedMessageSchema,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          })
          body = object.body
        } catch (e: unknown) {
          error = e instanceof Error ? e.message : String(e)
        }

        const verdict = body ? classifyFirstTouchReply(body) : null
        t.n += 1
        if (verdict?.hasQuestion) t.question += 1
        if (verdict?.isOrderQuestion) t.order += 1

        log.appendUnit({
          scenarioId: scenario.id,
          inbound: scenario.body,
          rep,
          arm,
          category: classification.category,
          body,
          error,
          ...(verdict ?? {}),
        })

        const mark = !body ? '·' : verdict?.isOrderQuestion ? '✓' : verdict?.hasQuestion ? '?' : '✗'
        console.log(
          `${mark} ${scenario.id} rep${rep} ${arm.padEnd(6)} ${body ? JSON.stringify(body).slice(0, 110) : `(${error})`}`,
        )
      }
    }
  }

  await trace.flushAsync()
  console.log('\n=== rates ===')
  for (const scenario of SCENARIOS) {
    for (const arm of ARMS) {
      const t = tally[`${scenario.id}|${arm}`]
      if (!t) continue
      const pct = (x: number) => (t.n ? `${x}/${t.n} (${Math.round((100 * x) / t.n)}%)` : '0/0')
      console.log(
        `${scenario.id.padEnd(22)} ${arm.padEnd(6)} asks anything ${pct(t.question).padEnd(14)} asks the order ${pct(t.order)}${t.invalid ? `  INVALID ${t.invalid}` : ''}`,
      )
    }
  }
  console.log(`\nRun log: ${log.path}`)
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
