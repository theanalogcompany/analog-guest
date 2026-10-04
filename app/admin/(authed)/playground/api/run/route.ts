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
    const trace = await runTurn({
      venueId: body.venueId,
      guestId: body.guestId,
      inbound: body.inbound,
      sessionHistory: body.sessionHistory,
      session: body.session,
      overrides: body.overrides,
      actualReply: body.actualReply,
    })

    const response: RunResponseBody = {
      trace,
      graphStates: await loadGraphStates(body.venueId),
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
