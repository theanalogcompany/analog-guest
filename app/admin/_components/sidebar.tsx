'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  AudioLines,
  Home,
  MessagesSquare,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { isNavItemActive, NAV_GROUPS } from './nav-items'

// Command Center sidebar, rebuilt on the shadcn Sidebar family (TAC-306,
// option A). usePathname drives active state via the shared isNavItemActive
// helper; nav targets come from the shared NAV_GROUPS so the sidebar and the
// ⌘K palette stay in lockstep. collapsible="icon" gives a ⌘B-toggled icon
// rail (SidebarProvider wires the shortcut + persists the state) — icons keyed
// by href so the collapsed rail stays legible.

// Icon per nav href. Kept in the React layer (not nav-items.ts) so the shared
// nav source stays pure/unit-testable. Adding a nav item without an icon falls
// back to no glyph — visible in the expanded label, blank in the icon rail.
const NAV_ICONS: Record<string, LucideIcon> = {
  '/admin': Home,
  '/admin/conversations': MessagesSquare,
  '/admin/voices': AudioLines,
  '/admin/tunables': SlidersHorizontal,
  '/admin/health': Activity,
}

export function Sidebar() {
  const pathname = usePathname()
  return (
    <SidebarRoot collapsible="icon">
      <SidebarHeader className="px-3 py-4">
        {/* Plain <img> instead of next/image: the asset is small (200KB,
            rendered at 144x33) and the Next image-optimization pipeline was
            intermittently failing to serve it on prod. Hidden in the collapsed
            icon rail where there's no room for the wordmark. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/analog-full-ink.png"
          alt="The Analog Company"
          width={144}
          height={33}
          className="group-data-[collapsible=icon]:hidden"
        />
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.section}>
            <SidebarGroupLabel>{group.section}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = NAV_ICONS[item.href]
                const isActive = isNavItemActive(item.href, pathname)
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                    >
                      <Link href={item.href}>
                        {Icon ? <Icon /> : null}
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </SidebarRoot>
  )
}
