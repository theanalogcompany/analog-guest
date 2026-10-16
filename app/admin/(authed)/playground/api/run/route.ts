import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import {
  V2_EFFORT_REQUESTS,
  V2_MODEL_KEYS,
  V2_PLAYGROUND_MAX_OUTPUT_TOKENS,
} from '@/lib/ai/v2/model-call'
import { createAdminClient } from '@/lib/db/admin'
import {
  GuestProfileSchema,
  InteractionMemorySchema,
} from '@/lib/relationship/profile'
import { DEFAULT_RELATIONSHIP_GRAPH } from '@/lib/relationship/default-graph'
import { parseRelationshipGraph } from '@/lib/relationship/schema'
import { runTurn } from '@/lib/relationship/run-turn'
import { GOLDEN_FOLLOWUP_TRIGGERS } from '@/lib/schemas/golden'
import {
  DeclaredMediaSchema,
  TemplateBlocksSchema,
} from '@/lib/schemas/playground'
import type { RunResponseBody } from '../../_lib/types'
import {
  draftV1ForReplay,
  draftV1ForSandbox,
  draftV1FollowupForSandbox,
  SANDBOX_SLOTS,
  type V1ArmOutcome,
} from './v1-arm'

// POST /admin/playground/api/run - one inbound exchange through the whole v2
// pipeline via runTurn. DRY RUN: reads prod data, calls real models, writes
// nothing (run-turn.ts header). The response carries the full TurnTrace plus
// the active graph's state menu, which the trace itself does not hold and the
// inspector's state-override dropdown needs.
//
// No PostHog, no Langfuse spans of its own. The operator is staring at the
// trace - they ARE the observability surface, same posture as the voices
// regenerate route.

/**
 * The link the v1 arm is given for a photo uploaded in the playground, which
 * has no link of its own.
 *
 * `.invalid` IS RESERVED (RFC 2606) and can never resolve, which is the point:
 * v1's sandbox arm writes the link onto a synthetic bodyless row and reads its
 * extension, and nothing on that path fetches it. A plausible-looking URL here
 * would be a thing that might one day be requested.
 */
const UPLOADED_PHOTO_PLACEHOLDER_URL =
  'https://playground.invalid/uploaded-photo.jpg'

// Three sequential model calls (generate, then judge/assessor concurrent)
// plus retrieval: 15-45s observed. 120 gives headroom without letting a hung
// provider call pin a function for the platform maximum.
export const maxDuration = 120
export const dynamic = 'force-dynamic'

/**
 * The whole turn's budget, under `maxDuration` on purpose.
 *
 * A replay turn was measured at 4.1 MINUTES locally. On Vercel that is not a
 * slow answer, it is the platform killing the function at 120s and the
 * operator getting a dead request with nothing to read. Returning our own
 * failure a little early turns that into a trace-shaped answer that says which
 * stage was still running.
 *
 * 110s AND NOT 20s, deliberately, because 20 would fail every turn. Measured
 * on this branch: v2 alone 42-66s in sandbox, and one real sandbox turn with
 * the v1 arm on at 85.4s. A 90s budget was the first number here and it sat
 * 4.6s above a turn that had already happened - it would have 504'd normal
 * turns and read as a bug in the arm. 110 leaves the platform's 120s
 * maxDuration room to serialize the answer instead of being killed mid-write.
 *
 * 20s is the right TARGET and reaching it is a latency project on v2's serial
 * calls, not a constant. Make v2 faster, then lower this - do not lower it
 * first and call the resulting failures a timeout policy.
 */
const TURN_BUDGET_MS = 110_000

const HistoryTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
})

// Session facts mirror StateFacts. Parses client JSON, not LLM output, so
// numeric bounds are allowed here.
const SessionSchema = z.object({
  profile: GuestProfileSchema,
  memory: InteractionMemorySchema,
  // Optional to mirror PlaygroundSession (lib/relationship/run-turn.ts):
  // replay sends a session with no stored state and lets the engine resolve
  // it deterministically from the facts.
  stateKey: z.string().min(1).optional(),
  facts: z.object({
    visitCount: z.number().int().nonnegative(),
    replyCount: z.number().int().nonnegative(),
    daysSinceLastContact: z.number().nonnegative().nullable(),
  }),
})

