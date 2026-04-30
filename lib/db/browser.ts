'use client'

import { createBrowserClient as createSupabaseBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/types'

// Browser-side Supabase client for client components that need Realtime
// subscriptions or session-aware reads. Uses the publishable (anon) key —
// RLS gates access; service-role usage stays server-side via createAdminClient.
//
// Sibling to lib/db/server.ts (cookie-bound server reads) and lib/db/admin.ts
// (service-role server writes). Adding a third entry-point because Realtime
// only works from the browser; the server clients can't open WebSocket
// channels from a server component.

let cached: SupabaseClient<Database> | null = null

export function createBrowserClient(): SupabaseClient<Database> {
  if (cached) return cached
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url) throw new Error('Missing env var: NEXT_PUBLIC_SUPABASE_URL')
  if (!key) throw new Error('Missing env var: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
  cached = createSupabaseBrowserClient<Database>(url, key)
  return cached
}
