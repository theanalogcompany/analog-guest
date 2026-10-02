// Replays ONE real production turn to ask: with the 200-character history cap
// removed, does the model still "continue from where the previous message cut
// off"?
//
// THE TURN. A guest asked how to make filter coffee, then for a step-by-step
// version (a 332-character reply with steps 1 to 6), then said "Make it
// detailed". The model saw the 332-character reply cut at "(longer …" and wrote
// steps 5 and 6 again. This script rebuilds the conversation as it stood at that
// inbound message and generates the reply again, N times per arm.
//
// TWO ARMS, ONE VARIABLE - whether earlier bodies reach the model whole. History
// is sent as chat turns now (v1.81.0), so this asks the question of the turns.
//
//   arm `control`    each history body is pre-cut to its first 200 characters plus
//                    "…", the shape the old text-block serializer produced, and
//                    sent as the turn content.
//   arm `treatment`  the bodies as stored, which is what the code does now.
//
// The control is built by pre-cutting the INPUT rather than by keeping the old
// cap in the code, so the cap does not have to survive in the codebase just to be
// measured. Both arms run the SAME serializer, context, retrieval and
// classification; only the history bodies differ.
//
// ARM INTEGRITY, checked in code and printed. The control prose must contain the
// cut ("(longer …") and the treatment prose must contain the text the control
// lost ("if you want it stronger). 5. mix half"). If either is missing the arms
// did not differ and the run is VOID, not a pass: a clean treatment is also what
// a broken control produces. The control must also REPRODUCE the defect in at
// least MIN_CONTROL_DEFECTS replies (history-untruncated-score.ts), or the replay
// does not reproduce production and cannot speak to the fix.
//
// WHAT THIS IS NOT. Production's prompt for that turn is not recoverable byte for
// byte: `## Right now` re-dates to the moment of the run (the TAC-367 trap), the
// guest's stored context has moved on, and retrieval re-runs. History timestamps
// ARE shifted so the inbound message is "just now", as it was. Both arms share
// all of it, so the comparison is internal; it is a replay of the SITUATION, not
// of the exact prompt.
//
// N REPLIES PER ARM, NOT 1: generation runs at temperature 0.7, so one reply is
// a draw, not a property of the prompt.
//
// Read-only: no send, no database write. It calls `generateMessage` from lib/ai
// directly, not `generateStage`, because the stage fires PostHog events that feed
// Slack alerts. PostHog and Slack variables are cleared before any app module
// loads, as scripts/CLAUDE.md asks of a harness that calls stages.
//
// Run: npm run measure-history-untruncated -- --guest <uuid> [--reps 8]
//        [--inbound "Make it detailed"] [--channel instagram|text]

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/db/types'
import type { RecentMessage, VoiceCorpusChunk } from '@/lib/ai/types'
import {
  evaluateRun,
  MIN_CONTROL_DEFECTS,
  scoreReply,
  summarizeArm,
  type ScoredUnit,
} from './history-untruncated-score'
import { createRunLog } from './run-log'

const ARMS = ['control', 'treatment'] as const
type Arm = (typeof ARMS)[number]

// The cap this ticket removed, reproduced only to build the control arm.
const OLD_CAP = 200

// What each arm's prose must contain to prove the arms differ as intended.
const CUT_MARKER = '(longer …'
const FULL_MARKER = 'if you want it stronger). 5. mix half'

function parseArgs(argv: readonly string[]) {
  const out = {
    guest: '',
    reps: 8,
    inbound: 'Make it detailed',
    channel: 'instagram' as 'instagram' | 'text',
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--guest') out.guest = argv[++i] ?? ''
    else if (argv[i] === '--reps') out.reps = Number(argv[++i])
    else if (argv[i] === '--inbound') out.inbound = argv[++i] ?? ''
    else if (argv[i] === '--channel')
      out.channel = argv[++i] === 'text' ? 'text' : 'instagram'
  }
  return out
}

