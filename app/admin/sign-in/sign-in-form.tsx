'use client'

import { useState } from 'react'
import { createBrowserClient } from '@/lib/db/client'

// Magic-link form. Client component; calls Supabase's signInWithOtp from
// the browser so the OTP is sent to the operator's email. The callback URL
// is constructed from NEXT_PUBLIC_ADMIN_URL (set per environment) so prod
// links bounce back to admin.theanalog.company while local + preview point
// at their respective hosts.
//
// Direct register copy throughout: "Sign in" / "Send link" / "Check your
// email." No "Welcome back to your account."

function adminUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_ADMIN_URL
  if (explicit && explicit.length > 0) return explicit
  // Fallback for Vercel preview deploys where NEXT_PUBLIC_ADMIN_URL isn't
  // pre-set. Vercel exposes the deployment host as NEXT_PUBLIC_VERCEL_URL.
  const vercelHost = process.env.NEXT_PUBLIC_VERCEL_URL
  if (vercelHost) return `https://${vercelHost}`
  // Final fallback: same-origin. Browsers resolve this to whatever host
  // the user is on, which works for localhost dev.
  if (typeof window !== 'undefined') return window.location.origin
  return ''
}

export function SignInForm() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'sending' }
    | { kind: 'sent' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (state.kind === 'sending') return
    setState({ kind: 'sending' })

    const supabase = createBrowserClient()
    const redirectTo = `${adminUrl()}/admin/auth/callback`
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    })
    if (error) {
      setState({ kind: 'error', message: "Couldn't send the link. Try again." })
      return
    }
    setState({ kind: 'sent' })
  }

  if (state.kind === 'sent') {
    return (
      <div className="text-sm text-ink leading-relaxed">
        Check your email. The link expires in an hour.
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-2">
        <span className="text-sm text-ink-soft">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="bg-paper border border-stone-light rounded-[2px] px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-clay"
          placeholder="you@theanalog.company"
        />
      </label>
      <button
        type="submit"
        disabled={state.kind === 'sending'}
        className="bg-ink text-paper text-sm font-medium px-4 py-2 rounded-[2px] hover:bg-ink-soft transition-colors disabled:opacity-50"
      >
        {state.kind === 'sending' ? 'Sending…' : 'Send link'}
      </button>
      {state.kind === 'error' ? (
        <div className="text-sm text-clay-deep">{state.message}</div>
      ) : null}
    </form>
  )
}
