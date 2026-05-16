// Supabase stores auth.users.phone WITHOUT the leading '+' (e.g. "18777804236").
// operators.phone_number stores E.164 WITH '+' (e.g. "+18777804236"). This
// helper bridges them at match time only — Supabase manages auth.users, so we
// cannot normalize that column at the storage layer. Idempotent: an input
// already prefixed with '+' is returned unchanged.

export function authUserPhoneToE164(
  authPhone: string | null | undefined,
): string | null {
  if (!authPhone) return null
  const trimmed = authPhone.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('+')) return trimmed
  return `+${trimmed}`
}
