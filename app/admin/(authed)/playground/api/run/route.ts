import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import {
  GuestProfileSchema,
  InteractionMemorySchema,
} from '@/lib/relationship/profile'
import { DEFAULT_RELATIONSHIP_GRAPH } from '@/lib/relationship/default-graph'
import { parseRelationshipGraph } from '@/lib/relationship/schema'
import { runTurn } from '@/lib/relationship/run-turn'
import type { RunResponseBody } from '../../_lib/types'
import {
  draftV1ForReplay,
  draftV1ForSandbox,
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
  knowledgeText: z.string().optional(),
  voicePackText: z.string().optional(),
  venueProfileText: z.string().optional(),
})

const PostBodySchema = z.object({
  venueId: z.string().uuid(),
  guestId: z.string().uuid().nullable(),
  inbound: z.array(z.string().min(1)).min(1).max(10),
  sessionHistory: z.array(HistoryTurnSchema).max(200).optional(),
  session: SessionSchema.optional(),
  overrides: OverridesSchema.optional(),
  // Replay mode: what production actually sent after this inbound, judged
  // alongside the v2 draft against the same notes (judge calibration data).
  actualReply: z.array(z.string().min(1)).max(10).optional(),
  // The v1 arm, run concurrently with v2. See v1-arm.ts.
  v1Arm: z
    .discriminatedUnion('mode', [
      z.object({ mode: z.literal('sandbox') }),
      z.object({
        mode: z.literal('replay'),
        inboundMessageId: z.string().uuid(),
      }),
    ])
    .optional(),
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
    const started = Date.now()
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
        }),
        runV1Arm(body),
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
      : draftV1ForSandbox({
          venueId: body.venueId,
          sessionHistory: body.sessionHistory ?? [],
          inbound: body.inbound,
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
