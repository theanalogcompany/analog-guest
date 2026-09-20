// TAC-500/TAC-501: does the "no public phone number" knowledge entry cause the
// grounding backstop to flag TRUE statements on Sendblue?
//
// Round 5 found the verifier holding correct SMS replies ("just text here, this
// is the number") and quoting that entry almost verbatim as its reason. Quoting
// it proves the entry is IN the source material. It does not prove the entry is
// what changed the verdict: nothing in `venue_info` states a phone number
// either, so the verifier may have objected regardless. Rewording a true venue
// fact on that hunch would be guesswork.
//
// So this is a verifier-only replay, and the ONE variable is whether the entry
// is in the source material.
//
//   arm `with`    — the chunks retrieval actually returned
//   arm `without` — the same set minus the entry
//
// The reply BODIES are fixed, taken verbatim from round 5's run log rather than
// retyped, so nothing is re-generated and no wording drifts. Only the verifier
// runs.
//
// THE ENTRY APPEARS TWICE IN WHAT THE VERIFIER READS, which is the part easy to
// get wrong: `buildSourceMaterial` renders `knowledgeChunksToProse(chunks)` AND
// appends the generator's own user prompt, which contains its own
// `## Venue knowledge` block built from those same chunks. Filtering the chunks
// argument alone would leave the entry sitting in the runtime context, the arms
// would be identical in the way that matters, and the run would report a null
// result that meant nothing. Both arms recompose the user prompt from their own
// chunk set.
//
// WHY THE PROMPT IS REBUILT RATHER THAN REPLAYED. Round 5 stored bodies, not
// prompts, so neither arm reproduces the production prompt byte for byte — the
// clock has moved, so `## Right now` differs (the TAC-367 re-dating trap). That
// is survivable here because the comparison is internal: both arms are built at
// the same moment from the same context and differ only in the chunk set. The
// `with` arm doubles as the reproduction check — if it does not flag, the replay
// cannot speak to the production flag at all and the run says nothing.
//
// N=5 PER CELL, NOT 1. The verifier runs at temperature 0.2, so one verdict is a
// draw from a distribution and not a property of the body — this repo has a
// documented case (TAC-409) of eight drafts reasoned about as eight behaviours
// when replay showed three had no stable verdict at all. Twelve calls would be
// one draw per cell and would reproduce that mistake exactly.
//
// Generate-only in the sense that matters: no generation, no send, no database
// write.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  verifyGroundingStage,
} from '@/lib/agent/stages'
import { composePrompt } from '@/lib/ai/compose-prompt'
import type { VoiceCorpusChunk as AiVoiceCorpusChunk } from '@/lib/ai/types'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { VERIFY_GROUNDING_PROMPT_VERSION } from '@/lib/ai/verify-grounding'
import { createRunLog, readRunLog } from './run-log'

/**
 * The entry under test, by id prefix. Content as of 2026-09-20:
 *
 *   "Le Mil's has no public phone number. The team is reached through Instagram
 *    or by email at shopper@lemils.com. There is no number to give out."
 */
const ENTRY_CORPUS_ID = 'ebb4a82f-2b33-45c0-9048-b9835bc3f6f3'

/**
 * THE ID TRAP, and the reason this constant is resolved at runtime rather than
 * written down.
 *
 * `retrieveKnowledgeStage` returns rows whose `id` is the **knowledge_embeddings
 * chunk id**, NOT the knowledge_corpus row id. The first version of this script
 * filtered on the corpus id, matched nothing, and reported `entryRetrieved:
 * false` for all five scenarios — so the `without` arm removed nothing, both
 * arms were byte-identical, and the run came back a clean null result that
 * looked like an answer. It was caught only because the verifier's own reasoning
 * quoted the entry verbatim while the instrumentation insisted it was absent.
 *
 * `KnowledgeCorpusChunk` carries `knowledgeCorpusId` ALONGSIDE `id`, and that
 * is the field to filter on — the one this script now uses, and the one
 * `scripts/onboarding/run-sheet.ts` already maps for the same reason. A type
 * named for the corpus whose `id` is not the corpus's is the whole trap.
 *
 * The startup lookup below survives as a PRECONDITION rather than as the
 * filter: it fails the run if the entry has no embedding rows at all, because
 * an entry that cannot be retrieved gives two identical arms and a null result
 * that looks like an answer.
 */

