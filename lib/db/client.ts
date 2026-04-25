import { createBrowserClient as createSupabaseBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

export function createBrowserClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url) throw new Error('Missing env var: NEXT_PUBLIC_SUPABASE_URL')
  if (!key) throw new Error('Missing env var: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')

  return createSupabaseBrowserClient(url, key)
}
