/**
 * generation-latency.ts — measures where the `generate` stage's wall-clock
 * goes, by streaming the SAME composed prompt production sends and timing
 * TTFT and decode separately per arm.
 *
 * WHY. Production generation is p50 ~6s / p90 ~12s (Langfuse, Sep 16-30,
 * n=224) and `generateObject` is non-streaming, so no trace records time
 * to first token. A regression over the 55 observations carrying usage
 * estimated latency ≈ 2.6-3.0s fixed + ~19ms per output token; this probe
 * measures the split directly and ranks the levers:
 *   - model (prod sonnet vs haiku vs sonnet-5) → decode rate AND overhead
 *   - schema (full GeneratedMessageSchema vs slimmed) → output tokens
 *   - cache (cold vs warm prefix) → prefill share of the fixed cost
 *
 * The prompt is composed through the production path (buildRuntimeContext →
 * retrieveCorpusStage → retrieveKnowledgeWithContextStage → composePrompt,
 * volatile block suffixed with VOICE_FIDELITY_INSTRUCTION exactly as
 * generate-message.ts does), so the token shape is the live one, not a
 * synthetic approximation.
 *
 * Cache isolation: every (model, schema) cell prepends its own nonce line
 * to the cacheable prefix, so no call can read the production cache entry
 * or another cell's. Within a cell, call 1 is the cold arm (cache write)
 * and the rest are warm (cache read). The score module invalidates any
 * cell whose cache accounting contradicts its arm.
 *
 * Replays are generation-only: nothing is classified, dispatched, gated or
 * persisted. One buildRuntimeContext call runs (computeGuestState may write
 * one state-transition row — the same side effect every harness accepts).
 *
 * Knobs: MEASURE_VENUE (slug, default le-mils-coffee), MEASURE_WARM_REPS
 * (default 5), MEASURE_MODELS (comma-separated model ids).
 */

import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { anthropic } from '@ai-sdk/anthropic'
import { streamObject } from 'ai'
import { z } from 'zod'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
  VOICE_FIDELITY_INSTRUCTION,
} from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type {
  KnowledgeCorpusChunk,
  MessageCategory,
  VoiceCorpusChunk,
} from '@/lib/ai/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import {
  formatReport,
  summarizeCells,
  type ProbeUnit,
  type SchemaArm,
} from './generation-latency-score'
import { createRunLog } from './run-log'

// The incident shape (2026-09-30): a recommendation ask, which retrieves a
// real knowledge block and renders the largest routine volatile suffix.
const PROBE_BODY = 'what should i try next time im there'
const PROBE_CATEGORY: MessageCategory = 'recommendation_request'

// What a realistic slimming of the output schema could look like: the reply
// and the two fields dispatch genuinely needs. Drops `reasoning`, the
// capture/commitment emissions and the self-flags — this arm measures the
// decode saving of fewer output tokens, not a shippable schema.
const SLIM_SCHEMA = z.object({
  body: z.string().min(1),
  voiceFidelity: z
    .number()
    .refine((n) => n >= 0 && n <= 1, { message: 'must be between 0 and 1' }),
  intentionQuestion: z.string(),
})

