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

export const NO_PHONE_LABEL = 'Instagram guest'

export interface GuestLikeRow {
  firstName: string | null
  lastName: string | null
  phoneNumber: string | null
}

function composeName(g: GuestLikeRow): string {
  return [g.firstName, g.lastName].filter(Boolean).join(' ').trim()
}

/** "Liam Chen", or the phone if both names are absent, or NO_PHONE_LABEL. */
export function guestDisplayName(g: GuestLikeRow): string {
  return composeName(g) || g.phoneNumber || NO_PHONE_LABEL
}

/**
 * "Liam Chen · +15555550142", or the phone alone if both names are absent.
 * With no phone: the name alone, or NO_PHONE_LABEL.
 */
export function guestNameWithPhone(g: GuestLikeRow): string {
  const name = composeName(g)
  if (!g.phoneNumber) return name || NO_PHONE_LABEL
  return name ? `${name} · ${g.phoneNumber}` : g.phoneNumber
}

/**
 * "+17869530853" → "+1 786 953 0853" for legibility. Falls back to the raw
 * string when the format doesn't match (international numbers etc), and to
 * NO_PHONE_LABEL when there is no phone. Moved here from guest-context.tsx
 * (TAC-467), where `.match` on a null phone crashed the panel.
 */
export function formatGuestPhone(phone: string | null): string {
  if (!phone) return NO_PHONE_LABEL
  const m = phone.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
  if (!m) return phone
  return `+1 ${m[1]} ${m[2]} ${m[3]}`
}
