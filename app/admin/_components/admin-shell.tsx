import type { ReactNode } from 'react'
import type { VoiceListRow } from '../(authed)/_lib/load-voices'
import { Sidebar } from './sidebar'
import { TopBar } from './top-bar'

// Two-column layout: sidebar nav + main content area with a top bar above
// the content. Surfaces render under <main> with their own SectionHeader.
//
// THE-237: sidebar receives the voices list from the layout (loaded once
// per RSC render). Pages that need the layout to re-fetch (e.g. after a
// voiceName change) call router.refresh() on the client — that re-runs
// the (authed) layout and re-loads voices.

interface AdminShellProps {
  email: string
  voices: VoiceListRow[]
  children: ReactNode
}

export function AdminShell({ email, voices, children }: AdminShellProps) {
  return (
    <div className="flex h-screen bg-paper text-ink">
      <Sidebar voices={voices} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar email={email} />
        <main className="flex-1 overflow-auto px-8 py-10 max-w-5xl w-full">
          {children}
        </main>
      </div>
    </div>
  )
}