// Exactly what the old normalizeHistoryBody returned.
function oldRender(body: string): string {
  const collapsed = body.replace(/\s*\n\s*/g, ' ').trim()
  if (collapsed.length <= OLD_CAP) return collapsed
  return `${collapsed.slice(0, OLD_CAP)}…`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.guest || !Number.isInteger(args.reps) || args.reps < 1) {
    console.error(
      '✗ usage: tsx scripts/measurement/history-untruncated-replay.ts --guest <uuid> [--reps N] [--inbound "<body>"] [--channel instagram|text]',
    )
    process.exit(2)
  }

  delete process.env.NEXT_PUBLIC_POSTHOG_KEY
  delete process.env.SLACK_ALERTS_WEBHOOK_URL

  const { buildRuntimeContext } =
    await import('@/lib/agent/build-runtime-context')
  const {
    buildAiRuntime,
    classifyStage,
    retrieveCorpusStage,
    retrieveKnowledgeStage,
  } = await import('@/lib/agent/stages')
  const { generateMessage } = await import('@/lib/ai')
  const { composePrompt } = await import('@/lib/ai/compose-prompt')
  const { PROMPT_VERSION } = await import('@/lib/ai/prompts/system-template')
  const { startAgentTrace } = await import('@/lib/observability/langfuse')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  const supabase = createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: guest } = await supabase
    .from('guests')
    .select('id, venue_id')
    .eq('id', args.guest)
    .maybeSingle()
  if (!guest) throw new Error(`guest ${args.guest} not found`)

  const { data: rows, error } = await supabase
    .from('messages')
    .select('id, body, direction, created_at, status')
    .eq('venue_id', guest.venue_id)
    .eq('guest_id', guest.id)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`messages load failed: ${error.message}`)
  const all = (rows ?? []).filter((m) => m.body !== '')

  // The LAST inbound with this body: the replayed turn.
  const targetIdx = all
    .map((m) => m.direction === 'inbound' && m.body === args.inbound)
    .lastIndexOf(true)
  if (targetIdx < 0) {
    throw new Error(
      `no inbound message with body ${JSON.stringify(args.inbound)}`,
    )
  }
  const target = all[targetIdx]
  const earlier = all.slice(0, targetIdx)

  // PRECONDITION: every earlier outbound reached the guest. Otherwise the
  // history would need unsent markers this reconstruction does not model, and
  // the arms would be answering a different conversation.
  const unsent = earlier.filter(
    (m) => m.direction === 'outbound' && m.status !== 'sent',
  )
  if (unsent.length > 0) {
    throw new Error(
      `${unsent.length} earlier outbound message(s) were not 'sent'; this reconstruction assumes all were delivered`,
    )
  }

  // Shift history so the replayed inbound is "just now", as it was. Without it
  // every line renders "N days ago" and the arms inherit a conversation that
  // never existed.
  const shiftMs = Date.now() - new Date(target.created_at).getTime()
  const history: RecentMessage[] = earlier.map((m) => ({
    direction: m.direction === 'inbound' ? 'inbound' : 'outbound',
    body: m.body,
    createdAt: new Date(new Date(m.created_at).getTime() + shiftMs),
    delivery: 'delivered',
  }))
  const overCap = history.filter(
    (m) => oldRender(m.body) !== m.body.replace(/\s*\n\s*/g, ' ').trim(),
  )
  console.log(
    `replaying inbound ${JSON.stringify(target.body)} with ${history.length} earlier messages; ${overCap.length} exceed the old ${OLD_CAP}-char cap`,
  )

  const log = createRunLog({
    name: 'history-untruncated-replay',
    meta: {
      arm: 'control+treatment',
      question:
        'with the 200-char history cap removed, does the model still continue a numbered list from where "the previous message cut off"?',
      promptVersion: PROMPT_VERSION,
      guestId: guest.id,
      replayedInbound: target.body,
      reps: args.reps,
      channel: args.channel,
      oldCap: OLD_CAP,
      minControlDefects: MIN_CONTROL_DEFECTS,
      note: 'read-only; generateMessage called directly; history shifted so the inbound is "just now"',
    },
  })
  console.log(`run log: ${log.path}\n`)

  const trace = startAgentTrace({
    name: 'measurement.history-untruncated-replay',
    agentRunId: randomUUID(),
    metadata: { venueId: guest.venue_id, guestId: guest.id },
  })

  const ctx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: guest.id,
    venueId: guest.venue_id,
    trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `replay-${randomUUID()}`,
      body: target.body,
      receivedAt: new Date(),
      channel: args.channel,
      referralSource: null,
    },
  })
  ctx.conversationChannel = args.channel

  const classification = await classifyStage(ctx)
  ctx.classification = classification
  ctx.corpus = await retrieveCorpusStage(ctx)
  ctx.knowledgeCorpus = await retrieveKnowledgeStage(
    ctx,
    classification.category,
    target.body,
  )
  console.log(
    `classified as ${classification.category}; ${ctx.corpus?.length ?? 0} voice chunks, ${ctx.knowledgeCorpus?.length ?? 0} knowledge chunks\n`,
  )

  const ragChunks = (ctx.corpus ?? []).map((c) => ({
    id: c.id,
    text: c.text,
    sourceType: c.sourceType as VoiceCorpusChunk['sourceType'],
    relevanceScore: c.similarity,
  }))
  const knowledgeChunks = ctx.knowledgeCorpus?.map((c) => ({
    id: c.id,
    text: c.text,
    sourceType: c.sourceType,
    primaryTags: c.primaryTags,
    secondaryTags: c.secondaryTags,
    relevanceScore: c.similarity,
  }))

  const historyFor = (arm: Arm): RecentMessage[] =>
    arm === 'control'
      ? history.map((m) => ({ ...m, body: oldRender(m.body) }))
      : history

  // Everything the model reads after the system prompt, in send order: the
  // history turns, then the user prompt. Whitespace is collapsed so a marker
  // spanning a line break in a stored body still matches. Through composePrompt,
  // the one production caller of runtimeToProse (a source guard in
  // serializers.test.ts enforces that), so this is what generation would send.
  const proseFor = (arm: Arm): string => {
    ctx.recentMessages = historyFor(arm)
    const composed = composePrompt({
      category: classification.category,
      persona: ctx.venue.brandPersona,
      venueInfo: ctx.venue.venueInfo,
      ragChunks,
      knowledgeChunks,
      runtime: buildAiRuntime(ctx),
      channel: args.channel,
    })
    return [...composed.historyTurns.map((t) => t.content), composed.userPrompt]
      .join('\n')
      .replace(/\s+/g, ' ')
  }
  const controlProse = proseFor('control')
  const treatmentProse = proseFor('treatment')
  const controlHistoryCut = controlProse.includes(CUT_MARKER)
  const treatmentHistoryFull = treatmentProse.includes(FULL_MARKER)
  console.log(
    `arm integrity: control cut present=${controlHistoryCut}, treatment full text present=${treatmentHistoryFull}, prompts differ=${controlProse !== treatmentProse}\n`,
  )

  const units: Record<Arm, ScoredUnit[]> = { control: [], treatment: [] }
  const bodies: Record<Arm, string[]> = { control: [], treatment: [] }

  for (let rep = 0; rep < args.reps; rep += 1) {
    for (const arm of ARMS) {
      ctx.recentMessages = historyFor(arm)
      const gen = await generateMessage({
        category: classification.category,
        persona: ctx.venue.brandPersona,
        venueInfo: ctx.venue.venueInfo,
        ragChunks,
        knowledgeChunks,
        runtime: buildAiRuntime(ctx),
        channel: ctx.conversationChannel,
      })
      if (!gen.ok) {
        units[arm].push({ failed: true, verdict: null })
        log.appendUnit({ arm, rep, failed: true, error: gen.error })
        console.log(`✗ ${arm.padEnd(9)} rep${rep} FAILED: ${gen.error}`)
        continue
      }
      const verdict = scoreReply({
        body: gen.data.body,
        reasoning: gen.data.reasoning,
      })
      units[arm].push({ failed: false, verdict })
      bodies[arm].push(gen.data.body)
      log.appendUnit({
        arm,
        rep,
        failed: false,
        body: gen.data.body,
        reasoning: gen.data.reasoning,
        ...verdict,
      })
      const flags = [
        verdict.fragment ? 'FRAGMENT' : null,
        verdict.cutOffBelief ? 'CUT-OFF-BELIEF' : null,
      ].filter(Boolean)
      console.log(
        `${flags.length ? '✗' : '·'} ${arm.padEnd(9)} rep${rep} ${flags.join(' ')}`,
      )
    }
  }

  await trace.flushAsync()

  const control = summarizeArm(units.control)
  const treatment = summarizeArm(units.treatment)
  console.log('\n=== SUMMARY ===')
  console.log('control   ', control)
  console.log('treatment ', treatment)
  const verdict = evaluateRun({
    control,
    treatment,
    controlHistoryCut,
    treatmentHistoryFull,
  })
  console.log(
    `\nVERDICT: ${verdict.kind.toUpperCase()}${verdict.kind === 'pass' ? '' : ` - ${verdict.reason}`}`,
  )

  console.log('\n=== BODIES (read these before believing the rates) ===')
  for (const arm of ARMS) {
    console.log(`\n--- ${arm} ---`)
    bodies[arm].forEach((b, i) => console.log(`[${i}] ${JSON.stringify(b)}`))
  }
  console.log(`\nrun log: ${log.path}`)
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
