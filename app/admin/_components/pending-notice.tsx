'use client'

import { useEffect, useState } from 'react'

// Shown while a navigation transition is pending. `router.replace` inside
// `startTransition` keeps the OLD page on screen until the new server render
// lands, so without this the only sign of work was a disabled select - and a
// render that never finished looked identical to one still running.
//
// Mount it conditionally (`{isPending && <PendingNotice />}`): the slow timer
// starts at mount, so each navigation gets a fresh one with no reset logic.

const SLOW_AFTER_MS = 6000

export function PendingNotice() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <span role="status" className="text-xs text-ink-soft">
      {slow
        ? 'Still loading. This is taking longer than usual; an error will show if it fails.'
        : 'Loading…'}
    </span>
  )
}
