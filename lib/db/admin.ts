// This client uses the Supabase service-role key and BYPASSES RLS.
// It must only be used in trusted server contexts (cron jobs, webhook handlers,
// internal route handlers). Never import this in client components, edge
// middleware, or any code path that runs in response to untrusted input without
// prior auth checks.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/types'

export interface AdminClientOptions {
  /**
   * Abort any single request after this many ms. Opt-in: supabase-js has no
   * timeout of its own, so a stalled query otherwise holds the caller until
   * the platform kills the function. Only interactive surfaces (the admin
   * pages) set it; webhook and cron callers keep the unbounded default.
   */
  timeoutMs?: number
}

// Composes with a caller-supplied signal rather than replacing it.
export function fetchWithTimeout(
  timeoutMs: number,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout
    return baseFetch(input, { ...init, signal })
  }
}

export function createAdminClient(
  options: AdminClientOptions = {},
): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url) throw new Error('Missing env var: NEXT_PUBLIC_SUPABASE_URL')
  if (!key) throw new Error('Missing env var: SUPABASE_SECRET_KEY')

  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    ...(options.timeoutMs
      ? { global: { fetch: fetchWithTimeout(options.timeoutMs) } }
      : {}),
  })
}
