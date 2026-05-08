import type { ReactNode } from 'react'
import { Sidebar } from './sidebar'
import { TopBar } from './top-bar'

// Two-column layout: sidebar nav + main content area with a top bar above
// the content. Surfaces render under <main> with their own SectionHeader.

interface AdminShellProps {
  email: string
  children: ReactNode
}

export function AdminShell({ email, children }: AdminShellProps) {
  return (
    <div className="flex h-screen bg-paper text-ink">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar email={email} />
        <main className="flex-1 overflow-auto px-8 py-10 max-w-5xl w-full">
          {children}
        </main>
      </div>
    </div>
  )
}