const OverridesSchema = z.object({
  stateKey: z.string().optional(),
  mission: z.string().optional(),
  guestProfileText: z.string().optional(),
  interactionMemoryText: z.string().optional(),
  openMovesText: z.string().optional(),
  knowledgeBriefText: z.string().optional(),
  // Only reaches the prompt on an archived template version that retrieves.
  knowledgeText: z.string().optional(),
  // A key of V2_TEMPLATE_SETS. Not a z.enum over the registry: a conversation
  // saved on a version later dropped from the archive must still parse, and
  // `resolveV2TemplateSet` fails open to the current template with a warning.
  // A hard enum here would reject the whole saved turn over a fixture.
  templateVersion: z.string().max(40).optional(),
  // The template's own blocks, hand-edited, placeholders intact - the prompt
  // lab's template mode. ONE DEFINITION, shared with the saved conversation
  // (lib/schemas/playground.ts), for the reason that file gives: a turn this
  // route accepted must save, and a saved turn must re-run.
  templateBlocks: TemplateBlocksSchema.optional(),
  voicePackText: z.string().optional(),
  venueProfileText: z.string().optional(),
  // Hand-edited SYSTEM blocks, replaced by label. Capped at the order of the
  // thing they replace: Le Mil's THE HOUSE block is ~22k chars with the
  // knowledge brief in it, so 200k per block leaves room to paste a bigger one
  // in without the field being a way to post a megabyte. 8 blocks against the
  // composer's 3, so a template can grow without this becoming the limit.
  promptBlocks: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        text: z.string().max(200_000),
      }),
    )
    .max(8)
    .optional(),
  // The whole system half as one document, for a surface that edits it that
  // way. Capped at the sum of what it replaces rather than per block - Le
  // Mil's three blocks compose to ~50k chars, so 400k leaves the same room to
  // paste a bigger one in without the field being a way to post a megabyte.
  systemText: z.string().max(400_000).optional(),
  modelKey: z.enum(V2_MODEL_KEYS).optional(),
  // Includes 'none', which is not a level: it means send no effort, which is
  // what every measurement taken before V2_DEFAULT_EFFORT existed did.
  effort: z.enum(V2_EFFORT_REQUESTS).optional(),
  // Bounded at BOTH ends, and the floor is not decoration: a 0 or a 1 here
  // generates nothing and reads as the model failing.
  maxOutputTokens: z
    .number()
    .int()
    .min(100)
    .max(V2_PLAYGROUND_MAX_OUTPUT_TOKENS)
    .optional(),
})

