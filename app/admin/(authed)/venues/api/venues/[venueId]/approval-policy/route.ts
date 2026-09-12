import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { toJson } from '@/lib/db/json'
import { MESSAGE_CATEGORIES } from '@/lib/ai/types'
import type { MessageCategory } from '@/lib/ai/types'
import {
  APPROVAL_DISPOSITIONS,
  POLICY_EXEMPT_CATEGORIES,
  isPolicyExemptCategory,
} from '@/lib/schemas/approval-policy'

// PATCH /admin/venues/api/venues/[venueId]/approval-policy — the write side of
// the TAC-307 Command Center controls. Sole writer of
// venue_configs.approval_policy; nothing else in the repo writes it except the
// seed script's initial literal.
//
// Unlike the sibling venue-info route this does NOT read-modify-write, and the
// difference is structural rather than a shortcut: approval_policy holds
// exactly {default, perCategory} and the client sends both, so a whole-object
// replace loses nothing. venue_info needs the merge because it has sibling keys
// (address, hours, menu, staff, currentContext) a partial write would drop.
//
// STRICTER THAN THE RUNTIME READER, DELIBERATELY. PerCategorySchema keys on a
// loose z.string() so a typo'd key in a hand-edited row degrades to "that one
// override is ignored" instead of failing the whole policy (see the note in
// lib/schemas/approval-policy.ts). That posture is right at the LIVE boundary
// and wrong here: this is the offline/admin boundary, where a typo should fail
// loudly rather than be persisted and silently never match. Same
// strict-offline / permissive-live split CLAUDE.md documents for venue specs.

const DispositionSchema = z.enum(APPROVAL_DISPOSITIONS)

// Keys are validated in a follow-up pass rather than via
// `z.record(z.enum(MESSAGE_CATEGORIES), ...)`: a record keyed on an enum is
// EXHAUSTIVE in Zod, so that shape would reject any payload that omits a
// category — which every payload does when the master switch is on and
// perCategory is `{}`. Checking the keys explicitly keeps the strictness
// without requiring the client to send all of them.
const PatchBodySchema = z.object({
  default: DispositionSchema,
  perCategory: z.record(z.string(), DispositionSchema),
})

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(MESSAGE_CATEGORIES)

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
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const unknownCategory = Object.keys(body.perCategory).find((k) => !KNOWN_CATEGORIES.has(k))
  if (unknownCategory !== undefined) {
    return NextResponse.json(
      { error: 'unknown_category', detail: `${unknownCategory} is not a message category` },
      { status: 400 },
    )
  }

  // Refuse an operator_approval hold on an exempt category rather than
  // silently dropping it. The UI never offers the control, so reaching here
  // means a hand-crafted request — exactly when a silent no-op is worst. A
  // stored auto_send on an exempt category is harmless and stays allowed.
  const exemptHold = Object.entries(body.perCategory).find(
    ([category, disposition]) =>
      disposition === 'operator_approval' &&
      // Sound because the KNOWN_CATEGORIES check above already ran, so every
      // remaining key is a real MessageCategory.
      isPolicyExemptCategory(category as MessageCategory),
  )
  if (exemptHold) {
    return NextResponse.json(
      {
        error: 'category_exempt',
        detail: `${exemptHold[0]} cannot be held for operator approval (exempt: ${POLICY_EXEMPT_CATEGORIES.join(', ')})`,
      },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()
  const { error, count } = await supabase
    .from('venue_configs')
    .update(
      { approval_policy: toJson({ default: body.default, perCategory: body.perCategory }) },
      { count: 'exact' },
    )
    .eq('venue_id', venueId)

  if (error) {
    console.error('[admin] approval-policy update failed', { venueId, error: error.message })
    return NextResponse.json({ error: 'db_error' }, { status: 500 })
  }
  if (count === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