/**
 * Which round-5 units to replay, by (scenario, rep) in the TEXT arm.
 *
 * The first six are the ones whose flags quote the entry — the suspected false
 * positives, every one a statement that is TRUE on SMS.
 *
 * The last two are NEGATIVE CONTROLS, flagged in round 5 for reasons that have
 * nothing to do with the entry (a services contradiction, an invented response
 * time). They must stay flagged in BOTH arms. Without them, an arm that came
 * back clean would be indistinguishable from an arm that was silently broken —
 * a filtered chunk set that dropped everything, a prompt that failed to
 * compose — and "removing the entry fixes it" is exactly the answer a broken
 * arm produces.
 */
const REPLAY: ReadonlyArray<{ scenarioId: string; rep: number; kind: 'suspect' | 'control' }> = [
  { scenarioId: 'heads-up-how', rep: 0, kind: 'suspect' },
  { scenarioId: 'heads-up-how', rep: 1, kind: 'suspect' },
  { scenarioId: 'heads-up-how', rep: 2, kind: 'suspect' },
  { scenarioId: 'no-email', rep: 2, kind: 'suspect' },
  { scenarioId: 'friend-not-on-here', rep: 0, kind: 'suspect' },
  { scenarioId: 'friend-not-on-here', rep: 2, kind: 'suspect' },
  { scenarioId: 'how-will-you-tell-me', rep: 1, kind: 'control' },
  { scenarioId: 'reply-speed', rep: 0, kind: 'control' },
]

const ARMS = ['with', 'without'] as const

