'use client'

import { Button } from '@/components/ui/button'
import { SectionHeader } from '@/lib/ui'

// Error boundary for the authed admin tree. Before this, a thrown render (a
// labeled "... load failed", or a query aborted by the Supabase client's
// timeout) fell through to Next's default screen.
//
// In production Next strips the server error's message before it reaches the
// client; only `digest` survives. It is the join key to the server log line
// (`[conversations] render failed` carries the stage it got past), so it is
// shown rather than hidden.

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex flex-col gap-6 max-w-md">
      <SectionHeader
        title="This page failed to load"
        subtitle="A query or an upstream service did not answer in time, or returned an error."
      />
      {error.digest ? (
        <div className="text-sm text-ink-soft">
          Error id <span className="font-mono">{error.digest}</span>. Search it
          in the Vercel function logs.
        </div>
      ) : null}
      <div>
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  )
}
