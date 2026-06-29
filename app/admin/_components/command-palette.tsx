'use client'

import { useRouter } from 'next/navigation'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { NAV_GROUPS } from './nav-items'

// ⌘K / Ctrl+K command palette for jumping between Command Center surfaces
// (TAC-306). The one intentional new interaction in the shell reskin —
// everything else stays behavior-identical. Targets come from the shared
// NAV_GROUPS so the palette can never drift from the sidebar.
//
// Shape: a provider holds the open state, owns the global key listener, and
// renders the dialog once; the top bar's ⌘K button opens it via the
// useCommandPalette() hook. (The sidebar's own ⌘B collapse is wired
// separately by SidebarProvider — no conflict.)

interface CommandPaletteApi {
  open: () => void
}

const CommandPaletteContext = createContext<CommandPaletteApi | null>(null)

export function useCommandPalette(): CommandPaletteApi {
  const ctx = useContext(CommandPaletteContext)
  if (!ctx) {
    throw new Error('useCommandPalette must be used within CommandPaletteProvider')
  }
  return ctx
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  function go(href: string) {
    setOpen(false)
    router.push(href)
  }

  const api = useMemo<CommandPaletteApi>(() => ({ open: () => setOpen(true) }), [])

  return (
    <CommandPaletteContext.Provider value={api}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command Center navigation"
        description="Jump to a surface"
      >
        <CommandInput placeholder="Jump to a surface…" />
        <CommandList>
          <CommandEmpty>No surface found.</CommandEmpty>
          {NAV_GROUPS.map((group) => (
            <CommandGroup key={group.section} heading={group.section}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.href}
                  value={item.label}
                  onSelect={() => go(item.href)}
                >
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </CommandPaletteContext.Provider>
  )
}

// Top-bar affordance that opens the palette and advertises the shortcut.
export function CommandPaletteTrigger() {
  const { open } = useCommandPalette()
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={open}
      className="text-ink-soft"
      aria-label="Open command palette"
    >
      Jump to…
      <kbd className="pointer-events-none ml-1 inline-flex h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground select-none">
        ⌘K
      </kbd>
    </Button>
  )
}
