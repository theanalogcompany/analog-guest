// TAC-544: once the agent knows a guest's name, how often does it use it?
//
// GENERATE-ONLY. Nothing is sent, and the only database writes possible are the
// ones buildRuntimeContext makes on its own: computeGuestState persists a
// `guest_states` row when a guest's recognition band actually changes. Context
// is built ONCE for the whole run and cloned per conversation, so there is
// exactly one opportunity for that write rather than forty. The run reports the
// row count before and after.
//
// THE BARS ARE PRE-REGISTERED on the ticket, before this was ever run, and a
// breach is reported as it came out rather than re-cut:
//   - 0 conversations where the name appears in TWO CONSECUTIVE replies.
//   - at most 1 name use per conversation.
//   - 0 named self-introductions, 0 third-person venue references, and replies
//     still answer the question (any that dodge are reported).
//
// CONTROL FIRST, then treatment, as the ticket asks. `control` is the SHIPPED
// prompt with R38 sliced out; `treatment` is the shipped prompt untouched.
// Slicing rather than injecting is right here because the rule IS shipped, so
// the treatment arm needs no surgery at all and cannot drift from production.
// The slice is guarded to match exactly once, and a unit whose slice did not
// change the prompt is INVALID rather than recorded.
//
// WHAT IS MATCHED BETWEEN THE ARMS, AND WHAT CANNOT BE. The guest, the venue,
// the four guest turns and their order are identical. The AGENT REPLIES
// necessarily diverge from turn 2 onward, because each reply enters the history
// the next turn is generated against. That is not a flaw to engineer away: the
// metric is a property of a SEQUENCE of replies ("two in a row"), so a
// byte-identical-prompt comparison past turn 1 would be measuring a different
// question. Turn 1's two prompts differ in exactly the rule.
//
// WHY IT COMPOSES THE PROMPT AND CALLS generateObject DIRECTLY rather than
// going through generateMessage, which is the TAC-513 harness's reasoning and
// holds unchanged here. There is no parameter that can vary SYSTEM_TEMPLATE per
// arm, so editing the composed system prompt is the only injection point that
// leaves everything else identical. It also removes a confound: generateMessage
// runs a regen loop and returns the LAST attempt rather than the best, so a
// rate measured through it mixes the rule's effect with the loop's.
//
// WHAT THAT COSTS, stated rather than left to be discovered: this measures
// GENERATION. In production a reply also passes the approval gate, and a name
// used twice is not something any gate holds, so for THIS defect generation is
// where it is decided and nothing downstream would catch it. The device gate on
// the ticket is what covers the rest.
//
// REAL HISTORY IS KEPT, not cleared. "A guest whose first name is on record and
// who has prior messages" is the shape the ticket names, and that history is
// what puts `- First name: ...` in the guest block on every turn, which is the
// cause. It also means the loaded tail may already contain name-heavy replies
// the model could imitate. That is the live situation, it is identical in both
// arms, and the tail's own name use is reported so it can be read.
//
// TELEMETRY: run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL
// unset so the stages' events go inert.

