// TAC-308 knowledge-gap timeout route. Hit every 5 minutes by GitHub Actions
// (.github/workflows/pending-timeout-cron.yml) — NOT by Vercel cron, whose
// Hobby tier caps granularity at daily. Same posture as the commitments-due
// and followups-due crons.
//
// Delegates to lib/agent/knowledge-gap-timeout.ts → processDueKnowledgeGaps.
// Returns 200 with a counts summary regardless of per-card outcomes; the
// processor catches everything and the next tick re-attempts anything it
// didn't claim.
//
// Auth check follows the same dev-skip pattern as the other three crons: in
// dev `curl localhost:3000/api/cron/pending-timeout` works without the header
// so the path can be exercised locally.

import { processDueKnowledgeGaps } from '@/lib/agent/knowledge-gap-timeout'

function isAuthorized(request: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return request.headers.get('authorization') === `Bearer ${expected}`
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const summary = await processDueKnowledgeGaps(new Date())
  console.log('[cron pending-timeout] tick complete', summary)

  return Response.json({ ok: true, ...summary })
}
