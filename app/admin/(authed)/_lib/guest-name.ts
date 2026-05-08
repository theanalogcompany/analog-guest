// Display-name helpers for guest rows. Single canonical implementation —
// the conversations viewer, voices threads list, and any future surface
// should pull from here rather than reimplement.
//
// Convention: name = "first last" trimmed; falls back to phone when both
// names are absent. `guestNameWithPhone` adds " · phone" when a name
// exists, which matches the iMessage-thread-header style the conversations
// + voices surfaces use.

export interface GuestLikeRow {
  firstName: string | null
  lastName: string | null
  phoneNumber: string
}

/** "Liam Chen" or "+15555550142" if both names absent. */
export function guestDisplayName(g: GuestLikeRow): string {
  const name = [g.firstName, g.lastName].filter(Boolean).join(' ').trim()
  return name || g.phoneNumber
}

/** "Liam Chen · +15555550142" or just the phone if both names absent. */
export function guestNameWithPhone(g: GuestLikeRow): string {
  const name = [g.firstName, g.lastName].filter(Boolean).join(' ').trim()
  return name ? `${name} · ${g.phoneNumber}` : g.phoneNumber
}
