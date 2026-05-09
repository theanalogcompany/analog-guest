'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Eyebrow } from '@/lib/ui'

// Sidebar nav for the Command Center. Thin section-list register — no
// dropdowns, no nested items, no icons. Direct copy throughout.
// usePathname drives active-state highlighting on each item.

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
    items: [
      { href: '/admin/tunables', label: 'Tunables' },
      { href: '/admin/health', label: 'Health' },
    ],
  },
]

export function Sidebar() {
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
      </div>
    </nav>
  )
}
