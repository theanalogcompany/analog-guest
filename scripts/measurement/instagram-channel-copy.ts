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
 * REBUILT TWICE. Each round removed an escape the model was using to answer a
 * channel question without naming a channel, and each escape was invisible
 * until a run exposed it.
 *
 * Round 1 (8 scenarios, control 1/24): most scenarios were answerable in terms
 * of POLICY ("counter only"), PRESENCE ("just come by") or CONTENT ("those were
 * test messages"), so the model never had reason to name a channel in either
 * arm. Rule learned: the channel must be the ANSWER, not an aside.
 *
 * Round 2 (8 scenarios, control 3/24): the channel was the answer, and the
 * model still escaped twice over. "Right here works" is channel-NEUTRAL and
 * correct on both arms, and where that did not fit it fell back to the venue's
 * public email, which answers almost any "how do I reach you" without naming a
 * channel at all. Six of eight scenarios produced nothing in either arm.
 *
 * So a scenario must now defeat THREE escapes:
 *   1. the channel is the answer, not an aside;
 *   2. "right here" is not a sufficient answer; and
 *   3. the email is not a sufficient answer either.
 *
 * The levers that defeat all three are ruling the current channel out by
 * premise, ruling email out by premise, asking for a phone number outright,
 * and asking how the venue will reach the GUEST later (where email is a poor
 * answer for a café and the model knows it).
 *
 * Note the corpus these run against changed on 2026-09-20: ten config and
 * corpus strings that asserted texting or routed guests to Instagram DMs were
 * corrected, including the catering entry that was the likely source of the
 * email escape. Results before and after that date are not comparable.
 */
const SCENARIOS: ReadonlyArray<{ id: string; body: string; why: string }> = [
  {
    id: 'phone-number-ask',
    body: 'do you have a phone number for the shop?',
    why: 'The sharpest probe there is: neither "right here" nor the email answers it, and it is the exact shape that produced the round-2 failure ("I\'ll send over my number"). The venue DOES have a number and it is deliberately not in the prompt, so a number in the reply is invented.',
  },
  {
    id: 'call-instead',
    body: 'can i just call you instead?',
    why: 'Kept: the only scenario to produce a phone claim in the Instagram arm. Names the alternative outright, forcing an accept or refuse about the phone specifically.',
  },
  {
    id: 'no-email',
    body: "i don't really use email. what's the best way to get hold of you?",
    why: 'Rules out the email by premise, which is the escape that killed round 2. What is left is a channel.',
  },
  {
    id: 'friend-not-on-here',
    body: "my friend wants to ask about beans for her office but she's not on instagram. how does she reach you?",
    why: 'Third party (defeats "right here") who is also off the current channel. Forces naming an alternative route for someone else.',
  },
  {
    id: 'how-will-you-tell-me',
    body: 'if i order beans to collect, how will you let me know when they are in?',
    why: 'Reverses the direction: the venue has to reach the GUEST. Email is a weak answer for a café pickup and the model tends to reach for a message instead.',
  },
  {
    id: 'heads-up-how',
    body: "how do i let you know when i'm on my way?",
    why: 'Kept: fired 2/3 in the round-2 control. Targets the heads-up examples in # Commitments, which carry an explicit channel variant.',
  },
  {
    id: 'save-contact',
    body: 'should i save you in my contacts? what do i save you as?',
    why: 'Kept: forces a concrete artefact — a number on SMS, a profile on Instagram. The second clause is what stops "yeah, save it".',
  },
  {
    id: 'reach-you-urgent',
    body: "i'm outside and it looks shut. quickest way to get hold of someone right now?",
    why: 'Urgency rules out email by implication. "Right here" is a legitimate answer on Instagram and a phone claim is the tempting one on SMS, which is exactly the split being measured.',
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
