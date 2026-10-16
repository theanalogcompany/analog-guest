import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { resolveV2ModelProfile } from '@/lib/ai/v2/model-call'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { V2_PROMPT_VERSION } from '@/lib/ai/v2/template'
import { createAdminClient } from '@/lib/db/admin'
import { loadVenueOpenState } from '@/lib/eval/venue-open-state'
import { parseJsonBody } from '../../_lib/parse-body'
import type { HumanEvalSessionView } from '../../_lib/types'

// POST /admin/tests/human-eval/api/sessions - open a blind evaluation pass.
//
// Lives at /admin/{surface}/api/{thing} and NOT /api/admin/...: the host gate
// in root middleware.ts 404s anything not starting with /admin on the admin
// apex, so the other path works locally and on previews and 404s in
// production.
//
// THE PROVENANCE IS STAMPED HERE, NOT BY THE CLIENT. Prompt versions, the
// resolved v2 model and the venue's open state all describe the code and the
// clock the answers will be generated under, and a browser cannot be the
// authority on any of them. The open state in particular: the prompt carries
// an open/closed line, so two passes taken in different states are not
// comparable with each other, and a pass that did not record its state cannot
// be told apart from one that did.
//
// `requireVenueAdmin` rather than the fleet-wide tests gate, because a pass
// belongs to a venue and writes rows carrying its id.

export const dynamic = 'force-dynamic'

const PostBodySchema = z.object({ venueId: z.string().uuid() })

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = await parseJsonBody(request, PostBodySchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.body

  const auth = await requireVenueAdmin(body.venueId)
  if (!auth.ok) return auth.response

  const supabase = createAdminClient()
  const venue = await supabase
    .from('venues')
    .select('id, name, timezone')
    .eq('id', body.venueId)
    .maybeSingle()
  if (venue.error)
    return NextResponse.json(
      { error: `venue unreadable: ${venue.error.message}` },
      { status: 500 },
    )
  if (!venue.data)
    return NextResponse.json({ error: 'no such venue' }, { status: 404 })

  const openState = await loadVenueOpenState({
    venueId: venue.data.id,
    timezone: venue.data.timezone,
    at: new Date(),
  })

  const inserted = await supabase
    .from('human_eval_sessions')
    .insert({
      venue_id: venue.data.id,
      rated_by: auth.operatorId,
      v1_prompt_version: PROMPT_VERSION,
      v2_prompt_version: V2_PROMPT_VERSION,
      // The switch's resolved profile, not the env string: an unknown
      // V2_GENERATION_MODEL falls back with a warning, and the fallback is
      // what answered.
      v2_model: resolveV2ModelProfile().id,
      venue_open_state: openState,
      // Vercel's own build-time sha. Null locally, which is honest - there is
      // no deployment behind a dev server - and never guessed from a shell
      // `git rev-parse`, which would describe the machine rather than the
      // code that ran.
      git_sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    })
    .select(
      'id, venue_id, rated_by, v1_prompt_version, v2_prompt_version, v2_model, venue_open_state, git_sha, started_at',
    )
    .single()
  if (inserted.error || !inserted.data)
    return NextResponse.json(
      {
        error: `could not open a pass (migration 083 applied?): ${inserted.error?.message ?? 'no row returned'}`,
      },
      { status: 500 },
    )

  const session: HumanEvalSessionView = {
    id: inserted.data.id,
    venueId: inserted.data.venue_id,
    venueName: venue.data.name,
    ratedBy: inserted.data.rated_by,
    v1PromptVersion: inserted.data.v1_prompt_version,
    v2PromptVersion: inserted.data.v2_prompt_version,
    v2Model: inserted.data.v2_model,
    venueOpenState: inserted.data.venue_open_state,
    gitSha: inserted.data.git_sha,
    startedAt: inserted.data.started_at,
    // A pass is born unsubmitted. Not selected back from the row: the column
    // has no default and this insert does not set it, so reading it would be
    // asking the database to confirm a constant.
    submittedAt: null,
    // Current by construction: the three stamps above were just read from the
    // same constants the staleness check compares them against. A literal
    // rather than a call, for the same reason `submittedAt` is one - this is
    // the code that made it true, not a question to ask about it.
    stale: null,
    units: [],
  }
  return NextResponse.json({ session })
}
