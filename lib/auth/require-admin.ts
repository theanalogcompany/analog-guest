// Cookie-session admin auth helpers for /admin/*/api/* route handlers.
// Single source of truth for "session → analog admin → venue allowlist"
// — keeps new admin routes from each rolling their own ~30-line block.
//
// Two flavors, matching the two access shapes the admin routes need:
//   - requireVenueAdmin(request, venueId)           → for venue-scoped routes
//   - requireCorpusEntryAdmin(request, entryId)     → for voice_corpus row routes
//
// Both return a discriminated result. Route handlers do:
//
//   const auth = await requireVenueAdmin(request, venueId)
//   if (!auth.ok) return auth.response
//   const { operatorId } = auth
//
// AuthError statuses (401/403) are translated into matching responses.
// Unexpected throws bubble back as 500 with a generic message — never
// surface raw upstream errors to the caller.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '../db/admin'
import { createServerClient } from '../db/server'
import { AuthError } from './types'
import { verifyAnalogAdminAccess } from './verify-analog-admin'

const UuidSchema = z.string().uuid()

export type RequireAdminResult<TExtra> =
  | ({ ok: true; operatorId: string } & TExtra)
  | { ok: false; response: NextResponse }

async function authenticateAdmin(): Promise<
  | { ok: true; operatorId: string; allowedVenueIds: string[] }
  | { ok: false; response: NextResponse }
> {
  try {
    const supabase = await createServerClient()
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
      }
    }
    const op = await verifyAnalogAdminAccess(session.user.id)
    return {
      ok: true,
      operatorId: op.operatorId,
      allowedVenueIds: op.allowedVenueIds,
    }
  } catch (e) {
    if (e instanceof AuthError) {
      return {
        ok: false,
        response: NextResponse.json({ error: e.message }, { status: e.status }),
      }
    }
    return {
      ok: false,
      response: NextResponse.json({ error: 'auth check failed' }, { status: 500 }),
    }
  }
}

/**
 * Resolve cookie-session admin auth and check venueId is in the operator's
 * allowlist (or that the operator is in analog-admin scope, which sees all
 * venues — represented by an empty `allowedVenueIds`).
 */
export async function requireVenueAdmin(
  venueId: string,
): Promise<RequireAdminResult<{ venueId: string }>> {
  const auth = await authenticateAdmin()
  if (!auth.ok) return auth

  if (!UuidSchema.safeParse(venueId).success) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid venueId' }, { status: 400 }),
    }
  }
  if (auth.allowedVenueIds.length > 0 && !auth.allowedVenueIds.includes(venueId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    }
  }
  return { ok: true, operatorId: auth.operatorId, venueId }
}

/**
 * Resolve cookie-session admin auth and look up the entry's parent venue,
 * checking it's in the allowlist. Returns both operatorId and venueId so
 * downstream helpers can reuse the lookup.
 *
 * Returns 404 when the entry doesn't exist; 403 when it does but the
 * operator can't reach its venue.
 */
export async function requireCorpusEntryAdmin(
  entryId: string,
): Promise<RequireAdminResult<{ venueId: string; entryId: string }>> {
  const auth = await authenticateAdmin()
  if (!auth.ok) return auth

  if (!UuidSchema.safeParse(entryId).success) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid entryId' }, { status: 400 }),
    }
  }

  const supabase = createAdminClient()
  const { data: row, error: lookupErr } = await supabase
    .from('voice_corpus')
    .select('id, venue_id')
    .eq('id', entryId)
    .maybeSingle()
  if (lookupErr) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'corpus entry lookup failed', detail: lookupErr.message },
        { status: 500 },
      ),
    }
  }
  if (!row) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'corpus entry not found' }, { status: 404 }),
    }
  }
  if (
    auth.allowedVenueIds.length > 0 &&
    !auth.allowedVenueIds.includes(row.venue_id)
  ) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    }
  }

  return {
    ok: true,
    operatorId: auth.operatorId,
    venueId: row.venue_id,
    entryId,
  }
}

/**
 * Resolve cookie-session admin auth and look up a knowledge_corpus entry's
 * parent venue, checking it's in the allowlist. TAC-343 sibling of
 * requireCorpusEntryAdmin — same shape, different table (knowledge_corpus
 * instead of voice_corpus).
 *
 * Returns 404 when the entry doesn't exist; 403 when it does but the
 * operator can't reach its venue.
 */
export async function requireKnowledgeEntryAdmin(
  entryId: string,
): Promise<RequireAdminResult<{ venueId: string; entryId: string }>> {
  const auth = await authenticateAdmin()
  if (!auth.ok) return auth

  if (!UuidSchema.safeParse(entryId).success) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid entryId' }, { status: 400 }),
    }
  }

  const supabase = createAdminClient()
  const { data: row, error: lookupErr } = await supabase
    .from('knowledge_corpus')
    .select('id, venue_id')
    .eq('id', entryId)
    .maybeSingle()
  if (lookupErr) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'knowledge entry lookup failed', detail: lookupErr.message },
        { status: 500 },
      ),
    }
  }
  if (!row) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'knowledge entry not found' }, { status: 404 }),
    }
  }
  if (
    auth.allowedVenueIds.length > 0 &&
    !auth.allowedVenueIds.includes(row.venue_id)
  ) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    }
  }

  return {
    ok: true,
    operatorId: auth.operatorId,
    venueId: row.venue_id,
    entryId,
  }
}

/**
 * Resolve cookie-session admin auth for a MERGE across multiple
 * knowledge_corpus entries. Resolves the target venue from the entries
 * themselves (never a client-supplied venueId) so a tampered request can't
 * point the merge at a venue the operator doesn't actually have access to.
 * Refuses (400) if fewer than 2 ids are given, if the ids don't all resolve
 * to rows, or if the rows don't all share one venue_id — a cross-venue
 * merge would violate the "every venue is its own isolated block" rule.
 */
export async function requireKnowledgeEntriesAdmin(
  entryIds: string[],
): Promise<RequireAdminResult<{ venueId: string; entryIds: string[] }>> {
  const auth = await authenticateAdmin()
  if (!auth.ok) return auth

  const idsSchema = z.array(z.string().uuid()).min(2)
  const parsedIds = idsSchema.safeParse(entryIds)
  if (!parsedIds.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'invalid entryIds', detail: 'at least 2 valid UUIDs required' },
        { status: 400 },
      ),
    }
  }

  const supabase = createAdminClient()
  const { data: rows, error: lookupErr } = await supabase
    .from('knowledge_corpus')
    .select('id, venue_id')
    .in('id', parsedIds.data)
  if (lookupErr) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'knowledge entries lookup failed', detail: lookupErr.message },
        { status: 500 },
      ),
    }
  }
  if (!rows || rows.length !== parsedIds.data.length) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'one or more knowledge entries not found' }, { status: 404 }),
    }
  }

  const venueIds = new Set(rows.map((r) => r.venue_id))
  if (venueIds.size !== 1) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'entries span more than one venue' },
        { status: 400 },
      ),
    }
  }
  const venueId = rows[0].venue_id

  if (auth.allowedVenueIds.length > 0 && !auth.allowedVenueIds.includes(venueId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    }
  }

  return {
    ok: true,
    operatorId: auth.operatorId,
    venueId,
    entryIds: parsedIds.data,
  }
}
