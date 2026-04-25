import { createServerClient } from '@/lib/db/server'

export default async function DbTestPage() {
  let response: unknown = null
  let connectionError: string | null = null

  try {
    const supabase = await createServerClient()
    response = await supabase.from('_supabase_test').select('*').limit(1)
  } catch (e) {
    connectionError = e instanceof Error ? e.message : String(e)
  }

  const ok = connectionError === null

  return (
    <main className="p-8 font-mono text-sm">
      <h1 className="text-lg mb-4">
        {ok
          ? '✓ Supabase connection OK'
          : `✗ Supabase connection failed: ${connectionError}`}
      </h1>
      <pre className="bg-gray-100 p-4 rounded whitespace-pre-wrap break-all">
        {JSON.stringify(ok ? response : { error: connectionError }, null, 2)}
      </pre>
    </main>
  )
}
