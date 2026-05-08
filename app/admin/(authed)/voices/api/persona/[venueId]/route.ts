import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { toJson } from '@/lib/db/json'
import { BrandPersonaSchema } from '@/lib/schemas'

// PATCH /admin/voices/api/persona/[venueId] — write through to
// venue_configs.brand_persona. Single writer for everything in BrandPersona,
// including voiceName, tone, formality, length, emoji, speaker framing,
// signature phrases, banned topics, voice touchstones. Anti-patterns are
// edited via the dedicated rules endpoints.
//
// Read-modify-write through BrandPersonaSchema so the dual-shape state from
// THE-236 doesn't leak — every field present in the request body is merged
// onto the parsed persona and the whole thing is re-validated before write.
// Legacy string anti-pattern entries get in-place migrated to struct shape
// on the same write.

// Partial body — operator may PATCH any subset of editable fields. Per-field
// constraints are inlined; .partial() on BrandPersonaSchema interacts poorly
// with the union/transform on voiceAntiPatterns.
const PatchBodySchema = z.object({
  voiceName: z.string().min(1).optional(),
  tone: z.string().min(1).optional(),
  formality: z.enum(['casual', 'warm', 'formal']).optional(),
  speakerFraming: z.enum(['venue', 'named_person', 'owner']).optional(),
  speakerName: z.string().optional(),
  signaturePhrases: z.array(z.string()).optional(),
  bannedTopics: z.array(z.string()).optional(),
  emojiPolicy: z.enum(['never', 'sparingly', 'frequent']).optional(),
  lengthGuide: z.string().min(1).optional(),
  voiceTouchstones: z.array(z.string()).optional(),
})

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  let body: z.infer<typeof PatchBodySchema>
  try {
    const raw = await request.json()
    const parsed = PatchBodySchema.safeParse(raw)
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
  const { data: row, error: readErr } = await supabase
    .from('venue_configs')
    .select('brand_persona')
    .eq('venue_id', venueId)
    .single()
  if (readErr || !row) {
    return NextResponse.json(
      {
        error: 'venue_configs lookup failed',
        detail: readErr?.message ?? 'no row',
      },
      { status: 500 },
    )
  }

  const personaParsed = BrandPersonaSchema.safeParse(row.brand_persona)
  if (!personaParsed.success) {
    return NextResponse.json(
      { error: 'persona parse failed', detail: personaParsed.error.message },
      { status: 500 },
    )
  }

  const merged = { ...personaParsed.data, ...body }
  const validated = BrandPersonaSchema.safeParse(merged)
  if (!validated.success) {
    return NextResponse.json(
      { error: 'persona invalid after merge', detail: validated.error.message },
      { status: 400 },
    )
  }

  const { error: writeErr } = await supabase
    .from('venue_configs')
    .update({ brand_persona: toJson(validated.data) })
    .eq('venue_id', venueId)
  if (writeErr) {
    return NextResponse.json(
      { error: 'persona write failed', detail: writeErr.message },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, persona: validated.data })
}
