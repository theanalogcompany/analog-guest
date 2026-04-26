import { createAdminClient } from '@/lib/db/admin'
import type { MessagingResult } from './types'

/**
 * Internal: look up a venue's messaging phone number.
 * Returns { ok: true, data: phoneNumber } on success, or a MessagingResult
 * error variant the caller can early-return directly.
 */
export async function getVenueMessagingNumber(
  venueId: string,
): Promise<MessagingResult<string>> {
  const supabase = createAdminClient()
  const { data: venue, error } = await supabase
    .from('venues')
    .select('messaging_phone_number')
    .eq('id', venueId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      return { ok: false, error: 'venue_not_found' }
    }
    return { ok: false, error: error.message, errorCode: 'venue_lookup_failed' }
  }

  if (!venue.messaging_phone_number) {
    return { ok: false, error: 'venue_has_no_messaging_number' }
  }

  return { ok: true, data: venue.messaging_phone_number }
}