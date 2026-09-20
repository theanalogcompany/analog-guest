// TAC-469 pre-flight: does a reply generated for an Instagram conversation
// still talk like SMS? Generate-only. NOTHING IS SENT and nothing is written
// to the database.
//
// TAC-495 gave Instagram its own prompt copy, and `compose-prompt.test.ts`
// proves those swaps are in the prompt. A prompt is an instruction; whether
// the model obeys it is a different question and only generation answers it.
// This is the arm that answers it, and it is the last open item on TAC-469's
// pre-flight before the gate flips.
//
// THE TWO ARMS DIFFER IN EXACTLY ONE VARIABLE. The context is built ONCE per
// scenario from a real venue, guest and corpus, and then `conversationChannel`
// is overridden per arm. Resolving the channel honestly instead — by picking an
// Instagram guest for one arm and a phone guest for the other — would vary the
// guest, their history, their name and their recognition state alongside the
// channel, and no difference in the output could then be attributed to the
// copy. The resolver has its own tests; what is under test here is the effect
// of the channel on what the model writes.
//
// TELEMETRY: the stages fire PostHog events and some Slack relays. Run with
// NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL unset and both go
// inert (PostHog throws inside its own try/catch, Slack warns and skips), so
// a measurement run does not pollute either. The npm script does not unset
// them for you — see the run instructions on the ticket.
//
// Reads the venue's live config and corpora, so results are only comparable
// across runs that saw the same config. It also runs the real classifier and
// retrieval, so it costs real model calls: roughly 3 per generation.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  classifyStage,
  generateStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from '@/lib/agent/stages'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type { MessageChannel } from '@/lib/schemas/message-channel'
import { createRunLog } from './run-log'
import { findChannelLanguage } from './channel-language'

/**
 * REBUILT after the 2026-09-19 run came back inconclusive: the control arm
 * produced ONE phone claim in 24 generations against a bar of 8, so a clean
 * Instagram arm proved nothing. The diagnosis is in what the one scenario that
 * did fire was doing that the other seven were not.
 *
 * `reach-you` ("what's the best way to reach you?") makes THE CHANNEL THE
 * ANSWER. It cannot be answered without referring to how the guest and the
 * venue communicate. The other seven were all answerable in terms of policy
 * ("we don't take orders ahead, counter only"), physical presence ("just come
 * by") or content ("those were test messages") — so the model never had a
 * reason to name a channel, in either arm, and the run was measuring turns
 * where the copy under test does not render as anything observable.
 *
 * But "the channel is the answer" is not sufficient on its own, which is the
 * second half of the finding: even `reach-you` fired only 1 time in 3, because
 * the model's preferred answer is "right here works" — channel-NEUTRAL, and
 * correct on both arms. A scenario that lets "right here" be a complete answer
 * lets the model avoid the copy entirely.
 *
 * So every scenario below satisfies BOTH:
 *   1. the channel is the answer, not an aside; and
 *   2. "right here" is not a sufficient answer.
 *
 * The levers that defeat "right here" are a third party who is not in this
 * conversation, a named alternative the model must accept or refuse, a
 * concrete artefact to be saved or sent, and a promise to make contact later.
 */
const SCENARIOS: ReadonlyArray<{ id: string; body: string; why: string }> = [
  {
    id: 'friend-asks',
    body: 'my friend wants to ask about buying beans for her office, how does she get in touch with you?',
    why: 'A THIRD PARTY who is not in this conversation, so "right here" cannot answer it. The model has to name a route someone else can use. The sharpest lever found.',
  },
  {
    id: 'call-instead',
    body: 'can i just call you instead?',
    why: 'Names the alternative outright, forcing an accept or refuse about the phone specifically. "Right here" is a deflection, not an answer.',
  },
  {
    id: 'save-contact',
    body: 'should i save you in my contacts? what do i save you as?',
    why: 'Forces a CONCRETE ARTEFACT: a number on SMS, a profile on Instagram. The first run\'s version stopped at "should i save you" and got "yeah, save it" — channel-neutral. The second clause is what defeats that.',
  },
  {
    id: 'not-on-phone',
    body: "if i'm away from my phone how else can i reach you?",
    why: 'Puts the current channel out of reach by premise, so "right here" is excluded by the question itself.',
  },
  {
    id: 'let-me-know',
    body: 'can you let me know when the new panama lot lands?',
    why: 'A promise to make contact LATER. The model has to say how it will reach them, and the medium is the whole content of that promise.',
  },
  {
    id: 'send-photo',
    body: 'can i send you a photo of the receipt?',
    why: 'An artefact moving the other way. Whether a photo can be sent, and how, differs by channel.',
  },
  {
    id: 'heads-up-how',
    body: "how do i let you know when i'm on my way?",
    why: 'Targets the heads-up examples in # Commitments, which carry an explicit channel variant ("text me a heads-up" vs "send me a heads-up"). The first run\'s complaint scenario produced "give me a heads up" with no channel verb; asking HOW forces one.',
  },
  {
    id: 'right-place',
    body: 'is this the right place to ask about wholesale, or is there somewhere better?',
    why: 'Asks the model to evaluate the channel against alternatives, which is exactly R5 territory (each arm names the OTHER channel in its list).',
  },
]

