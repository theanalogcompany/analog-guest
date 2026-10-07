import { NextResponse } from 'next/server'
import { z } from 'zod'
import { DEV_BYPASS_OPERATOR_ID, requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import {
  PLAYGROUND_CONVERSATION_NAME_MAX,
  PlaygroundConversationTurnsSchema,
  PlaygroundNextSessionSchema,
} from '@/lib/schemas/playground'
import type {
  SavedConversationListResponse,
  SavedConversationSummary,
} from '@/app/admin/(authed)/playground/_lib/types'

// GET  /admin/playground/api/venues/[venueId]/conversations - the picker list
// POST /admin/playground/api/venues/[venueId]/conversations - save one
//
// Saved sandbox conversations (migration 074). The list is deliberately thin -
// no `turns` column - so opening the picker does not pull every saved blob;
// turn_count is denormalized for exactly that.
//
// Venue-scoped path rather than a ?venueId= query, matching the sibling guests
// and timeline routes, so the auth gate reads the venue from the same place
// the data does and the two cannot drift.

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const LIST_LIMIT = 50

const PostBodySchema = z.object({
  name: z.string().trim().min(1).max(PLAYGROUND_CONVERSATION_NAME_MAX),
  turns: PlaygroundConversationTurnsSchema,
  /** Default null, not required: a conversation whose runs all failed has none. */
  nextSession: PlaygroundNextSessionSchema.default(null),
})

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  const supabase = createAdminClient()
  // LIMIT + 1 so the page can state "showing the newest 50" as a fact rather
  // than inferring completeness from a length that equals the cap.
  const result = await supabase
    .from('playground_conversations')
    .select('id, name, turn_count, created_at, updated_at')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT + 1)

  if (result.error) {
    return NextResponse.json(
      { error: 'conversation list load failed', detail: result.error.message },
      { status: 500 },
    )
  }

  const rows = result.data ?? []
  const conversations: SavedConversationSummary[] = rows
    .slice(0, LIST_LIMIT)
    .map((r) => ({
      id: r.id,
      name: r.name,
      turnCount: r.turn_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))

  const response: SavedConversationListResponse = {
    conversations,
    hasMore: rows.length > LIST_LIMIT,
  }
  return NextResponse.json(response)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

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

  const supabase = createAdminClient()
  const inserted = await supabase
    .from('playground_conversations')
    .insert({
      venue_id: venueId,
      name: body.name,
      turns: body.turns,
      // Written by the same insert that writes `turns`, never maintained
      // separately - a count that can disagree with the array it counts is
      // worse than no count.
      turn_count: body.turns.length,
      next_session: body.nextSession,
      // The dev bypass's synthetic principal carries an all-zeros sentinel
      // operatorId and has no `operators` row; this column is FK'd to that
      // table, so stamping the sentinel fails the WHOLE insert. Caught
      // 2026-10-06 - every save on a local `next dev` returned 500 on
      // playground_conversations_created_by_operator_id_fkey, and a direct
      // insert testing the same shape passed because it wrote NULL here, so
      // the column was the one field the test did not exercise.
      //
      // NULL is the honest value rather than a workaround: the column is
      // nullable and already means "no operator on file" (an operator row
      // deleted sets it null). dev-bypass.ts anticipated a write route
      // stamping the sentinel and called it "visible, greppable and honest";
      // what it did not anticipate is that a foreign key makes stamping it
      // impossible. THIS ROUTE IS NOT THE ONLY ONE - seven other admin write
      // sites stamp auth.operatorId and have the same hole; the shared fix
      // belongs in lib/auth/, which is hard-stop territory.
      created_by_operator_id:
        auth.operatorId === DEV_BYPASS_OPERATOR_ID ? null : auth.operatorId,
    })
    .select('id, name, turn_count, created_at, updated_at')
    .single()

  if (inserted.error || inserted.data === null) {
    return NextResponse.json(
      { error: 'save failed', detail: inserted.error?.message ?? 'no row' },
      { status: 500 },
    )
  }

  const summary: SavedConversationSummary = {
    id: inserted.data.id,
    name: inserted.data.name,
    turnCount: inserted.data.turn_count,
    createdAt: inserted.data.created_at,
    updatedAt: inserted.data.updated_at,
  }
  return NextResponse.json(summary, { status: 201 })
}
