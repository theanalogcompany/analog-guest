// TAC-469: which channel a guest last messaged us on.
//
// Read only for a guest with BOTH a phone number and an Instagram ID when there
// is no inbound message to decide it (see conversation-channel.ts). Shared by
// buildRuntimeContext and the Command Center Follow Up route, so the channel a
// reply is worded for and the channel it would be routed to come from the same
// read.
//
// Returns null when the guest has no inbound message or the read fails; the
// resolver then falls back to the phone number, as before TAC-469. A failed
// read is warned, never thrown: it decides a fallback, not a send.

import { createAdminClient } from '@/lib/db/admin'
import { parseMessageChannel, type MessageChannel } from '@/lib/schemas/message-channel'

export async function loadLastInboundChannel(
  venueId: string,
  guestId: string,
  supabase: ReturnType<typeof createAdminClient> = createAdminClient(),
): Promise<MessageChannel | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('channel')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn('[agent] last inbound channel unreadable; falling back to the phone number', {
      venueId,
      guestId,
      error: error.message,
    })
    return null
  }
  return data ? parseMessageChannel(data.channel) : null
}
