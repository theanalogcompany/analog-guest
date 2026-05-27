// POST /api/operator/devices — operator app registers its APNs device token
// (TAC-207). Single token per operator for pilot; multi-device deferred.
//
// Re-registration is idempotent: the same token from the same operator just
// refreshes apns_token_updated_at. A NEW token (e.g. iPhone reinstall after
// the previous token went 410) overwrites the prior value.
//
// Auth: `withOperatorAuth` resolves the bearer JWT to the operator row. No
// venue-scoping needed — the operator can only update their own row.
//
// Format validation is intentionally loose: Apple says APNs tokens are
// opaque, "do not assume a fixed length." We reject non-hex / empty /
// absurd-length values but don't enforce 64 chars. The mobile client is
// trusted at this boundary (it's the operator's own app).

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { withOperatorAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'

export const dynamic = 'force-dynamic'

const HEX_RE = /^[0-9a-f]+$/i

const BodySchema = z.object({
  deviceToken: z
    .string()
    .min(32, 'deviceToken too short')
    .max(256, 'deviceToken too long')
    .regex(HEX_RE, 'deviceToken must be hex'),
})

export const POST = withOperatorAuth(async (request, { operator }) => {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', detail: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()
  const { error } = await supabase
    .from('operators')
    .update({
      apns_device_token: parsed.data.deviceToken,
      apns_token_updated_at: new Date().toISOString(),
    })
    .eq('id', operator.operatorId)
  if (error) {
    console.error('apns: device-token upsert failed', {
      operatorId: operator.operatorId,
      error: error.message,
    })
    return NextResponse.json(
      { error: 'internal error', detail: error.message },
      { status: 500 },
    )
  }

  return NextResponse.json({ status: 'registered' })
})
