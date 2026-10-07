import { NextResponse } from 'next/server'
import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import {
  parsePlaygroundNextSession,
  PlaygroundConversationTurnsSchema,
} from '@/lib/schemas/playground'
import type { SavedConversationDetail } from '@/app/admin/(authed)/playground/_lib/types'

// GET    /admin/playground/api/venues/[venueId]/conversations/[id] - load one
// DELETE /admin/playground/api/venues/[venueId]/conversations/[id]
//
// The read parses `turns` through the schema and 422s a row it cannot parse,
// rather than handing the client a half-shaped conversation. That is the
// stricter direction than the admin loaders' usual degrade, and deliberately:
// a list can drop one bad row and still be useful, but a conversation that
// loads with three of its seven turns is a lie the operator would act on.
// The picker lists rows without reading `turns`, so a bad row is visible and
// deletable rather than invisible.
//
// Both handlers scope the row read on venue_id as well as id: an id reaching
// this route came from a client, and a bare id lookup would let an operator
// with one venue's scope read or delete another venue's row by guessing.

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ venueId: string; conversationId: string }> },
): Promise<NextResponse> {
  const { venueId, conversationId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  const supabase = createAdminClient()
  const result = await supabase
    .from('playground_conversations')
    .select('id, name, turns, turn_count, next_session, created_at, updated_at')
    .eq('id', conversationId)
    .eq('venue_id', venueId)
    .maybeSingle()

  if (result.error) {
    return NextResponse.json(
      { error: 'conversation load failed', detail: result.error.message },
      { status: 500 },
    )
  }
  if (result.data === null) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const parsed = PlaygroundConversationTurnsSchema.safeParse(result.data.turns)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'saved conversation is unreadable',
        detail: parsed.error.message,
      },
      { status: 422 },
    )
  }

  const detail: SavedConversationDetail = {
    id: result.data.id,
    name: result.data.name,
    turnCount: result.data.turn_count,
    createdAt: result.data.created_at,
    updatedAt: result.data.updated_at,
    turns: parsed.data,
    // Fails open to null: a malformed continuation snapshot costs the ability
    // to type a new message onto the end, not the whole saved conversation.
    // The turns above are the opposite call, and deliberately - a partial
    // transcript is a lie, a missing session is a visible restart.
    nextSession: parsePlaygroundNextSession(result.data.next_session),
  }
  return NextResponse.json(detail)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ venueId: string; conversationId: string }> },
): Promise<NextResponse> {
  const { venueId, conversationId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  const supabase = createAdminClient()
  // Hard delete, not a soft one: a scratch conversation nobody wants back has
  // no downstream reader to orphan (nothing references this table), so the
  // engagement_events soft-delete rule does not reach here.
  const result = await supabase
    .from('playground_conversations')
    .delete()
    .eq('id', conversationId)
    .eq('venue_id', venueId)
    .select('id')
    .maybeSingle()

  if (result.error) {
    return NextResponse.json(
      { error: 'delete failed', detail: result.error.message },
      { status: 500 },
    )
  }
  if (result.data === null) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
