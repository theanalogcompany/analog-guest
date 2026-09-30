// TAC-560: fifteen warm closes, read.
//
// GENERATE-ONLY. Nothing is sent, nothing is claimed, no marker is written, and
// the only database write possible is the one buildRuntimeContext makes on its
// own (computeGuestState persists a `guest_states` row when a guest's band
// actually changes). Context is built ONCE and reused for all fifteen, so there
// is exactly one opportunity for that write rather than fifteen. The run reports
// the row count before and after.
//
// THE BARS ARE PRE-REGISTERED on the ticket, before this was run, and a breach is
// reported as it came out rather than re-cut:
//   - 15/15 name all three topics. HAND-READ; the detector narrows the reading.
//   - one short message each, asserted through the REAL resolveDispatchBubbles
//     with the rng the production path passes, not by eye.
//   - no 2-gram or 3-gram in more than a quarter of the closes, so 4 of 15 fails.
//
// CEILINGS, which fail the run at ANY rate (the TAC-519 lesson: read as a rate a
// single occurrence looks dismissible, read as a ceiling it is disqualifying):
//   - 0 closes that ask a question.
//   - 0 closes that narrate the pause.
//
// WHY IT COMPOSES THE PROMPT AND CALLS generateObject DIRECTLY, the TAC-513 and
// TAC-544 reasoning unchanged: generateMessage runs a regen loop and returns the
// LAST attempt rather than the best, so a rate measured through it mixes this
// copy's effect with the loop's. What that costs, stated rather than left to be
// found: this measures GENERATION. In production the close also passes the
// approval gate, and the device gate on the ticket covers the rest.
//
// THE TURN IS THE REAL ONE. `warmClose: true` on the runtime context is exactly
// what the processor's trigger produces, so the composed prompt here is the
// composed prompt production sends: the `## Closing this conversation` block
// renders and the category instructions are replaced. A startup guard checks
// both before spending a call, because a run whose arm silently did not apply
// produces exactly the "it works" shape (TAC-502's replay counted 60 failed calls
// as a clean pass).
//
// TELEMETRY: run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL unset
// so the stages' events go inert.
//
//   npx tsx --env-file=.env.local scripts/measurement/warm-close.ts

import { randomUUID } from 'node:crypto'
import { generateObject } from 'ai'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  resolveDispatchBubbles,
  intentionTailFor,
} from '@/lib/agent/sentence-split'
import {
  buildAiRuntime,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
} from '@/lib/agent/stages'
import { NEVER_SPLIT_RNG } from '@/lib/agent/warm-close'
import { getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
  VOICE_FIDELITY_INSTRUCTION,
} from '@/lib/ai/generate-message'
import { WARM_CLOSE_INSTRUCTIONS } from '@/lib/ai/prompts/categories/warm-close'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import type { VoiceCorpusChunk as AiVoiceCorpusChunk } from '@/lib/ai'
import { createRunLog } from './run-log'
import {
  asksAQuestion,
  findTopics,
  mentionsThePause,
} from './warm-close-language'

