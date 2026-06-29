import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Token-resolution sanity for the shadcn/ui bridge (TAC-306).
//
// The acceptance criterion is "shadcn semantic tokens resolve to brand tokens
// with no missing-var fallbacks." There is no DOM/CSS runtime in this test
// harness, so we statically parse app/globals.css and assert that:
//   1. every shadcn semantic token is registered in the `@theme inline` block;
//   2. each registration is either a color literal OR a `var(--X)` whose source
//      custom property is actually defined in :root (no dangling var()).
//
// This catches the failure mode where a component class like `bg-popover`
// silently renders nothing because `--color-popover` was never bridged, or
// bridges onto a brand var that doesn't exist.

// Strip /* … */ comments before parsing — comment prose contains `--token:`
// fragments and stray semicolons that would otherwise be misread as
// declarations.
const CSS = readFileSync(
  join(process.cwd(), 'app', 'globals.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

// Every shadcn semantic color token consumed by the installed component set
// (button, card, dialog, dropdown, select, command, sidebar, …). Keep in sync
// with the bridge block in globals.css; adding a component that references a
// new token means adding it here AND to the bridge.
const REQUIRED_SHADCN_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
] as const

function extractBlock(css: string, selector: string): string {
  // Grab the body between the selector's opening brace and its matching close.
  // The blocks here are flat (no nested braces), so a non-greedy match to the
  // next `}` is sufficient.
  const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'm')
  const match = css.match(re)
  if (!match) throw new Error(`block not found: ${selector}`)
  return match[1]
}

function declaredVars(block: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1].trim(), m[2].trim())
  }
  return map
}

const themeInline = extractBlock(CSS, '@theme inline')
const themeVars = declaredVars(themeInline)

// Source custom properties live on :root plus the admin surface override.
const rootVars = declaredVars(extractBlock(CSS, ':root'))
const adminVars = declaredVars(extractBlock(CSS, '\\[data-surface="admin"\\]'))
const sourceVarNames = new Set<string>([...rootVars.keys(), ...adminVars.keys()])

describe('shadcn token bridge', () => {
  it.each(REQUIRED_SHADCN_TOKENS)(
    'registers --color-%s in @theme inline',
    (token) => {
      expect(themeVars.has(`--color-${token}`)).toBe(true)
    },
  )

  it.each(REQUIRED_SHADCN_TOKENS)(
    '--color-%s resolves to a defined source var or a literal',
    (token) => {
      const value = themeVars.get(`--color-${token}`)
      expect(value).toBeTruthy()
      const varRef = value!.match(/^var\((--[\w-]+)\)$/)
      if (varRef) {
        // Aliased onto a brand/source var — that var must actually be defined,
        // otherwise the utility falls back to nothing at runtime.
        expect(sourceVarNames).toContain(varRef[1])
      } else {
        // Inline literal (hex/rgb/hsl). Acceptable; just must be non-empty.
        expect(value!.length).toBeGreaterThan(0)
      }
    },
  )

  it('keeps the brand admin override a strict subset of :root vars', () => {
    // Every var rebound under [data-surface="admin"] must also exist in :root,
    // or the override is binding a token that nothing reads.
    for (const name of adminVars.keys()) {
      expect(rootVars.has(name)).toBe(true)
    }
  })

  it('defines the non-brand literals the bridge depends on (--destructive, --radius)', () => {
    expect(rootVars.has('--destructive')).toBe(true)
    expect(rootVars.has('--radius')).toBe(true)
  })
})
