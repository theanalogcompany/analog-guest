import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Eyebrow } from '@/lib/ui'
import { CommandPaletteTrigger } from './command-palette'
import { SignOutButton } from './sign-out-button'

// Top bar across the admin shell. Left: sidebar collapse trigger + the
// Command Center label. Right: ⌘K palette affordance, signed-in operator
// email, sign-out. Surfaces own their own headers via SectionHeader; no
// breadcrumbs in v1.

interface TopBarProps {
  email: string
}

export function TopBar({ email }: TopBarProps) {
  return (
    <header className="h-14 shrink-0 border-b border-stone-light/60 px-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <SidebarTrigger className="text-ink-soft" />
        <Separator orientation="vertical" className="!h-5" />
        <Eyebrow>Command Center</Eyebrow>
      </div>
      <div className="flex items-center gap-3">
        <CommandPaletteTrigger />
        <Separator orientation="vertical" className="!h-5" />
        <span className="text-sm text-ink-soft">{email}</span>
        <SignOutButton />
      </div>
    </header>
  )
}
