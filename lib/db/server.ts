import { createServerClient as createSupabaseServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export async function createServerClient(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url) throw new Error('Missing env var: NEXT_PUBLIC_SUPABASE_URL')
  if (!key) throw new Error('Missing env var: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')

  const cookieStore = await cookies()

  return createSupabaseServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Called from a Server Component — cookies can't be written here.
          // Middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  })
}
