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
 * Inbounds chosen to PULL FOR channel language rather than sample typical
 * traffic. A measurement that mostly asks about opening hours would report a
 * clean run and prove very little: the copy only matters on a turn where the
 * model has some reason to mention how the guest reaches the venue.
 *
 * Each carries why it is here, so a later reader can tell a deliberate probe
 * from a scenario someone liked the sound of.
 */
const SCENARIOS: ReadonlyArray<{ id: string; body: string; why: string }> = [
  {
    id: 'reach-you',
    body: "what's the best way to reach you if i have a question?",
    why: 'Asks directly for a channel. The most likely single turn to produce "text us".',
  },
  {
    id: 'order-ahead',
    body: 'can i order ahead for tomorrow morning?',
    why: 'R34 says defer to how the venue takes orders; the deferral is where a channel gets named.',
  },
  {
    id: 'heads-up',
    body: "i'll come by around 8, anything you need from me?",
    why: 'The heads-up examples in # Commitments carry "message me" on Instagram and "text me" on SMS.',
  },
  {
    id: 'hold-request',
    body: 'can you hold a croissant for me till 9?',
    why: 'A hold is refused at Le Mil\'s, and the refusal often offers another way to arrange it.',
  },
  {
    id: 'greeting',
    body: 'hi!',
    why: 'The first-touch opener renders here; its Instagram variant drops "on this number".',
  },
  {
    id: 'save-contact',
    body: 'should i save you in my contacts?',
    why: 'R32 territory. On SMS "save this number" is right; on Instagram there is no number to save.',
  },
  {
    id: 'missed-reply',
    body: "sorry, missed your last message. what did you say?",
    why: 'Invites the model to describe the medium it is speaking on.',
  },
  {
    id: 'complaint',
    body: 'the cortado i got this morning was cold',
    why: 'comp_complaint suppresses the intentions block and takes a different category path.',
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
