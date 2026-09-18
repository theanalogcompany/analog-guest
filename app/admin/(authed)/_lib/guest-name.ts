// Display-name helpers for guest rows. Single canonical implementation —
// the conversations viewer, voices threads list, and any future surface
// should pull from here rather than reimplement.
//
// Convention: name = "first last" trimmed; falls back to phone when both
// names are absent. `guestNameWithPhone` adds " · phone" when a name
// exists, which matches the iMessage-thread-header style the conversations
// + voices surfaces use.
//
// TAC-467: a guest can have no phone. Migration 048's
// guests_must_have_identity means such a guest has an Instagram-scoped ID
// instead, so NO_PHONE_LABEL stands in for the phone. That inference holds
// while Instagram is the only other channel; a third one makes this label
// wrong and needs the channel read from the row instead.
//
// TAC-479: where NO_PHONE_LABEL used to stand in, the guest's Instagram
// handle does once it has been fetched ("@maya.oakland"), and NO_PHONE_LABEL
// only until then. Nowhere else changes: a guest with a name still shows the
// name, and the handle never replaces a phone. The Instagram display name is
// not shown here.

export const NO_PHONE_LABEL = 'Instagram guest'

export interface GuestLikeRow {
  firstName: string | null
  lastName: string | null
  phoneNumber: string | null
  /**
   * guests.instagram_username, null until the profile has been fetched, or
   * for a guest who texts. Required rather than optional so that every loader
   * feeding these helpers has to select it: an optional field would let one
   * quietly keep showing NO_PHONE_LABEL.
   */
  instagramUsername: string | null
}

/** "@maya.oakland", or NO_PHONE_LABEL while the handle is unknown. */
function noPhoneLabel(instagramUsername: string | null): string {
  return instagramUsername ? `@${instagramUsername}` : NO_PHONE_LABEL
}

function composeName(g: GuestLikeRow): string {
  return [g.firstName, g.lastName].filter(Boolean).join(' ').trim()
}

/** "Liam Chen", or the phone if both names are absent, or the Instagram handle, or NO_PHONE_LABEL. */
export function guestDisplayName(g: GuestLikeRow): string {
  return composeName(g) || g.phoneNumber || noPhoneLabel(g.instagramUsername)
}

/**
 * "Liam Chen · +15555550142", or the phone alone if both names are absent.
 * With no phone: the name alone, or the Instagram handle, or NO_PHONE_LABEL.
 */
export function guestNameWithPhone(g: GuestLikeRow): string {
  const name = composeName(g)
  if (!g.phoneNumber) return name || noPhoneLabel(g.instagramUsername)
  return name ? `${name} · ${g.phoneNumber}` : g.phoneNumber
}

/**
 * "+17869530853" → "+1 786 953 0853" for legibility. Falls back to the raw
 * string when the format doesn't match (international numbers etc), and, when
 * there is no phone, to the Instagram handle or NO_PHONE_LABEL. Moved here from
 * guest-context.tsx (TAC-467), where `.match` on a null phone crashed the panel.
 */
export function formatGuestPhone(phone: string | null, instagramUsername: string | null): string {
  if (!phone) return noPhoneLabel(instagramUsername)
  const m = phone.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
  if (!m) return phone
  return `+1 ${m[1]} ${m[2]} ${m[3]}`
}
