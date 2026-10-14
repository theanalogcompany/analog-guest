// TAC-586: remove a set of guests' passport stamps, files first.
//
// Called by the data-deletion path (lib/messaging/instagram/delete-venue-data.ts).
// That path anonymises guests in place, so `on delete cascade` on
// passport_stamps never fires for it, and the stamps have to be cleared by
// name like every other guest-keyed table.
//
// WHY THE ATTACHMENT SWEEP DOES NOT COVER THESE. A stamp image that reached
// the operator thread has a message_attachments row, but the attachment sweep
// removes files at the path computed from that row's ids, and a passport image
// lives under passport/, not there. A stamp whose send failed has no
// attachment row at all. So this sweeps the passport paths itself.
//
// FILES BEFORE ROWS, and paths COMPUTED from ids, for the reasons
// lib/messaging/attachments/delete.ts gives: the row is the only record of
// where a file is, and an upload can land without its path being recorded.
// Safe to run again.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { GUEST_MEDIA_BUCKET } from '@/lib/messaging/attachments/rehost'

import { PASSPORT_IMAGES, passportImagePath } from './paths'

type AdminSupabaseClient = SupabaseClient<Database>

const PAGE_SIZE = 200
const MAX_PASSES = 200

export async function deletePassportForGuests(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestIds: readonly string[],
): Promise<
  { ok: true; data: { removed: number } } | { ok: false; error: string }
> {
  if (guestIds.length === 0) return { ok: true, data: { removed: 0 } }

  let removed = 0
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const page = await supabase
      .from('passport_stamps')
      .select('id, guest_id')
      .eq('venue_id', venueId)
      .in('guest_id', [...guestIds])
      .limit(PAGE_SIZE)
    if (page.error) return { ok: false, error: page.error.message }
    const rows = page.data ?? []
    if (rows.length === 0) return { ok: true, data: { removed } }

    const paths = rows.flatMap((row) =>
      PASSPORT_IMAGES.map((image) =>
        passportImagePath(
          { venueId, guestId: row.guest_id, stampId: row.id },
          image,
        ),
      ),
    )
    const files = await supabase.storage.from(GUEST_MEDIA_BUCKET).remove(paths)
    // Stop with the rows in place: they are how a retry finds these files.
    if (files.error) return { ok: false, error: files.error.message }

    const deleted = await supabase
      .from('passport_stamps')
      .delete()
      .eq('venue_id', venueId)
      .in(
        'id',
        rows.map((row) => row.id),
      )
    if (deleted.error) return { ok: false, error: deleted.error.message }
    removed += rows.length
  }
  return {
    ok: false,
    error: `passport stamps still present after ${MAX_PASSES} passes`,
  }
}