const PostBodySchema = z
  .object({
    venueId: z.string().uuid(),
    guestId: z.string().uuid().nullable(),
    // `.min(1)` moved into the refinement below: an outreach turn and a
    // MEDIA-ONLY turn are the two callers allowed to post an empty inbound.
    inbound: z.array(z.string().min(1)).max(10),
    /**
     * What the guest sent besides words, STATED rather than stored - a golden
     * scenario's links, or a photo uploaded in the playground and described.
     *
     * BOTH ARMS GET IT, from this one field: v2 as `declaredMedia`, v1 as the
     * bodyless attachment row `materializeTranscript` writes. Without it the
     * route silently answered "guest asks a question, then sends a photo" as
     * a text turn on both arms - a row a human then judged as though the
     * photo had been there.
     *
     * IT IS NO LONGER LINKS-ONLY. An uploaded photo has no link, and the
     * describe endpoint beside this one has already looked at it, so the
     * description rides here - which is the whole of what any prompt ever
     * learns about a picture. `DeclaredMediaSchema` is shared with the saved
     * conversation so a turn that ran can also be stored and re-run.
     */
    media: DeclaredMediaSchema.optional(),
    sessionHistory: z.array(HistoryTurnSchema).max(200).optional(),
    session: SessionSchema.optional(),
    overrides: OverridesSchema.optional(),
    // Replay mode: what production actually sent after this inbound, judged
    // alongside the v2 draft against the same notes (judge calibration data).
    actualReply: z.array(z.string().min(1)).max(10).optional(),
    // An outreach turn: the venue writing first after the conversation went
    // quiet (v2.21.0). Client JSON, not LLM output, so bounds are allowed.
    outreach: z.object({ hoursQuiet: z.number().min(1).max(336) }).optional(),
    /**
     * Skip the judge and the post-turn assessor - two model calls whose output
     * this route returns on the trace and which a caller may not be rendering.
     *
     * FOR A FAN-OUT CALLER, and safe for the same reason the golden harness
     * passes it: the gate is independent of both (decideDispatch reads the
     * semantic check and the inbound-detected situations, never the assessor),
     * so `messages`, `stateKey` and `gateVerdict` are unchanged. The assessor's
     * `nextSession` is what would carry profile and memory into a FOLLOWING
     * turn, so this is only safe where nothing chains - one turn against
     * authored history, which is what /admin/tests/human-eval runs. A
     * multi-turn caller must not send it.
     */
    skipEvaluation: z.boolean().optional(),
    // The v1 arm, run concurrently with v2. See v1-arm.ts.
    v1Arm: z
      .discriminatedUnion('mode', [
        z.object({
          mode: z.literal('sandbox'),
          // The concurrency slot, which decides WHICH synthetic guest the
          // transcript is materialized against. Bounded here as well as in the
          // arm: out of range is a 400 rather than a per-column error message,
          // because a fan-out caller sending slot 12 has a bug in its worker
          // pool and should hear about it on the first request, not 58 times.
          slot: z
            .number()
            .int()
            .min(0)
            .max(SANDBOX_SLOTS - 1)
            .optional(),
        }),
        z.object({
          mode: z.literal('replay'),
          inboundMessageId: z.string().uuid(),
        }),
        /**
         * The PROACTIVE v1 arm, for pairing against a v2 outreach turn.
         *
         * A third mode rather than a flag on `sandbox`, because it is a
         * different entry point into v1 - `draftFollowupReply`, which asserts
         * there is no current message - and the trigger is what sets it off
         * where an inbound sets the other one off. The harness has run this
         * pairing since the outreach turn landed; this is the route catching
         * up, and it is what lets a blind pass cover v2's follow-ups at all.
         */
        z.object({
          mode: z.literal('sandbox_followup'),
          /**
           * The trigger the scenario rides IN PRODUCTION. Four of these are
           * Instagram-only - `handle-followup.ts` refuses them by name on a
           * text conversation - so one of those needs `channel: 'instagram'`
           * beside it or v1 answers with that refusal.
           */
          trigger: z.enum(GOLDEN_FOLLOWUP_TRIGGERS),
          /**
           * What the materialized transcript is written as, which is what
           * `resolveConversationChannel` reads with no current message. Not
           * cosmetic here: see the trigger above.
           */
          channel: z.enum(['text', 'instagram']).optional(),
          slot: z
            .number()
            .int()
            .min(0)
            .max(SANDBOX_SLOTS - 1)
            .optional(),
        }),
      ])
      .optional(),
  })
  .superRefine((body, ctx) => {
    // TWO LEGAL EMPTY-INBOUND SHAPES, and they are disjoint (runTurn's own
    // contract says so): an outreach turn, where there is no inbound event at
    // all, and a media-only turn - a photo with no caption, which is how
    // every one of the pilot venue's attachments arrived and the exact shape
    // v1's `media_only_card` exists for. A turn with neither is the one thing
    // nothing can answer.
    if (
      body.outreach === undefined &&
      body.media === undefined &&
      body.inbound.length === 0
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'inbound may be empty only on an outreach turn or a media-only turn',
      })
    // Media rides an inbound event; an outreach turn has none to carry it.
    if (body.outreach !== undefined && body.media !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'an outreach turn has no inbound event, so it cannot carry the guest’s media',
      })
    if (body.outreach !== undefined && body.inbound.length > 0)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'an outreach turn carries no inbound - it is the venue writing first',
      })
    // THE TWO ARMS MUST ANSWER THE SAME TURN SHAPE, in both directions.
    // `sandbox` and `replay` answer an inbound, so neither can be paired with
    // an outreach turn; `sandbox_followup` is v1 writing first, so it is only
    // meaningful beside one. Either mismatch would put two different turns in
    // one comparison, which is worse than refusing: the surface would render
    // them side by side as though they answered the same thing.
    if (
      body.outreach !== undefined &&
      body.v1Arm !== undefined &&
      body.v1Arm.mode !== 'sandbox_followup'
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `the '${body.v1Arm.mode}' v1 arm answers an inbound - an outreach turn has none to hand it. Use mode 'sandbox_followup'.`,
      })
    if (body.v1Arm?.mode === 'sandbox_followup' && body.outreach === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "the 'sandbox_followup' v1 arm is the venue writing first - pair it with an outreach turn, or v2 would be answering an inbound v1 never saw",
      })
    if (body.outreach !== undefined && body.actualReply !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'replay judges what production sent after an inbound - production has no outreach turns to replay',
      })
  })

