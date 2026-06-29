import type { ReactNode } from 'react'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { CommandPaletteProvider } from './command-palette'
import { Sidebar } from './sidebar'
import { TopBar } from './top-bar'

// Command Center shell (TAC-306, option A): shadcn SidebarProvider + Sidebar +
// SidebarInset, wrapped in the ⌘K CommandPaletteProvider. SidebarInset is the
// <main> region; the content frame (px-8 py-10, max-w-5xl) is preserved from
// the prior shell so surfaces render unchanged. The auth gate that renders
// this component lives in app/admin/(authed)/layout.tsx and is untouched.

interface AdminShellProps {
  email: string
  children: ReactNode
}

export function AdminShell({ email, children }: AdminShellProps) {
  return (
    <CommandPaletteProvider>
      <SidebarProvider>
        <Sidebar />
        <SidebarInset>
          <TopBar email={email} />
          <div className="flex-1 overflow-auto px-8 py-10 w-full max-w-5xl">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </CommandPaletteProvider>
  )
}
