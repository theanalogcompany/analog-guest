import { NextResponse } from 'next/server'
import { z } from 'zod'
import { capturePostHogEvent } from '@/lib/analytics/posthog'
import { requireVenueAdmin } from '@/lib/auth'
import {
  dedupeAndAppendAntiPatterns,
  SOURCE_REF_PREFIXES,
  upsertCorpusEdit,
} from '@/lib/voice-training'
import {
  findPatternClusterForCritique,
  persistCritique,
} from '@/lib/voices'

// POST /admin/voices/api/commit — the live half of the regen → commit
// loop. Orchestrates four artifacts in serial:
//
//   1. voice_corpus row (when saveToCorpus): replace-mode upsert keyed
//      on `voices-commit:{originalMessageId}`. Re-committing the same
//      flagged outbound replaces the prior corpus row in place.
//   2. brand_persona.voiceAntiPatterns rule (when kind = 'edit_and_rule'):
//      dedupe-append with source='manual' and the operator UUID.
//      ruleTextOverride wins over the auto-classified text — the operator
//      saw it in the modal and chose what to ship.
//   3. voice_critiques row (always — regardless of kind). The cluster
//      query filters at read time; we don't need to gate insert by kind.
//   4. Pattern cluster check (only when kind = 'edit_only'). Embedding
//      from step 3 is reused so we don't re-embed.
//
// Plus a PostHog event with cosine similarity for empirical 0.85
// threshold tuning over the first 30 days.
//
// Atomicity: serial chain, no transaction (supabase-js doesn't expose
// BEGIN/COMMIT cleanly across these tables). Operator sees error toast
// on partial failure; corpus replace is end-state-idempotent, the
// critique row is the authoritative log of what was committed.

const PostBodySchema = z.object({
  venueId: z.string().uuid(),
  originalMessageId: z.string().uuid(),
  selectedResponse: z.string().min(1),
  critique: z.string().min(1),
  kind: z.enum(['edit_only', 'edit_and_rule']),
  ruleTextOverride: z.string().optional(),
  saveToCorpus: z.boolean(),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  let body: z.infer<typeof PostBodySchema>
  try {
    const raw = await request.json()
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

  // 1. Corpus row (optional)
  let corpusOutcome: string | null = null
  if (body.saveToCorpus) {
    const corpus = await upsertCorpusEdit(
      {
        venueId: body.venueId,
        sourceRef: `${SOURCE_REF_PREFIXES.voicesCommit}${body.originalMessageId}`,
        editedMessage: body.selectedResponse,
        tags: ['voices_commit'],
      },
      'replace',
    )
    if (!corpus.ok) {
      const status = corpus.errorCode === 'embed_failed' ? 502 : 500
      return NextResponse.json(
        {
          error: 'corpus write failed',
          detail: corpus.error,
          errorCode: corpus.errorCode,
        },
        { status },
      )
    }
    corpusOutcome = corpus.outcome
  }

  // 2. Anti-pattern (when edit_and_rule)
  const ruleText =
    body.kind === 'edit_and_rule' ? body.ruleTextOverride?.trim() : undefined
  let antiPatternAdded: string[] = []
  if (body.kind === 'edit_and_rule') {
    if (!ruleText || ruleText.length === 0) {
      return NextResponse.json(
        { error: 'ruleTextOverride required when kind=edit_and_rule' },
        { status: 400 },
      )
    }
    try {
      const result = await dedupeAndAppendAntiPatterns(
        body.venueId,
        [ruleText],
        { source: 'manual', authorOperatorId: auth.operatorId },
      )
      antiPatternAdded = result.added
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return NextResponse.json(
        { error: 'anti-pattern append failed', detail: errMsg },
        { status: 500 },
      )
    }
  }

  // 3. Critique row (always)
  const persisted = await persistCritique({
    venueId: body.venueId,
    messageId: body.originalMessageId,
    critiqueText: body.critique,
    kind: body.kind,
    createdByOperatorId: auth.operatorId,
  })
  if (!persisted.ok) {
    const status = persisted.errorCode === 'embed_failed' ? 502 : 500
    return NextResponse.json(
      {
        error: 'critique persistence failed',
        detail: persisted.error,
        errorCode: persisted.errorCode,
      },
      { status },
    )
  }

  // 4. Cluster check (only edit_only)
  let cluster = null
  if (body.kind === 'edit_only') {
    cluster = await findPatternClusterForCritique({
      venueId: body.venueId,
      critiqueId: persisted.critiqueId,
      critiqueText: body.critique,
      messageId: body.originalMessageId,
      embedding: persisted.embedding,
    })
  }

  // 5. PostHog: cosine threshold tuning event. Fire-and-forget.
  await capturePostHogEvent('voice_critique_committed', body.venueId, {
    venueId: body.venueId,
    operatorId: auth.operatorId,
    critiqueId: persisted.critiqueId,
    kind: body.kind,
    clusterFormed: cluster !== null,
    verificationCalled: cluster !== null,
  })

  return NextResponse.json({
    success: true,
    corpusOutcome,
    antiPatternAdded,
    critiqueId: persisted.critiqueId,
    patternCluster: cluster,
  })
}
