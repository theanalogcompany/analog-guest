import Image from 'next/image'
import Link from 'next/link'
import { Eyebrow } from '@/lib/ui'

// Sidebar nav for the Command Center. Keeps a thin section-list register —
// no dropdowns, no nested items, no icons. Direct copy throughout. Add new
// links as new admin surfaces ship (conversation viewer, guest detail, etc.).

interface NavItem {
  href: string
  label: string
}

const NAV: ReadonlyArray<{ section: string; items: ReadonlyArray<NavItem> }> = [
  {
    section: 'Overview',
    items: [{ href: '/admin', label: 'Home' }],
  },
  {
    section: 'System',
    items: [{ href: '/admin/health', label: 'Health' }],
  },
]

export function Sidebar() {
  return (
    <nav className="w-56 shrink-0 border-r border-stone-light/60 px-6 py-8 flex flex-col gap-8">
      <Image
        src="/brand/analog-full-ink.png"
        alt="The Analog Company"
        width={144}
        height={33}
        priority
      />
      <div className="flex flex-col gap-6">
        {NAV.map((group) => (
          <div key={group.section} className="flex flex-col gap-2">
            <Eyebrow>{group.section}</Eyebrow>
            <ul className="flex flex-col gap-1">
              {group.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="block py-1 text-sm text-ink hover:text-clay transition-colors"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  )
}