const SCHEMAS: Record<SchemaArm, z.ZodTypeAny> = {
  full: GeneratedMessageSchema,
  slim: SLIM_SCHEMA,
}

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const warmReps = Number(process.env.MEASURE_WARM_REPS ?? '5')
  if (!Number.isInteger(warmReps) || warmReps < 1) {
    console.error('✗ MEASURE_WARM_REPS must be a positive integer')
    process.exit(2)
  }
  const models = (
    process.env.MEASURE_MODELS ??
    'claude-sonnet-4-6,claude-haiku-4-5-20251001,claude-sonnet-5'
  )
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0)

  const db = createAdminClient()
  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, status')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  // Derive the guest rather than pasting an id: the most-messaged guest gives
  // the fullest ## Recent conversation block, which is the realistic (larger)
  // user prompt. Latency is shape-sensitive, not content-sensitive, so any
  // guest works; the fullest one is the conservative pick.
  const { data: candidates } = await db
    .from('guests')
    .select('id')
    .eq('venue_id', venue.id)
    .is('opted_out_at', null)
    .limit(50)
  let guest: { id: string; messages: number } | null = null
  for (const g of candidates ?? []) {
    const { count } = await db
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('guest_id', g.id)
    const n = count ?? 0
    if ((guest?.messages ?? -1) < n) guest = { id: g.id, messages: n }
  }
  if (!guest) throw new Error(`no usable guest at ${venueSlug}`)

  const trace = startAgentTrace({
    name: 'measurement.generation-latency',
    agentRunId: randomUUID(),
  })

  const ctx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: guest.id,
    venueId: venue.id,
    trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `latency-probe-${randomUUID()}`,
      body: PROBE_BODY,
      receivedAt: new Date(),
      channel: 'instagram',
      referralSource: null,
    },
  })

  ctx.corpus = await retrieveCorpusStage(ctx)
  ctx.knowledgeCorpus = await retrieveKnowledgeWithContextStage(
    ctx,
    PROBE_CATEGORY,
    PROBE_BODY,
  )

  const ragChunks: VoiceCorpusChunk[] = (ctx.corpus ?? []).map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as VoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))
  const knowledgeChunks: KnowledgeCorpusChunk[] | undefined =
    ctx.knowledgeCorpus === null
      ? undefined
      : ctx.knowledgeCorpus.map((ch) => ({
          id: ch.id,
          text: ch.text,
          sourceType: ch.sourceType,
          primaryTags: ch.primaryTags,
          secondaryTags: ch.secondaryTags,
          relevanceScore: ch.similarity,
        }))

  const { cacheableSystemPrefix, volatileSystemSuffix, userPrompt } =
    composePrompt({
      category: PROBE_CATEGORY,
      persona: ctx.venue.brandPersona,
      venueInfo: ctx.venue.venueInfo,
      ragChunks,
      knowledgeChunks,
      runtime: buildAiRuntime(ctx),
      channel: 'instagram',
    })
  // The exact production suffix join (generate-message.ts).
  const volatileSystemBlock = `${volatileSystemSuffix}\n\n${VOICE_FIDELITY_INSTRUCTION}`

  const log = createRunLog({
    name: 'generation-latency',
    meta: {
      arm: 'latency-probe',
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueStatus: venue.status,
      guest,
      models,
      warmReps,
      probeBody: PROBE_BODY,
      probeCategory: PROBE_CATEGORY,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // The instrument itself, frozen so a reader can compare runs: latency
      // is shape-sensitive, and these counts ARE the shape.
      prefixChars: cacheableSystemPrefix.length,
      volatileChars: volatileSystemBlock.length,
      userPromptChars: userPrompt.length,
      knowledgeChunkCount: knowledgeChunks?.length ?? 0,
    },
  })
  console.log(`[latency] venue=${venueSlug} guest=${guest.id.slice(0, 8)}`)
  console.log(
    `[latency] prefix=${cacheableSystemPrefix.length}ch volatile=${volatileSystemBlock.length}ch user=${userPrompt.length}ch`,
  )
  console.log(`[latency] run log: ${log.path}\n`)

  const units: ProbeUnit[] = []

  for (const model of models) {
    for (const schemaArm of Object.keys(SCHEMAS) as SchemaArm[]) {
      // One nonce per cell: isolates this cell from the production cache
      // entry (same prefix, same venue) and from every other cell.
      const nonce = `Calibration marker ${randomUUID()}. Ignore this line.`
      const prefixForCell = `${nonce}\n\n${cacheableSystemPrefix}`

      for (let call = 0; call < 1 + warmReps; call += 1) {
        const cacheArm = call === 0 ? 'cold' : 'warm'
        const unit: ProbeUnit = {
          model,
          schemaArm,
          cacheArm,
          ok: false,
          error: null,
          ttftMs: null,
          totalMs: null,
          outputTokens: null,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          uncachedInputTokens: 0,
        }
        try {
          const t0 = performance.now()
          const result = streamObject({
            model: anthropic(model),
            messages: [
              {
                role: 'system',
                content: prefixForCell,
                providerOptions: {
                  anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
                },
              },
              { role: 'system', content: volatileSystemBlock },
              { role: 'user', content: userPrompt },
            ],
            schema: SCHEMAS[schemaArm],
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          })
          for await (const _chunk of result.textStream) {
            if (unit.ttftMs === null) unit.ttftMs = performance.now() - t0
          }
          unit.totalMs = performance.now() - t0
          const usage = await result.usage
          const providerMetadata = await result.providerMetadata
          unit.outputTokens = usage?.outputTokens ?? null
          unit.cacheReadTokens = usage?.cachedInputTokens ?? 0
          unit.cacheWriteTokens =
            (providerMetadata?.anthropic?.cacheCreationInputTokens as
              number | null | undefined) ?? 0
          unit.uncachedInputTokens =
            usage?.inputTokenDetails?.noCacheTokens ?? 0
          unit.ok = true
        } catch (e) {
          unit.error = e instanceof Error ? e.message : String(e)
        }
        units.push(unit)
        log.appendUnit(unit as unknown as Record<string, unknown>)
        const show = (v: number | null) => (v === null ? '—' : Math.round(v))
        console.log(
          `[latency] ${model} ${schemaArm} ${cacheArm}: ` +
            (unit.ok
              ? `ttft=${show(unit.ttftMs)}ms total=${show(unit.totalMs)}ms out=${unit.outputTokens} cacheRead=${unit.cacheReadTokens}`
              : `FAILED: ${unit.error}`),
        )
      }
    }
  }

  const cells = summarizeCells(units)
  console.log(`\n${formatReport(cells)}`)
  const failures = units.filter((u) => !u.ok)
  if (failures.length > 0) {
    console.log(`\n${failures.length} failed call(s):`)
    for (const f of failures) {
      console.log(`  ${f.model} ${f.schemaArm} ${f.cacheArm}: ${f.error}`)
    }
  }
  if (cells.every((c) => !c.valid)) {
    console.error('✗ every cell invalid; run produced no usable result')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
