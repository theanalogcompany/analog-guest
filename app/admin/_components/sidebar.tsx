'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { VoiceListRow } from '../(authed)/_lib/load-voices'
import { Eyebrow } from '@/lib/ui'

// Sidebar nav for the Command Center. Keeps a thin section-list register —
// no dropdowns, no nested items, no icons. Direct copy throughout.
//
// THE-237: client component now (was server) so usePathname() can drive
// active-state highlighting. Voices group is appended below Surfaces with
// a visible vertical gap (matches the mockup's `gap: 36px` separation).

interface NavItem {
  href: string
  label: string
}

const NAV: ReadonlyArray<{ section: string; items: ReadonlyArray<NavItem> }> = [
  {
    section: 'Surfaces',
    items: [
      { href: '/admin', label: 'Home' },
      { href: '/admin/conversations', label: 'Conversations' },
      { href: '/admin/voices', label: 'Voices' },
    ],
  },
  {
    section: 'System',
    items: [{ href: '/admin/health', label: 'Health' }],
  },
]

interface SidebarProps {
  voices: VoiceListRow[]
}

export function Sidebar({ voices }: SidebarProps) {
  const pathname = usePathname()
  return (
    <nav className="w-56 shrink-0 border-r border-stone-light/60 px-6 py-8 flex flex-col gap-9">
      {/* Plain <img> instead of next/image: the asset is small (200KB,
          rendered at 144x33) and the Next image-optimization pipeline was
          intermittently failing to serve it on prod. Direct <img> is
          cheaper to render and removes a layer that can fail or get cached
          in a bad state. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/analog-full-ink.png"
        alt="The Analog Company"
        width={144}
        height={33}
      />
      <div className="flex flex-col gap-6">
        {NAV.map((group) => (
          <div key={group.section} className="flex flex-col gap-2">
            <Eyebrow>{group.section}</Eyebrow>
            <ul className="flex flex-col gap-1">
              {group.items.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== '/admin' && pathname.startsWith(`${item.href}/`))
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`block py-1 text-sm transition-colors ${
                        isActive ? 'text-clay font-medium' : 'text-ink hover:text-clay'
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}

        {voices.length > 0 && (
          <div className="flex flex-col gap-2">
            <Eyebrow>Voices · {voices.length}</Eyebrow>
            <ul className="flex flex-col gap-1">
              {voices.map((v) => {
                const href = `/admin/voices/${v.slug}`
                const isActive = pathname === href || pathname.startsWith(`${href}/`)
                return (
                  <li key={v.slug}>
                    <Link
                      href={href}
                      className={`block py-1.5 text-sm leading-tight transition-colors ${
                        isActive ? 'text-clay' : 'text-ink-soft hover:text-clay'
                      }`}
                    >
                      <span
                        className={
                          v.fallbackToVenueName
                            ? 'italic font-fraunces'
                            : 'font-fraunces italic'
                        }
                        style={{ fontVariationSettings: 'var(--fraunces-text)' }}
                      >
                        {v.displayLabel}
                      </span>
                      {!v.fallbackToVenueName && (
                        <span className="block text-[10px] text-ink-faint mt-0.5">
                          {v.venueName}
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </nav>
  )
}