import { randomUUID } from 'node:crypto'
import { generateObject } from 'ai'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from '@/lib/agent/stages'
import { getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
} from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import type {
  KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import {
  classifyGuestName,
  consecutiveNamePairs,
  countNameUses,
  looksLikeDodge,
} from './guest-name-language'
import type { GuestTurnShape } from './guest-name-language'
import { classifySpeakerIdentity } from './speaker-identity-language'
import { createRunLog } from './run-log'

/**
 * The rule under test, transcribed from the ticket rather than imported from
 * SYSTEM_TEMPLATE. Importing it would make the slice agree with whatever the
 * template says, including a reworded version, so a run could silently measure
 * something other than the approved wording. A mismatch is a startup failure.
 */
const R38 =
  "- Use the guest's name sparingly, the way a good barista does: when you greet them or just after they tell you it, and not again in the same conversation. Never use it in two replies in a row."

const ARMS = ['control', 'treatment'] as const
type Arm = (typeof ARMS)[number]

/** The four phrasing shapes the ticket asks to mix. */
type Shape = GuestTurnShape

const SHAPES: readonly Shape[] = ['small_talk', 'hours', 'menu', 'heading_over']

/**
 * Five phrasings per shape, so the twenty conversations do not repeat one
 * sentence twenty times. Drawn to look like the incident thread: lowercase,
 * unpunctuated, short.
 */
const PHRASINGS: Record<Shape, readonly string[]> = {
  small_talk: [
    "how's it going over there",
    'hey! how are you today',
    'happy friday',
    'busy in there today?',
    "what's new with you",
  ],
  hours: [
    'what time do you close',
    'you open tomorrow?',
    'are you open right now',
    'when do you open in the morning',
    'still open?',
  ],
  menu: [
    'do you have oat milk',
    "what's the blossom tonic",
    'any cold drinks?',
    'do you do decaf',
    "what's good today",
  ],
  heading_over: [
    'heading over in 10',
    'omw',
    'on my way, be there soon',
    'gonna swing by after work',
    'coming in about 20 min',
  ],
}

interface Conversation {
  id: string
  /** Four guest turns, in order. */
  turns: { shape: Shape; body: string }[]
}

/**
 * TWENTY CONVERSATIONS, each with all four shapes, ROTATED so that each shape
 * lands in each position exactly five times. Position matters: turn 1 is the
 * turn a greeting is licensed on (R14), and the rule explicitly permits the
 * name there, so a design that always put small talk first would measure the
 * permitted case five times more often than the forbidden ones.
 */
function buildConversations(): Conversation[] {
  const out: Conversation[] = []
  for (let i = 0; i < 20; i += 1) {
    const rotation = i % 4
    const variant = Math.floor(i / 4) // 0..4, picks the phrasing
    const turns = SHAPES.map((_, pos) => {
      const shape = SHAPES[(pos + rotation) % 4] as Shape
      const options = PHRASINGS[shape]
      return { shape, body: options[variant % options.length] as string }
    })
    out.push({ id: `c${String(i + 1).padStart(2, '0')}`, turns })
  }
  return out
}

interface TurnRecord extends Record<string, unknown> {
  conversationId: string
  arm: Arm
  turn: number
  shape: Shape
  guestBody: string
  category: string | null
  reply: string | null
  nameUses: number
  nameMatches: string[]
  namedSelfIntro: boolean
  namedSelfIntroMatch: string | null
  thirdPersonVenue: boolean
  thirdPersonVenueMatch: string | null
  dodgeCandidate: boolean
  calls: number
  error: string | null
}

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const repsArg = Number(process.env.MEASURE_CONVERSATIONS ?? '20')

  const db = createAdminClient()

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, timezone')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  // The roster and venue names the two borrowed detectors match against, read
  // from the venue's own config rather than hardcoded (the TAC-541 precedent),
  // so a new barista is covered without editing this file.
  const { data: cfg } = await db
    .from('venue_configs')
    .select('venue_info')
    .eq('venue_id', venue.id)
    .single()
  const info = (cfg?.venue_info ?? {}) as { staff?: string[] }
  const personNames = [
    ...(info.staff ?? []).map(
      (line) => (line.split(/[—–-]/)[0] ?? '').trim().split(/\s+/)[0] ?? '',
    ),
    'Himanshu',
    'Milana',
  ].filter((n) => n.length > 2)
  const venueNames = ["Le Mil's", 'Le Mils', 'LeMils'] as const

  // THE GUEST: a first name on record AND real prior messages, which is the
  // @jaipalsilla shape the ticket names. Selected as the non-synthetic named
  // guest with the most messages, so the choice is derived rather than pasted
  // as an id, and reported below so a run says which guest it used.
  const { data: candidates } = await db
    .from('guests')
    .select('id, first_name, phone_number, instagram_scoped_id')
    .eq('venue_id', venue.id)
    .not('first_name', 'is', null)
  const named = (candidates ?? []).filter(
    (g) =>
      !String(g.first_name ?? '')
        .toLowerCase()
        .startsWith('synthetic'),
  )
  let guest: (typeof named)[number] | null = null
  let guestMessageCount = 0
  for (const g of named) {
    const { count } = await db
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('guest_id', g.id)
    if ((count ?? 0) > guestMessageCount) {
      guestMessageCount = count ?? 0
      guest = g
    }
  }
  if (!guest)
    throw new Error('no non-synthetic guest with a first_name at this venue')
  const firstName = String(guest.first_name)
  const channel: 'text' | 'instagram' = guest.phone_number
    ? 'text'
    : 'instagram'

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const startedAt = new Date()
  const log = createRunLog({
    name: 'tac544-guest-name-frequency',
    meta: {
      arm: 'both',
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      channel,
      guestFirstName: firstName,
      guestMessageCount,
      ruleUnderTest: R38,
      conversations: repsArg,
      runHourLocal: startedAt.toLocaleString('en-US', {
        timeZone: venue.timezone ?? 'UTC',
      }),
      statesBefore,
    },
  })

  console.log(
    `[tac544] venue ${venueSlug} | guest "${firstName}" (${channel}, ${guestMessageCount} messages)`,
  )
  console.log(
    `[tac544] prompt ${PROMPT_VERSION} | run started ${startedAt.toISOString()}`,
  )
  console.log(
    `[tac544] venue-local hour: ${startedAt.toLocaleString('en-US', { timeZone: venue.timezone ?? 'UTC' })}`,
  )
  console.log(`[tac544] guest_states rows before: ${statesBefore}`)
  console.log(`[tac544] run log: ${log.path}\n`)

  const trace = startAgentTrace({
    name: 'tac544-measure',
    agentRunId: randomUUID(),
  })

  const now = new Date()
  // ONE context build for the whole run. Cloned per conversation below, so
  // computeGuestState has exactly one opportunity to write.
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: guest.id,
    venueId: venue.id,
    trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `tac544-probe-${randomUUID()}`,
      body: PHRASINGS.small_talk[0] as string,
      receivedAt: now,
      channel,
      referralSource: null,
    },
  })

  // The loaded history's own name use, reported so the tail the model may
  // imitate is visible rather than assumed clean.
  const historyTail = baseCtx.recentMessages.slice(-6)
  const tailNameUses = historyTail
    .filter((m) => m.direction === 'outbound')
    .reduce((n, m) => n + countNameUses(m.body, firstName).count, 0)
  console.log(
    `[tac544] loaded history: ${baseCtx.recentMessages.length} messages; the last ${historyTail.length} carry ${tailNameUses} name use(s) in outbound replies\n`,
  )

  // STARTUP GUARD. The slice must find the rule exactly once in a composed
  // prompt, or every control unit would be byte-identical to its treatment and
  // the run would measure nothing while reporting cleanly. Checked against a
  // real composed prompt before any model call is spent.
  {
    const probe = composePrompt({
      category: 'reply',
      persona: baseCtx.venue.brandPersona,
      venueInfo: baseCtx.venue.venueInfo,
      ragChunks: [],
      knowledgeChunks: undefined,
      runtime: buildAiRuntime(baseCtx),
      channel: baseCtx.conversationChannel,
    })
    const hits = probe.systemPrompt.split(R38).length - 1
    if (hits !== 1) {
      console.error(
        `✗ the rule under test appears ${hits} times in a composed system prompt, expected exactly 1.\n` +
          '  Either it is not shipped (run this on a branch where it is), or its wording has drifted\n' +
          '  from the approved text transcribed at the top of this file. Refusing to run.',
      )
      process.exit(1)
    }
  }

  const conversations = buildConversations().slice(0, repsArg)
  const records: TurnRecord[] = []

  for (const conv of conversations) {
    for (const arm of ARMS) {
      // A fresh shallow copy per (conversation, arm), with its own history
      // array so appends cannot leak between conversations or arms.
      const ctx = {
        ...baseCtx,
        recentMessages: [...baseCtx.recentMessages],
      } as typeof baseCtx

      for (let t = 0; t < conv.turns.length; t += 1) {
        const turn = conv.turns[t] as { shape: Shape; body: string }
        const receivedAt = new Date(now.getTime() + t * 60_000)
        ctx.currentMessage = {
          id: randomUUID(),
          providerMessageId: `tac544-${conv.id}-${arm}-t${t}`,
          body: turn.body,
          receivedAt,
          channel,
          referralSource: null,
        }

        let category: string | null = null
        let reply: string | null = null
        let error: string | null = null
        let calls = 0

        try {
          // classifyStage returns a Classification directly and THROWS on a
          // failure it cannot absorb, so the surrounding try is what records a
          // classifier fault as a failed unit.
          const classification = await classifyStage(ctx)
          {
            ctx.classification = classification
            category = classification.category
            ctx.corpus = await retrieveCorpusStage(ctx)
            ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
              ? await retrieveKnowledgeStage(
                  ctx,
                  classification.category,
                  turn.body,
                )
              : []

            const ragChunks: AiVoiceCorpusChunk[] = (ctx.corpus ?? []).map(
              (c) => ({
                id: c.id,
                text: c.text,
                sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
                relevanceScore: c.similarity,
              }),
            )
            const knowledgeChunks: AiKnowledgeCorpusChunk[] | undefined =
              ctx.knowledgeCorpus === null
                ? undefined
                : ctx.knowledgeCorpus.map((c) => ({
                    id: c.id,
                    text: c.text,
                    sourceType: c.sourceType,
                    primaryTags: c.primaryTags,
                    secondaryTags: c.secondaryTags,
                    relevanceScore: c.similarity,
                  }))

            const composed = composePrompt({
              category: classification.category,
              persona: ctx.venue.brandPersona,
              venueInfo: ctx.venue.venueInfo,
              ragChunks,
              knowledgeChunks,
              runtime: buildAiRuntime(ctx),
              channel: ctx.conversationChannel,
            })

            // THE ONE DIFFERENCE BETWEEN THE ARMS.
            let systemBody = composed.systemPrompt
            if (arm === 'control') {
              const stripped = systemBody.replace(`${R38}\n`, '')
              if (stripped === systemBody) {
                error = 'control slice did not change the prompt'
              } else {
                systemBody = stripped
              }
            }

            if (error === null) {
              // v1.80.0 schema diet: the system prompt is composePrompt's
              // output verbatim; the voice-fidelity instruction it used to
              // append is gone.
              const system = systemBody

              // A BOUNDED RE-ASK on a schema failure, with a BYTE-IDENTICAL
              // prompt every attempt. This is not the regen loop: no feedback,
              // no sticky constraints. It absorbs the voiceFidelity-scale
              // failure above, which has nothing to do with either arm.
              for (let attempt = 0; attempt < 4; attempt += 1) {
                calls += 1
                try {
                  const { object } = await generateObject({
                    model: getGenerationModel(),
                    system,
                    prompt: composed.userPrompt,
                    schema: GeneratedMessageSchema,
                    temperature: 0.7,
                    maxOutputTokens: MAX_OUTPUT_TOKENS,
                  })
                  reply = object.body
                  error = null
                  break
                } catch (e) {
                  error = e instanceof Error ? e.message : String(e)
                }
              }
            }
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
        }

        const verdict =
          reply === null
            ? null
            : classifyGuestName(reply, { firstName, venueNames })
        const identity =
          reply === null
            ? null
            : classifySpeakerIdentity(reply, { personNames, venueNames })

        const record: TurnRecord = {
          conversationId: conv.id,
          arm,
          turn: t + 1,
          shape: turn.shape,
          guestBody: turn.body,
          category,
          reply,
          nameUses: verdict?.nameUses ?? 0,
          nameMatches: verdict?.nameMatches ?? [],
          namedSelfIntro: identity?.namedSelfIntro ?? false,
          namedSelfIntroMatch: identity?.namedSelfIntroMatch ?? null,
          thirdPersonVenue: verdict?.thirdPersonVenue ?? false,
          thirdPersonVenueMatch: verdict?.thirdPersonVenueMatch ?? null,
          dodgeCandidate:
            reply === null
              ? false
              : looksLikeDodge(turn.shape, turn.body, reply),
          calls,
          error,
        }
        records.push(record)
        log.appendUnit(record)

        if (reply === null) {
          console.log(`  ${conv.id} ${arm} t${t + 1} FAILED: ${error}`)
          break
        }

        // The reply enters the history the next turn is generated against.
        ctx.recentMessages.push(
          {
            direction: 'inbound',
            body: turn.body,
            createdAt: receivedAt,
            delivery: 'delivered',
          },
          {
            direction: 'outbound',
            body: reply,
            createdAt: new Date(receivedAt.getTime() + 30_000),
            delivery: 'delivered',
          },
        )
      }
      const armRecords = records.filter(
        (r) => r.conversationId === conv.id && r.arm === arm,
      )
      const uses = armRecords.reduce((n, r) => n + r.nameUses, 0)
      console.log(
        `  ${conv.id} ${arm.padEnd(9)} turns=${armRecords.length} nameUses=${uses} ` +
          `pairs=${consecutiveNamePairs(
            armRecords.map((r) => r.reply ?? ''),
            firstName,
          )}`,
      )
    }
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  report(records, conversations, firstName, {
    statesBefore: statesBefore ?? 0,
    statesAfter: statesAfter ?? 0,
    logPath: log.path,
    startedAt,
    timezone: venue.timezone ?? 'UTC',
    tailNameUses,
  })
}

function report(
  records: TurnRecord[],
  conversations: Conversation[],
  firstName: string,
  meta: {
    statesBefore: number
    statesAfter: number
    logPath: string
    startedAt: Date
    timezone: string
    tailNameUses: number
  },
): void {
  const line = '='.repeat(74)
  console.log(`\n${line}\nTAC-544 — guest name frequency\n${line}`)
  console.log(`run started      ${meta.startedAt.toISOString()}`)
  console.log(
    `venue-local      ${meta.startedAt.toLocaleString('en-US', { timeZone: meta.timezone })}`,
  )
  console.log(`prompt version   ${PROMPT_VERSION}`)
  console.log(`guest first name ${firstName}`)
  console.log(
    `history tail     ${meta.tailNameUses} name use(s) in the loaded outbound tail`,
  )
  console.log(`run log          ${meta.logPath}`)

  // A conversation counts only when BOTH arms produced all four replies. A
  // failed call is not a result (CLAUDE.md), and an unpaired conversation would
  // make the two distributions describe different populations.
  const complete = new Set<string>()
  for (const conv of conversations) {
    const ok = ARMS.every((arm) => {
      const rs = records.filter(
        (r) => r.conversationId === conv.id && r.arm === arm,
      )
      return (
        rs.length === conv.turns.length && rs.every((r) => r.reply !== null)
      )
    })
    if (ok) complete.add(conv.id)
  }
  const dropped = conversations
    .filter((c) => !complete.has(c.id))
    .map((c) => c.id)
  console.log(
    `conversations    ${complete.size} paired and complete of ${conversations.length}`,
  )
  if (dropped.length > 0) {
    console.log(
      `  EXCLUDED (a call failed in one or both arms): ${dropped.join(', ')}`,
    )
  }

  for (const arm of ARMS) {
    const rs = records.filter(
      (r) => complete.has(r.conversationId) && r.arm === arm,
    )
    const byConv = new Map<string, TurnRecord[]>()
    for (const r of rs) {
      const list = byConv.get(r.conversationId) ?? []
      list.push(r)
      byConv.set(r.conversationId, list)
    }

    const perConv = [...byConv.entries()].map(([id, turns]) => ({
      id,
      uses: turns.reduce((n, t) => n + t.nameUses, 0),
      pairs: consecutiveNamePairs(
        [...turns].sort((a, b) => a.turn - b.turn).map((t) => t.reply ?? ''),
        firstName,
      ),
      turns,
    }))

    const dist = new Map<number, number>()
    for (const c of perConv) dist.set(c.uses, (dist.get(c.uses) ?? 0) + 1)
    const repliesWithName = rs.filter((r) => r.nameUses > 0).length

    console.log(`\n${'-'.repeat(74)}\nARM: ${arm}\n${'-'.repeat(74)}`)
    console.log(`replies                      ${rs.length}`)
    console.log(
      `replies using the name       ${repliesWithName} (${((100 * repliesWithName) / Math.max(1, rs.length)).toFixed(1)}%)`,
    )
    console.log('name uses per conversation   distribution:')
    for (const uses of [...dist.keys()].sort((a, b) => a - b)) {
      console.log(
        `    ${uses} use(s): ${'#'.repeat(dist.get(uses) ?? 0)} ${dist.get(uses)} conversation(s)`,
      )
    }
    console.log(
      `conversations w/ 2 consecutive named replies  ${perConv.filter((c) => c.pairs > 0).length}`,
    )
    console.log(
      `conversations with >1 name use               ${perConv.filter((c) => c.uses > 1).length}`,
    )
    console.log(
      `named self-introductions                    ${rs.filter((r) => r.namedSelfIntro).length}`,
    )
    console.log(
      `third-person venue references               ${rs.filter((r) => r.thirdPersonVenue).length}`,
    )
    console.log(
      `dodge candidates (read these)               ${rs.filter((r) => r.dodgeCandidate).length}`,
    )

    const cats = new Map<string, number>()
    for (const r of rs)
      cats.set(r.category ?? 'null', (cats.get(r.category ?? 'null') ?? 0) + 1)
    console.log(
      `categories                   ${[...cats.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c}=${n}`)
        .join(' ')}`,
    )

    if (arm === 'treatment') {
      console.log('\nPRE-REGISTERED BARS:')
      const b1 = perConv.filter((c) => c.pairs > 0).length
      const b2 = perConv.filter((c) => c.uses > 1).length
      const b3 = rs.filter((r) => r.namedSelfIntro).length
      const b4 = rs.filter((r) => r.thirdPersonVenue).length
      console.log(
        `  ${b1 === 0 ? 'PASS' : 'FAIL'}  0 conversations with the name in two consecutive replies  (got ${b1})`,
      )
      console.log(
        `  ${b2 === 0 ? 'PASS' : 'FAIL'}  at most 1 name use per conversation                       (got ${b2} over)`,
      )
      console.log(
        `  ${b3 === 0 ? 'PASS' : 'FAIL'}  0 named self-introductions                               (got ${b3})`,
      )
      console.log(
        `  ${b4 === 0 ? 'PASS' : 'FAIL'}  0 third-person venue references                          (got ${b4})`,
      )
    }

    // VERBATIM BODIES FOR EVERY BREACH, which the ticket asks for by name.
    const breaches = perConv.filter((c) => c.pairs > 0 || c.uses > 1)
    if (breaches.length > 0) {
      console.log(`\n  BREACHES in ${arm}, verbatim:`)
      for (const c of breaches) {
        console.log(
          `  --- ${c.id} (uses=${c.uses}, consecutive pairs=${c.pairs}) ---`,
        )
        for (const t of [...c.turns].sort((a, b) => a.turn - b.turn)) {
          console.log(`    t${t.turn} [${t.shape}] guest: ${t.guestBody}`)
          console.log(
            `         agent (${t.nameUses} name use): ${JSON.stringify(t.reply)}`,
          )
        }
      }
    }

    const others = rs.filter(
      (r) => r.namedSelfIntro || r.thirdPersonVenue || r.dodgeCandidate,
    )
    if (others.length > 0) {
      console.log(
        `\n  SELF-INTRO / THIRD-PERSON / DODGE CANDIDATES in ${arm}, verbatim:`,
      )
      for (const r of others) {
        const flags = [
          r.namedSelfIntro ? `selfIntro(${r.namedSelfIntroMatch})` : null,
          r.thirdPersonVenue ? `thirdPerson(${r.thirdPersonVenueMatch})` : null,
          r.dodgeCandidate ? 'dodgeCandidate' : null,
        ].filter(Boolean)
        console.log(
          `    ${r.conversationId} t${r.turn} [${r.shape}] ${flags.join(' ')}`,
        )
        console.log(`         guest: ${r.guestBody}`)
        console.log(`         agent: ${JSON.stringify(r.reply)}`)
      }
    }
  }

  console.log(`\n${line}`)
  console.log(
    `guest_states rows: before ${meta.statesBefore}, after ${meta.statesAfter}`,
  )
  if (meta.statesBefore !== meta.statesAfter) {
    console.log(
      `  NOTE: the count moved. buildRuntimeContext runs computeGuestState, which persists a row\n` +
        `  when a recognition band changes. That is the one write this run can make.`,
    )
  } else {
    console.log('  Unchanged: nothing was written.')
  }
  const failed = records.filter((r) => r.error !== null).length
  console.log(`failed units: ${failed} of ${records.length} recorded turns`)
  console.log(line)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
