// TAC-582: remove a set of guests' attachments, files first.
//
// Called by the data-deletion path (lib/messaging/instagram/delete-venue-data.ts).
// That path anonymises guests in place, so no `on delete cascade` ever fires
// for it and this table, like every other guest-keyed one, has to be cleared
// by name.
//
// FILES BEFORE ROWS, and the order is the whole design. The row is the only
// record of where a file is. Delete the rows first and a failure in the
// Storage call leaves a guest's photos in the bucket with nothing pointing at
// them and no way to find them again. Files first means a failure leaves rows
// behind, and a second run finds them.
//
// THE PATH IS COMPUTED, NOT READ. A file's place is fixed by its row's ids
// (storagePathFor), so every row is asked to be removed, including one whose
// `storage_path` is still NULL. That covers the one way a file can exist with
// no path recorded: the upload landed and the row update after it did not.
// Removing a path that holds nothing is not an error.
//
// SAFE TO RUN AGAIN. A second run over the same guests finds no rows and does
// nothing, which is what lets the caller retry a deletion that failed further
// down.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

import { GUEST_MEDIA_BUCKET, storagePathFor } from './rehost'
import type { AttachmentResult } from './store'

type AdminSupabaseClient = SupabaseClient<Database>

// One page of rows per pass. Each pass deletes what it read, so the next
// read starts where this one ended and no offset is needed.
const PAGE_SIZE = 500
// Storage's remove takes a list; kept well under any request-size limit.
const REMOVE_BATCH = 100
// A guard, not a limit anyone should meet: 200 passes is 100,000 attachments.
const MAX_PASSES = 200

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

/**
 * Delete every attachment belonging to these guests at this venue: the files
 * in `guest-media`, then the rows. Returns how many rows were removed.
 */
export async function deleteAttachmentsForGuests(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestIds: readonly string[],
): Promise<AttachmentResult<{ removed: number }>> {
  if (guestIds.length === 0) return { ok: true, data: { removed: 0 } }

  let removed = 0
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const page = await supabase
      .from('message_attachments')
      .select('id, venue_id, guest_id, message_id')
      .eq('venue_id', venueId)
      .in('guest_id', [...guestIds])
      .limit(PAGE_SIZE)
    if (page.error) return { ok: false, error: page.error.message }
    const rows = page.data ?? []
    if (rows.length === 0) return { ok: true, data: { removed } }

    const paths = rows.map((row) =>
      storagePathFor({
        venueId: row.venue_id,
        guestId: row.guest_id,
        messageId: row.message_id,
        id: row.id,
      }),
    )
    for (const batch of chunk(paths, REMOVE_BATCH)) {
      const { error } = await supabase.storage
        .from(GUEST_MEDIA_BUCKET)
        .remove(batch)
      // Stop with the rows still in place: they are how a retry finds the
      // files this call did not remove.
      if (error) return { ok: false, error: error.message }
    }

    for (const batch of chunk(
      rows.map((row) => row.id),
      REMOVE_BATCH,
    )) {
      const { error } = await supabase
        .from('message_attachments')
        .delete()
        .in('id', batch)
      if (error) return { ok: false, error: error.message }
    }
    removed += rows.length
  }
  return {
    ok: false,
    error: `attachments still present after ${MAX_PASSES} passes`,
  }
}
