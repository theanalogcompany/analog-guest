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
//
// IT ALSO CARRIES `submittedAt`, and that is why a submitted pass is actually
// frozen rather than merely greyed out. Every write route on this surface
// already calls this, so the one lookup that resolves the venue also answers
// "may this still change?" - a second helper, or a per-route re-read, is how
// one route ends up accepting a write the others refuse. `refuseIfSubmitted`
// below is the one wording.

export type RequirePassResult =
  | {
      ok: true
      sessionId: string
      venueId: string
      operatorId: string
      /** Set once the pass was submitted; every write must then refuse. */
      submittedAt: string | null
    }
  | { ok: false; response: NextResponse }

/**
 * 409 on a submitted pass, null when the write may proceed.
 *
 * 409 rather than 403: the caller is allowed to write here, the pass is just
 * no longer in a state that accepts one - and the client renders the message,
 * so it names the instant rather than saying "forbidden".
 */
export function refuseIfSubmitted(
  auth: Extract<RequirePassResult, { ok: true }>,
): NextResponse | null {
  if (auth.submittedAt === null) return null
  return NextResponse.json(
    {
      error: `this pass was submitted at ${auth.submittedAt} and is read-only - run a new pass to judge these questions again`,
    },
    { status: 409 },
  )
}

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
    .select('id, venue_id, submitted_at')
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
    submittedAt: row.data.submitted_at,
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
