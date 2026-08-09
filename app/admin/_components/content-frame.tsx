'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

// TAC-316: the admin content frame, extracted from AdminShell so its width
// cap can be route-scoped. Default is the original left-pinned max-w-5xl —
// every existing surface renders unchanged. Routes in FULL_WIDTH_ROUTES drop
// the cap so their detail panels flex into the full viewport width
// (conversations: thread column stays 400px, the trace/review side panel and
// context cards absorb the recovered space — deliberately NOT centered, per
// the TAC-316 layout ruling).
//
// Adding a full-width surface = add its route prefix here. Keep this list
// short and explicit; a surface that wants full width should be designed for
// it (the padded max-w-5xl default is the right reading width for everything
// else).

const FULL_WIDTH_ROUTES = ['/admin/conversations']

interface ContentFrameProps {
  children: ReactNode
}

export function ContentFrame({ children }: ContentFrameProps) {
  const pathname = usePathname()
  const fullWidth = FULL_WIDTH_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  )
  return (
    <div className={`flex-1 overflow-auto px-8 py-10 w-full ${fullWidth ? '' : 'max-w-5xl'}`}>
      {children}
    </div>
  )
}
