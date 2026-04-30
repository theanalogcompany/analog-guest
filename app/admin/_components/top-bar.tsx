import { Eyebrow } from '@/lib/ui'
import { SignOutButton } from './sign-out-button'

// Top bar across the admin shell. Left: minimal context label (admin
// surface name). Right: signed-in operator email + sign-out. No chrome,
// no breadcrumbs in v1 — surfaces own their own headers via SectionHeader.

interface TopBarProps {
  email: string
}

export function TopBar({ email }: TopBarProps) {
  return (
    <header className="h-14 shrink-0 border-b border-stone-light/60 px-8 flex items-center justify-between">
      <Eyebrow>Command Center</Eyebrow>
      <div className="flex items-center gap-4">
        <span className="text-sm text-ink-soft">{email}</span>
        <span className="text-stone-light" aria-hidden>
          ·
        </span>
        <SignOutButton />
      </div>
    </header>
  )
}