function parseArgs(argv: readonly string[]): {
  venue?: string
  guest?: string
  from?: string
  reps: number
} {
  const out: { venue?: string; guest?: string; from?: string; reps: number } = { reps: 5 }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--venue') out.venue = argv[++i]
    else if (argv[i] === '--guest') out.guest = argv[++i]
    else if (argv[i] === '--from') out.from = argv[++i]
    else if (argv[i] === '--reps') out.reps = Number(argv[++i])
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.venue || !args.guest || !args.from || !Number.isInteger(args.reps) || args.reps < 1) {
    console.error(
      '✗ usage: tsx scripts/measurement/grounding-entry-replay.ts --venue <slug> --guest <uuid> --from <round5.jsonl> [--reps N]',
    )
    process.exit(2)
  }

  // Bodies come from the round-5 log, never retyped: a hand-copied reply is a
  // different reply, and the whole design rests on the body being fixed.
  const source = readRunLog(args.from)
  const findUnit = (scenarioId: string, rep: number) =>
    source.units.find(
      (u) => u.scenarioId === scenarioId && u.rep === rep && u.arm === 'text',
    ) as
      | { scenarioId: string; rep: number; inbound: string; body: string; groundingStatus: string }
      | undefined

  const targets = REPLAY.map((t) => {
    const unit = findUnit(t.scenarioId, t.rep)
    if (!unit || typeof unit.body !== 'string' || unit.body.length === 0) {
      console.error(`✗ ${args.from} has no text-arm body for ${t.scenarioId} rep${t.rep}`)
      process.exit(1)
    }
    return { ...t, inbound: unit.inbound, body: unit.body, roundFiveStatus: unit.groundingStatus }
  })

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

  // Resolve the entry's EMBEDDING chunk ids — the ids retrieval actually
  // returns. Refuses to run if the entry has none, because a filter with
  // nothing to match is exactly the null result this script exists to avoid.
  const { data: entryChunks } = await supabase
    .from('knowledge_embeddings')
    .select('id')
    .eq('corpus_id', ENTRY_CORPUS_ID)
  const entryChunkCount = (entryChunks ?? []).length
  if (entryChunkCount === 0) {
    console.error(
      `✗ knowledge entry ${ENTRY_CORPUS_ID} has no embedding rows; there is nothing for the` +
        ` "without" arm to remove, so the two arms would be identical and the run would mean nothing.`,
    )
    process.exit(1)
  }
  console.log(`entry ${ENTRY_CORPUS_ID.slice(0, 8)} has ${entryChunkCount} embedding chunk(s)\n`)

  const log = createRunLog({
    name: 'tac500-grounding-entry-replay',
    meta: {
      arm: 'both',
      question: 'does the no-public-phone-number knowledge entry cause the SMS false positives?',
      verifierPromptVersion: VERIFY_GROUNDING_PROMPT_VERSION,
      venue: venue.slug,
      guestId: args.guest,
      entryCorpusId: ENTRY_CORPUS_ID,
      reps: args.reps,
      replayedFrom: args.from,
      note: 'verifier-only; bodies fixed from the source run; no generation, no send, no db write',
    },
  })
  console.log(`run log: ${log.path}`)
  console.log(`${targets.length} bodies x ${ARMS.length} arms x ${args.reps} reps\n`)

  const trace = startAgentTrace({
    name: 'measurement.grounding-entry-replay',
    agentRunId: randomUUID(),
    metadata: { venueId: venue.id, guestId: args.guest },
  })

  for (const target of targets) {
    const ctx = await buildRuntimeContext({
      agentRunId: randomUUID(),
      guestId: args.guest,
      venueId: venue.id,
      trace,
      currentMessage: {
        id: randomUUID(),
        providerMessageId: `replay-${target.scenarioId}-${target.rep}`,
        body: target.inbound,
        receivedAt: new Date(),
        channel: 'instagram',
      },
    })
    // The bodies under test are SMS replies, so the reconstruction is the SMS
    // conversation, matching the arm they came from.
    ctx.conversationChannel = 'text'

    const classification = await classifyStage(ctx)
    ctx.classification = classification
    ctx.corpus = await retrieveCorpusStage(ctx)
    const retrieved = await retrieveKnowledgeStage(ctx, classification.category, target.inbound)

    // THE PRECONDITION. If the entry was never retrieved for this scenario it
    // cannot be what the verifier read, whatever its reasoning quoted, and the
    // two arms are the same run twice.
    const entryPresent = retrieved.some((c) => c.knowledgeCorpusId === ENTRY_CORPUS_ID)

    for (const arm of ARMS) {
      const chunks =
        arm === 'with'
          ? retrieved
          : retrieved.filter((c) => c.knowledgeCorpusId !== ENTRY_CORPUS_ID)
      ctx.knowledgeCorpus = chunks

      // Recomposed per arm so the entry leaves BOTH places the verifier reads
      // it: the chunks argument and the runtime context inside them.
      const { userPrompt } = composePrompt({
        category: classification.category,
        persona: ctx.venue.brandPersona,
        venueInfo: ctx.venue.venueInfo,
        // Same per-field cast generateStage makes, for the same reason: lib/rag
        // types sourceType as plain string, lib/ai narrows it to a closed union,
        // and the voice_corpus check constraint guarantees runtime values are
        // inside it.
        ragChunks: ctx.corpus.map((c) => ({
          id: c.id,
          text: c.text,
          sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
          relevanceScore: c.similarity,
        })),
        knowledgeChunks: chunks.map((c) => ({
          id: c.id,
          text: c.text,
          sourceType: c.sourceType,
          primaryTags: c.primaryTags,
          secondaryTags: c.secondaryTags,
          relevanceScore: c.similarity,
        })),
        runtime: buildAiRuntime(ctx),
        channel: 'text',
      })

      // Check the CHUNK TEXTS, not the user prompt. `buildSourceMaterial` shows
      // the verifier `knowledgeChunksToProse(knowledgeChunks)`; the knowledge
      // block lives in the SYSTEM prompt, so it is not in `userPrompt` at all
      // and the first version of this assertion was reading a string that could
      // never contain the entry. It reported "0 violations" on a run where the
      // entry was present in every cell.
      const entryInSourceMaterial = chunks.some((c) => /no public phone number/i.test(c.text))

      for (let rep = 0; rep < args.reps; rep += 1) {
        const r = await verifyGroundingStage(ctx, {
          knowledgeGap: false,
          body: target.body,
          userPrompt,
        })

        log.appendUnit({
          scenarioId: target.scenarioId,
          sourceRep: target.rep,
          kind: target.kind,
          arm,
          rep,
          inbound: target.inbound,
          body: target.body,
          roundFiveStatus: target.roundFiveStatus,
          entryRetrieved: entryPresent,
          chunkIds: chunks.map((c) => c.id),
  
          entryInSourceMaterial,
          chunkEmbeddingIds: chunks.map((c) => c.id),
          chunkCorpusIds: chunks.map((c) => c.knowledgeCorpusId),
          status: r.status,
          claims: r.status === 'flagged' ? r.claims : [],
        })

        const mark = r.status === 'flagged' ? '✗ flagged' : `· ${r.status}`
        console.log(
          `${mark}  ${target.scenarioId} r${target.rep} [${target.kind}] ${arm.padEnd(7)} rep${rep}` +
            `${entryPresent ? '' : '  (ENTRY NOT RETRIEVED)'}`,
        )
      }
    }
  }

  await trace.flushAsync()
  console.log(`\nDone: ${log.path}`)
  console.log('Read the suspect rows first: a drop from flagged to clean between')
  console.log('arms is the entry doing it. The controls must stay flagged in both.')
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