export async function POST(request: Request): Promise<NextResponse> {
  let body: z.infer<typeof PostBodySchema>
  try {
    const raw: unknown = await request.json()
    const parsed = PostBodySchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid body', detail: parsed.error.message },
        { status: 400 },
      )
    }
    body = parsed.data
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const auth = await requireVenueAdmin(body.venueId)
  if (!auth.ok) return auth.response

  // runTurn returns failures as values on the trace (generation.ok, judge.ok,
  // ...), so a try/catch here only guards the outer boundary: a thrown
  // supabase read or a bug, surfaced as JSON the inspector can render.
  try {
    // THE TWO ARMS RUN CONCURRENTLY, which is what keeps this inside
    // maxDuration: v1 and v2 are independent given the same inbound, so the
    // wall clock is max(v1, v2) rather than the sum. Sequential would put a
    // full v1 generation in front of v2's three calls.
    //
    // `allSettled`, not `all`: a v1 arm that throws must cost the v1 column
    // and nothing else. The v2 trace is the primary payload and a debugging
    // surface losing it because the retiring engine fell over would be the
    // wrong failure.
    //
    // EACH ARM IS TIMED FROM THE SAME INSTANT AND STOPPED WHEN IT ITSELF
    // SETTLES, never after the barrier. Reading the clock after `allSettled`
    // resolves gives both arms max(v1, v2) - the measurement harness recorded
    // exactly that bug, and it was believable right up until the two arms'
    // maxima came out byte-identical. A caller that stores these numbers
    // (/admin/tests/human-eval) is storing a comparison, so they have to
    // measure the same boundary as each other and nothing wider.
    const started = Date.now()
    let v1Ms: number | null = null
    let v2Ms = 0
    const settled = await Promise.race([
      Promise.allSettled([
        runTurn({
          venueId: body.venueId,
          guestId: body.guestId,
          inbound: body.inbound,
          sessionHistory: body.sessionHistory,
          session: body.session,
          overrides: body.overrides,
          actualReply: body.actualReply,
          ...(body.outreach !== undefined ? { outreach: body.outreach } : {}),
          // Stated, not stored - a sandbox guest has no rows for the media
          // lane to read. runTurn reads it only when `guestId` is null, which
          // is what keeps a replay reading the real thread's attachments.
          ...(body.media !== undefined ? { declaredMedia: body.media } : {}),
          skipEvaluation: body.skipEvaluation,
        }).then((trace) => {
          v2Ms = Date.now() - started
          return trace
        }),
        runV1Arm(body).then((column) => {
          // Null when no arm was requested, which is not a duration of zero.
          if (column !== null) v1Ms = Date.now() - started
          return column
        }),
      ]),
      new Promise<'timed_out'>((resolve) =>
        setTimeout(() => resolve('timed_out'), TURN_BUDGET_MS),
      ),
    ])

    // Over budget: answer with something readable rather than letting the
    // platform kill the function at maxDuration and hand back a dead request.
    // 504 because that is what this is - an upstream that did not answer in
    // time. The underlying model calls are NOT cancelled (no AbortSignal is
    // threaded yet), so they keep running and still bill; the message says so
    // rather than implying the work stopped.
    if (settled === 'timed_out') {
      return NextResponse.json(
        {
          error: 'turn exceeded its budget',
          detail:
            `No answer within ${TURN_BUDGET_MS / 1000}s. The run was abandoned, not cancelled - ` +
            `its model calls may still be in flight. Replay turns are the slow case: v2 runs a second ` +
            `judge over what production actually sent.`,
        },
        { status: 504 },
      )
    }

    const [v2Settled, v1Settled] = settled
    if (v2Settled.status === 'rejected') throw v2Settled.reason
    console.log('[playground] turn complete', {
      ms: Date.now() - started,
      v1Arm: body.v1Arm?.mode ?? 'off',
    })

    const response: RunResponseBody = {
      trace: v2Settled.value,
      armMs: { v1: v1Ms, v2: v2Ms },
      graphStates: await loadGraphStates(body.venueId),
      v1:
        v1Settled.status === 'fulfilled'
          ? v1Settled.value
          : {
              outcome: {
                ok: false,
                error:
                  v1Settled.reason instanceof Error
                    ? v1Settled.reason.message
                    : String(v1Settled.reason),
                stage: 'unexpected',
              },
            },
    }
    return NextResponse.json(response)
  } catch (e) {
    return NextResponse.json(
      {
        error: 'run failed',
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    )
  }
}