const REPS = Number(process.env.MEASURE_CLOSES ?? '15')
const BLOCK_HEADER = '## Closing this conversation'

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const db = createAdminClient()

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  // THE GUEST: a counter-scan guest on Instagram, which is the population the
  // ruling scopes this to. Derived rather than pasted as an id, and reported, so
  // a run says which guest it used. Falls back to any Instagram guest with a
  // warning, because a fresh venue may have no qr_scan guest yet and a run that
  // refuses outright is less useful than one that says what it settled for.
  const { data: candidates } = await db
    .from('guests')
    .select('id, first_name, created_via, instagram_scoped_id')
    .eq('venue_id', venue.id)
    .not('instagram_scoped_id', 'is', null)
  const instagramGuests = (candidates ?? []).filter(
    (g) =>
      !String(g.first_name ?? '')
        .toLowerCase()
        .startsWith('synthetic'),
  )
  const scanGuests = instagramGuests.filter((g) => g.created_via === 'qr_scan')
  const guest = scanGuests[0] ?? instagramGuests[0]
  if (!guest) throw new Error(`no Instagram guest at ${venueSlug}`)
  if (scanGuests.length === 0) {
    console.warn(
      `[tac560] NO qr_scan guest at this venue; using ${guest.id} (created_via=${guest.created_via}).\n` +
        '          The prompt is identical either way (created_via gates ELIGIBILITY in the\n' +
        '          processor, not the copy), but say so when reporting the run.\n',
    )
  }

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venue.id)

  const trace = startAgentTrace({
    name: 'tac560-measure',
    agentRunId: randomUUID(),
  })
  const now = new Date()

  // ONE context build, reused. `currentMessage: null` is what the followup path
  // passes, which is what makes this the real turn rather than an approximation.
  const ctx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: guest.id,
    venueId: venue.id,
    trace,
    followupTrigger: {
      reason: 'warm_close',
      triggeredAt: now,
      warmClose: { answersMessageId: randomUUID() },
    },
  })

  ctx.corpus = await retrieveCorpusStage(ctx)
  // The close asks for no fact, so there is nothing to ground. This mirrors what
  // the followup path does for a reason with no free text of its own.
  ctx.knowledgeCorpus = await retrieveKnowledgeStage(ctx, 'acknowledgment', '')

  // The two corpus shapes differ only in how strictly sourceType is typed; the
  // guest-name harness maps them the same way.
  const ragChunks: AiVoiceCorpusChunk[] = (ctx.corpus ?? []).map((c) => ({
    id: c.id,
    text: c.text,
    sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: c.similarity,
  }))

  const composed = composePrompt({
    category: 'acknowledgment',
    persona: ctx.venue.brandPersona,
    venueInfo: ctx.venue.venueInfo,
    ragChunks,
    knowledgeChunks: ctx.knowledgeCorpus ?? undefined,
    runtime: buildAiRuntime(ctx),
    channel: ctx.conversationChannel,
  })

  // STARTUP GUARDS, before a single call is spent. Each one is a way the run
  // could report cleanly while measuring nothing.
  const problems: string[] = []
  if (!composed.userPrompt.includes(BLOCK_HEADER)) {
    problems.push(
      `the ${BLOCK_HEADER} block did not render into the user prompt`,
    )
  }
  if (!composed.systemPrompt.includes(WARM_CLOSE_INSTRUCTIONS)) {
    problems.push(
      'the warm-close category instructions did not replace the acknowledgment ones',
    )
  }
  if (composed.systemPrompt.includes('wrapping up the thread')) {
    problems.push(
      'ACKNOWLEDGMENT_INSTRUCTIONS is still in the system prompt: it asserts the guest signed off, ' +
        'which is false on a pause, so the replacement did not happen',
    )
  }
  if (ctx.conversationChannel !== 'instagram') {
    problems.push(
      `channel resolved to ${String(ctx.conversationChannel)}, not instagram`,
    )
  }
  if (problems.length > 0) {
    console.error('✗ refusing to run:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  console.log(
    `[tac560] venue=${venue.slug} guest=${guest.id} created_via=${guest.created_via} ` +
      `channel=${ctx.conversationChannel} prompt=${PROMPT_VERSION} reps=${REPS}\n` +
      `[tac560] corpus=${ctx.corpus.length} knowledge=${ctx.knowledgeCorpus?.length ?? 0}\n`,
  )

  const log = await createRunLog({
    name: 'tac560-warm-close',
    meta: {
      arm: 'shipped',
      promptVersion: PROMPT_VERSION,
      venueSlug: venue.slug,
      guestId: guest.id,
      guestCreatedVia: guest.created_via,
      reps: REPS,
    },
  })

  const system = `${composed.systemPrompt}\n\n${VOICE_FIDELITY_INSTRUCTION}`
  type Unit = {
    rep: number
    body: string | null
    error: string | null
    bubbles: number
    topics: ReturnType<typeof findTopics> | null
    asksQuestion: boolean
    pauseMention: string | null
  }
  const units: Unit[] = []

  for (let rep = 1; rep <= REPS; rep += 1) {
    let body: string | null = null
    let error: string | null = null
    // A bounded re-ask on a schema failure, byte-identical prompt every attempt.
    // Not the regen loop: no feedback, no sticky constraints. It absorbs the
    // voiceFidelity-scale failure the TAC-513 harness hit on 11 of 14.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const { object } = await generateObject({
          model: getGenerationModel(),
          system,
          prompt: composed.userPrompt,
          schema: GeneratedMessageSchema,
          temperature: 0.7,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        })
        body = object.body
        error = null
        break
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    }

    // ONE MESSAGE, through the REAL splitter with the rng production passes.
    // Asserting this by eye would prove nothing about dispatch.
    const bubbles =
      body === null
        ? 0
        : resolveDispatchBubbles(body, NEVER_SPLIT_RNG, intentionTailFor('', 0))
            .length

    const unit: Unit = {
      rep,
      body,
      error,
      bubbles,
      topics: body === null ? null : findTopics(body),
      asksQuestion: body !== null && asksAQuestion(body),
      pauseMention: body === null ? null : mentionsThePause(body),
    }
    units.push(unit)
    await log.appendUnit(unit)
    process.stdout.write(`  ${rep}/${REPS}\r`)
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venue.id)

  // A FAILED UNIT IS NOT A RESULT. It produced no body, so it can meet no
  // expectation, and counting it as "did not name all three" would score a
  // broken run as a finding (TAC-502's replay did exactly that).
  const failed = units.filter((u) => u.body === null)
  const scored = units.filter((u) => u.body !== null)
  const bodies = scored.map((u) => u.body as string)

  console.log(
    `\n=== TAC-560: ${scored.length} closes scored, ${failed.length} failed ===\n`,
  )
  for (const u of units) {
    if (u.body === null) {
      console.log(`[${u.rep}] FAILED: ${u.error}`)
      continue
    }
    const t = u.topics as ReturnType<typeof findTopics>
    const flags = [
      t.allThree
        ? 'all three'
        : `MISSING ${(['coffee', 'menu', 'events'] as const).filter((k) => !t[k]).join(', ')}`,
      `${u.bubbles} bubble${u.bubbles === 1 ? '' : 's'}`,
      u.asksQuestion ? 'ASKS A QUESTION' : null,
      u.pauseMention !== null ? `MENTIONS THE PAUSE (${u.pauseMention})` : null,
    ].filter(Boolean)
    console.log(`[${u.rep}] ${flags.join(' | ')}`)
    console.log(`     ${u.body.replace(/\n/g, '\n     ')}`)
    console.log(
      `     matched: coffee=${t.matched.coffee ?? '-'} menu=${t.matched.menu ?? '-'} events=${t.matched.events ?? '-'}`,
    )
  }

  const allThree = scored.filter((u) => u.topics?.allThree).length
  const oneMessage = scored.filter((u) => u.bubbles === 1).length
  const askers = scored.filter((u) => u.asksQuestion)
  const pausers = scored.filter((u) => u.pauseMention !== null)

  // The n-gram ceiling, reusing TAC-548's detector rather than a second copy.
  // Its own tests caught an overlapping-window double count and a small-N false
  // positive, so this inherits both fixes.
  const { repeatedPhrases } = await import('./take-and-specifics-language')
  const repeats2 = repeatedPhrases(bodies, { n: 2, maxShare: 0.25 })
  const repeats3 = repeatedPhrases(bodies, { n: 3, maxShare: 0.25 })

  console.log('\n=== against the pre-registered bars ===')
  const verdict = (pass: boolean) => (pass ? 'PASS' : 'FAIL')
  console.log(
    `${verdict(failed.length === 0)}  ${failed.length} failed calls (bar: 0)`,
  )
  console.log(
    `${verdict(allThree === scored.length && scored.length > 0)}  all three topics: ${allThree}/${scored.length} (bar: every one, HAND-READ the bodies above)`,
  )
  console.log(
    `${verdict(oneMessage === scored.length)}  one message: ${oneMessage}/${scored.length} (bar: every one)`,
  )
  console.log(
    `${verdict(repeats2.length === 0)}  ceiling, 2-gram share: ${repeats2.length} phrase(s) over a quarter`,
  )
  for (const r of repeats2)
    console.log(`        "${r.phrase}" in ${r.replies}/${bodies.length}`)
  console.log(
    `${verdict(repeats3.length === 0)}  ceiling, 3-gram share: ${repeats3.length} phrase(s) over a quarter`,
  )
  for (const r of repeats3)
    console.log(`        "${r.phrase}" in ${r.replies}/${bodies.length}`)
  console.log(
    `${verdict(askers.length === 0)}  ceiling, asks a question: ${askers.length}`,
  )
  console.log(
    `${verdict(pausers.length === 0)}  ceiling, mentions the pause: ${pausers.length}`,
  )
  console.log(
    `\n[tac560] guest_states rows at this venue: ${statesBefore ?? '?'} before, ${statesAfter ?? '?'} after`,
  )
  console.log(`[tac560] run log: ${log.path}`)
}

void main()
