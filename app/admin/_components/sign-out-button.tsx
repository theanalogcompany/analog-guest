'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { createBrowserClient } from '@/lib/db/client'

// Small client component for the top-bar sign-out action. Direct register:
// "Sign out" — no chrome, no "Are you sure?". Calls supabase.auth.signOut()
// then refreshes; the admin layout will redirect to /admin/sign-in on the
// next render because the cookie session is gone.

export function SignOutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      const supabase = createBrowserClient()
      await supabase.auth.signOut()
      router.refresh()
      router.push('/admin/sign-in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className="text-sm text-ink-soft hover:text-ink transition-colors disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
