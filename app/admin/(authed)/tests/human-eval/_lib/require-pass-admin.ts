import { NextResponse } from 'next/server'
import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'

// Resolve a pass (or one of its rows) to its venue, then run the SAME
// venue-scoped admin gate every other admin write route runs.
//
// The two write routes under this surface are addressed by a session id and a
// unit id, not by a venue id - so the venue has to be looked up before it can
// be checked. That is the shape `requireCorpusEntryAdmin` and
// `requireMechanicAdmin` already have in lib/auth; this composes
// `requireVenueAdmin` rather than adding a third of them there, because
// lib/auth is a hard stop (root CLAUDE.md) and nothing here needs a new gate -
// only a lookup in front of an existing one.
//
// Route handlers under the (authed) group do NOT inherit the layout's gate
// (layouts wrap pages, not routes), so every handler calls this itself.
//
// Fails as a value, with the venue id NEVER echoed in the error: "no such
// pass" is the answer for a row that does not exist and for one belonging to a
// venue outside the caller's allowlist, because distinguishing them would turn
// this into a venue-enumeration oracle.

export type RequirePassResult =
  | { ok: true; sessionId: string; venueId: string; operatorId: string }
  | { ok: false; response: NextResponse }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function requireSessionAdmin(
  sessionId: string,
): Promise<RequirePassResult> {
  if (!UUID.test(sessionId))
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'sessionId must be a uuid' },
        { status: 400 },
      ),
    }
  const supabase = createAdminClient()
  const row = await supabase
    .from('human_eval_sessions')
    .select('id, venue_id')
    .eq('id', sessionId)
    .maybeSingle()
  if (row.error)
    return {
      ok: false,
      response: NextResponse.json(
        { error: `pass unreadable: ${row.error.message}` },
        { status: 500 },
      ),
    }
  if (!row.data)
    return {
      ok: false,
      response: NextResponse.json({ error: 'no such pass' }, { status: 404 }),
    }

  const auth = await requireVenueAdmin(row.data.venue_id)
  if (!auth.ok) return auth
  return {
    ok: true,
    sessionId: row.data.id,
    venueId: row.data.venue_id,
    operatorId: auth.operatorId,
  }
}

/** The same gate, reached through one of the pass's rows. */
export async function requireUnitAdmin(
  unitId: string,
): Promise<RequirePassResult & { unitId?: string }> {
  if (!UUID.test(unitId))
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'unitId must be a uuid' },
        { status: 400 },
      ),
    }
  const supabase = createAdminClient()
  const row = await supabase
    .from('human_eval_units')
    .select('id, session_id')
    .eq('id', unitId)
    .maybeSingle()
  if (row.error)
    return {
      ok: false,
      response: NextResponse.json(
        { error: `row unreadable: ${row.error.message}` },
        { status: 500 },
      ),
    }
  if (!row.data)
    return {
      ok: false,
      response: NextResponse.json({ error: 'no such row' }, { status: 404 }),
    }
  const session = await requireSessionAdmin(row.data.session_id)
  if (!session.ok) return session
  return { ...session, unitId: row.data.id }
}
