import { NextResponse } from 'next/server'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'

// DELETE /admin/conversations/api/transactions/[transactionId] — TAC-323.
//
// A false-positive order extraction is otherwise unrecoverable: the bad row
// permanently disarms lib/agent/extract-reported-order.ts's gate condition 2
// for that guest, so their real order can never be recorded. This is the
// recovery path — delete only, no editing of items or amounts, and
// restricted to source='guest_reported' rows (no other source is deletable
// from this surface). Deleting needs no separate re-arm flag: the extractor
// gate reads the transactions table directly, so the row's absence IS the
// re-arm.
//
// Auth pattern mirrors the within-surface precedent at
// conversations/api/review/[messageId]/route.ts exactly: cookie-session auth
// via createServerClient() + verifyAnalogAdminAccess, then a venue-allowlist
// check with the same "empty allowedVenueIds ⇒ analog admin sees every
// venue" convention.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const dynamic = 'force-dynamic'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ transactionId: string }> },
): Promise<NextResponse> {
  // ---- auth ----
  let allowedVenueIds: string[]
  try {
    const supabaseSession = await createServerClient()
    const {
      data: { session },
    } = await supabaseSession.auth.getSession()
    if (!session) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const op = await verifyAnalogAdminAccess(session.user.id)
    allowedVenueIds = op.allowedVenueIds
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: 'auth check failed' }, { status: 500 })
  }

  // ---- params ----
  const { transactionId } = await params
  if (!UUID_RE.test(transactionId)) {
    return NextResponse.json({ error: 'invalid transactionId' }, { status: 400 })
  }

  // ---- lookup + venue allowlist + source restriction ----
  const supabase = createAdminClient()
  const { data: transaction, error: lookupError } = await supabase
    .from('transactions')
    .select('id, venue_id, source')
    .eq('id', transactionId)
    .maybeSingle()
  if (lookupError) {
    return NextResponse.json(
      { error: 'transaction lookup failed', detail: lookupError.message },
      { status: 500 },
    )
  }
  if (!transaction) {
    return NextResponse.json({ error: 'transaction not found' }, { status: 404 })
  }
  // Empty allowedVenueIds means analog admin sees every venue (matches the
  // page-level allowlist treatment in conversations/page.tsx).
  if (allowedVenueIds.length > 0 && !allowedVenueIds.includes(transaction.venue_id)) {
    return NextResponse.json({ error: 'venue not allowed' }, { status: 403 })
  }
  if (transaction.source !== 'guest_reported') {
    return NextResponse.json(
      { error: 'only guest-reported transactions can be deleted from this surface' },
      { status: 400 },
    )
  }

  // ---- delete ----
  const { error: deleteError } = await supabase
    .from('transactions')
    .delete()
    .eq('id', transactionId)
  if (deleteError) {
    return NextResponse.json(
      { error: 'transaction delete failed', detail: deleteError.message },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, deleted: true })
}