/**
 * How long the v1 arm gets before the response gives up on it.
 *
 * v1 is ONE generation plus a classify and a retrieval; it measured ~15s
 * against a real venue. 20s is that with headroom, and past it the arm is
 * not slow, it is wedged - a comparison column is never worth making the
 * operator wait on a hung provider call.
 *
 * IT BOUNDS THE RESPONSE, NOT THE SPEND. `draftInboundReply` takes no
 * AbortSignal, so the generation it already started keeps running and still
 * bills after this fires. Stopping the spend as well means threading a signal
 * down through generateStage into the AI SDK call - worth doing, not done
 * here, and the column says "timed out" rather than implying the work stopped.
 */
const V1_ARM_TIMEOUT_MS = 20_000

/**
 * The v1 arm, or null when the request did not ask for one.
 *
 * Returns the outcome as a value in every case - an arm failure is a column
 * with a reason in it, which is a finding ("v1 errors on this input"), not an
 * error for the whole run.
 */
async function runV1Arm(
  body: z.infer<typeof PostBodySchema>,
): Promise<RunResponseBody['v1']> {
  if (body.v1Arm === undefined) return null
  const arm =
    body.v1Arm.mode === 'replay'
      ? draftV1ForReplay(body.v1Arm.inboundMessageId)
      : body.v1Arm.mode === 'sandbox_followup'
        ? draftV1FollowupForSandbox({
            venueId: body.venueId,
            sessionHistory: body.sessionHistory ?? [],
            // `triggeredAt` is this request's clock. The harness passes its
            // `--at` instead, which is what lets a run taken after close
            // still follow up "the next morning"; this route has no injected
            // clock, so a pass taken at night asks v1 to follow up at night.
            trigger: { reason: body.v1Arm.trigger, triggeredAt: new Date() },
            channel: body.v1Arm.channel,
            slot: body.v1Arm.slot,
          })
        : draftV1ForSandbox({
            venueId: body.venueId,
            sessionHistory: body.sessionHistory ?? [],
            inbound: body.inbound,
            // The SAME links v2 is handed above, written as the bodyless
            // attachment row both webhooks store - so the two arms answer a
            // turn that mentions the same photo rather than one of them
            // answering a turn without it.
            //
            // AN UPLOADED PHOTO HAS NO LINK, and v1 reads a link for its
            // extension and nothing else (it never fetches one on a sandbox
            // run), so it is handed a placeholder whose extension says photo.
            // The alternative is the failure this field was added to fix,
            // one arm answering a turn the other one's guest never sent.
            ...(body.media === undefined
              ? {}
              : {
                  mediaUrls:
                    body.media.mediaUrls !== undefined &&
                    body.media.mediaUrls.length > 0
                      ? body.media.mediaUrls
                      : [UPLOADED_PHOTO_PLACEHOLDER_URL],
                }),
            // Undefined stays slot 0 inside the arm, so the playground's own
            // behaviour is unchanged. A fan-out caller (/admin/tests/human-eval)
            // passes its worker index.
            slot: body.v1Arm.slot,
          })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<V1ArmOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          error: `v1 did not answer within ${V1_ARM_TIMEOUT_MS / 1000}s. The call was not cancelled - it may still be running.`,
          stage: 'timeout',
        }),
      V1_ARM_TIMEOUT_MS,
    )
  })

  const outcome = await Promise.race([arm, timeout])
  // Cleared whichever side won, so a fast arm does not hold the event loop
  // open for the rest of the timeout.
  if (timer !== undefined) clearTimeout(timer)
  return { outcome }
}

/**
 * The active graph's state menu, for the override dropdown. Same load-else-
 * default posture as runTurn itself (a malformed stored graph falls open to
 * the default), so the menu can never disagree with the graph the run used.
 */
async function loadGraphStates(
  venueId: string,
): Promise<RunResponseBody['graphStates']> {
  const supabase = createAdminClient()
  const row = await supabase
    .from('relationship_graphs')
    .select('graph')
    .eq('venue_id', venueId)
    .eq('status', 'active')
    .maybeSingle()
  const graph =
    !row.error && row.data
      ? parseRelationshipGraph(row.data.graph, DEFAULT_RELATIONSHIP_GRAPH).graph
      : DEFAULT_RELATIONSHIP_GRAPH
  return graph.states.map((s) => ({ key: s.key, label: s.label }))
}