const ARMS: readonly MessageChannel[] = ['instagram', 'text']

function parseArgs(argv: readonly string[]): { venue?: string; guest?: string; reps: number } {
  const out: { venue?: string; guest?: string; reps: number } = { reps: 3 }
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
      '✗ usage: npm run measure-instagram-copy -- --venue <slug> --guest <guest-uuid> [--reps N]',
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

  const log = createRunLog({
    name: 'tac469-instagram-channel-copy',
    meta: {
      arm: 'both',
      promptVersion: PROMPT_VERSION,
      venue: venue.slug,
      guestId: args.guest,
      reps: args.reps,
      scenarios: SCENARIOS.map((s) => s.id),
      // Every generation is temperature 0.7, so one body is a draw and not a
      // property of the prompt. Reps exist so a rate can be read at all.
      note: 'generate-only; nothing sent, nothing written to the database',
    },
  })
  console.log(`run log: ${log.path}`)
  console.log(`${SCENARIOS.length} scenarios x ${ARMS.length} arms x ${args.reps} reps\n`)

  const trace = startAgentTrace({
    name: 'measurement.instagram-channel-copy',
    agentRunId: randomUUID(),
    metadata: { venueId: venue.id, guestId: args.guest },
  })

  for (const scenario of SCENARIOS) {
    for (let rep = 0; rep < args.reps; rep += 1) {
      // Built once per rep and reused across BOTH arms, so the two differ in
      // the channel and nothing else — same retrieval, same history, same
      // recognition snapshot.
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
          channel: 'instagram',
        },
      })

      const classification = await classifyStage(ctx)
      ctx.classification = classification
      ctx.corpus = await retrieveCorpusStage(ctx)
      ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
        ? await retrieveKnowledgeStage(ctx, classification.category, scenario.body)
        : []

      for (const arm of ARMS) {
        ctx.conversationChannel = arm
        const generated = await generateStage(ctx, classification.category)
        const body = generated.status === 'success' ? generated.result.body : null
        const matches = body ? findChannelLanguage(body) : []

        log.appendUnit({
          scenarioId: scenario.id,
          inbound: scenario.body,
          rep,
          arm,
          category: classification.category,
          status: generated.status,
          body,
          voiceFidelity: generated.status === 'success' ? generated.result.voiceFidelity : null,
          // The first run could not say why `regeneration_triggered` fired so
          // often, because it recorded neither of these. attempts > 1 IS that
          // event; attemptScores shows whether the first draft was under the
          // 0.7 regen floor or whether something else (a dash, self-talk)
          // forced the retry.
          attempts: generated.status === 'success' ? generated.result.attempts : null,
          attemptScores: generated.status === 'success' ? generated.result.attemptScores : null,
          phoneClaims: matches.filter((m) => m.kind === 'phone_claim'),
          instagramIdioms: matches.filter((m) => m.kind === 'instagram_idiom'),
        })

        const claims = matches.filter((m) => m.kind === 'phone_claim')
        const mark = generated.status !== 'success' ? '·' : claims.length > 0 ? '✗' : '✓'
        console.log(
          `${mark} ${scenario.id} rep${rep} ${arm.padEnd(9)} ${
            generated.status !== 'success'
              ? `(${generated.status})`
              : claims.length > 0
                ? claims.map((c) => `"${c.phrase}"`).join(', ')
                : ''
          }`,
        )
      }
    }
  }

  await trace.flushAsync()
  console.log(`\nDone. Read the run log and count by arm: ${log.path}`)
  console.log('A phone claim in the instagram arm is the finding; the text arm is the control.')
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
