import Link from 'next/link'
import { TESTS_SUBNAV } from './_lib/subnav'

// Shell for /admin/tests - the sub-nav shared by every test surface.
//
// The links come from TESTS_SUBNAV, which the sidebar also reads, so the
// sidebar's "Tests" children and this bar can never list different surfaces.
// Plain <Link>s and no active styling: this is a server component, active
// state would need usePathname and a client boundary, and two links do not
// earn one.

export default function TestsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-6">
      <nav className="flex gap-4 border-b border-stone-light/60 pb-3">
        {TESTS_SUBNAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  )
}
