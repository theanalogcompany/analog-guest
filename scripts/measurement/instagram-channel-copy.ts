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
  verifyGroundingStage,
} from '@/lib/agent/stages'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type { MessageChannel } from '@/lib/schemas/message-channel'
import { createRunLog } from './run-log'
import { findChannelLanguage } from './channel-language'

/**
 * REBUILT THREE TIMES, and this set is built to survive the next fix.
 *
 * Round 1 (control 1/24): most scenarios were answerable in terms of POLICY,
 * PRESENCE or CONTENT, so the model never had reason to name a channel.
 * Round 2 (control 3/24): the channel was the answer, but "right here works"
 * is channel-neutral and the venue's public email answered the rest.
 * Round 3 (control 8/24, VALID): defeated both escapes and the bar was met.
 * Round 4 (control 5/24): the bar was missed — because the FIX worked. A
 * knowledge entry stating the venue has no public phone number made
 * `phone-number-ask` and `call-instead` answer "no public number" correctly on
 * BOTH arms, spending 4 of round 3's 8 control claims permanently.
 *
 * That is the lesson this set is built on. **A scenario whose answer depends on
 * a venue FACT can be spent by stating that fact**, and twice now a round of
 * scenario work has been invalidated by a fix landing underneath it. The class
 * that cannot be spent is PURE CHANNEL SELF-REFERENCE: turns whose answer is
 * about the conversation the guest is already in.
 *
 * "This number", "text me here", "keep texting" are TRUE on SMS and FALSE on
 * Instagram, and no venue fact can resolve them, because they are not about the
 * venue at all — they are about the medium. Those are exactly the five claims
 * that survived round 4 (`no-email`, `friend-not-on-here`,
 * `how-will-you-tell-me`, `heads-up-how`), and every scenario below is built on
 * that shape.
 *
 * What is deliberately NOT here: anything asking whether a phone number, an
 * email or any other venue detail exists. Those are now answered by config, and
 * answering them correctly is the point of the config.
 */
const SCENARIOS: ReadonlyArray<{ id: string; body: string; why: string }> = [
  {
    id: 'reply-here',
    body: 'if i message you here will you actually see it?',
    why: 'Asks about THIS conversation. No venue fact resolves it; the answer is about the medium. SMS truthfully says "this number", Instagram must not.',
  },
  {
    id: 'how-will-you-tell-me',
    body: 'if i order beans to collect, how will you let me know when they are in?',
    why: 'Kept: fired in rounds 3 and 4. The venue has to reach the GUEST, and the route is the answer. Survived the knowledge entry because it is not about whether a number exists.',
  },
  {
    id: 'heads-up-how',
    body: "how do i let you know when i'm on my way?",
    why: 'Kept: fired in rounds 3 and 4. Targets the heads-up examples in # Commitments, which carry an explicit channel variant.',
  },
  {
    id: 'no-email',
    body: "i don't really use email. what's the best way to get hold of you?",
    why: 'Kept: fired in rounds 3 and 4. Rules out the email by premise, leaving only the channel.',
  },
  {
    id: 'friend-not-on-here',
    body: "my friend wants to ask about beans for her office but she's not on instagram. how does she reach you?",
    why: 'Kept: fired in round 4. Third party (defeats "right here") who is also off the current channel.',
  },
  {
    id: 'keep-talking-here',
    body: 'is it easier to keep going here or move somewhere else?',
    why: 'Asks the model to compare the current medium against alternatives, which is R5 territory. Each arm names the OTHER channel in its list.',
  },
  {
    id: 'reply-speed',
    body: 'how quickly do you usually reply here?',
    why: 'Forces a statement about the medium itself. "We usually reply to texts within the hour" is true on SMS and false on Instagram.',
  },
  {
    id: 'seen-it',
    body: "did you get my last one? it didn't look like it sent",
    why: 'Delivery mechanics of the current channel. Invites the model to describe how messages arrive, which differs by channel.',
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

        // THE BACKSTOP IN THE LOOP. Without this the run measures GENERATION,
        // not what ships: in production a flagged reply is queued for an
        // operator rather than sent, so a claim the backstop catches never
        // reaches a guest. Every earlier round is therefore an upper bound.
        // This is the same call the gate makes, so `flagged` here is what the
        // gate would see. It is a second model call per generation and roughly
        // doubles the run's cost, which is the price of measuring the question
        // the pre-flight is actually asking.
        const grounding =
          generated.status === 'success'
            ? await verifyGroundingStage(ctx, generated.result)
            : null

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
          // skipped | clean | flagged | truncated. `flagged` means production
          // would have queued this rather than sent it.
          groundingStatus: grounding?.status ?? null,
          groundingClaims: grounding?.status === 'flagged' ? grounding.claims : [],
          phoneClaims: matches.filter((m) => m.kind === 'phone_claim'),
          instagramIdioms: matches.filter((m) => m.kind === 'instagram_idiom'),
        })

        const claims = matches.filter((m) => m.kind === 'phone_claim')
        const held = grounding?.status === 'flagged' ? ' [backstop HELD]' : ''
        const mark = generated.status !== 'success' ? '·' : claims.length > 0 ? '✗' : '✓'
        console.log(
          `${mark} ${scenario.id} rep${rep} ${arm.padEnd(9)} ${
            generated.status !== 'success'
              ? `(${generated.status})`
              : claims.length > 0
                ? claims.map((c) => `"${c.phrase}"`).join(', ')
                : ''
          }${held}`,
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
