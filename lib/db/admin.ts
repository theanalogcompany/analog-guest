// This client uses the Supabase service-role key and BYPASSES RLS.
// It must only be used in trusted server contexts (cron jobs, webhook handlers,
// internal route handlers). Never import this in client components, edge
// middleware, or any code path that runs in response to untrusted input without
// prior auth checks.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/types'

export function createAdminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url) throw new Error('Missing env var: NEXT_PUBLIC_SUPABASE_URL')
  if (!key) throw new Error('Missing env var: SUPABASE_SECRET_KEY')

  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
