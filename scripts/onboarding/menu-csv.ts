import { parse } from 'csv-parse/sync'
import { MenuItemSchema, type MenuItem } from '@/lib/schemas'

const REQUIRED_COLUMNS = ['name', 'category', 'isOffMenu'] as const

function splitPipe(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// Strict TRUE/FALSE/empty per locked decision — we control the operator's CSV
// template, so loose forms ("true", "1", "yes") are intentionally rejected.
function parseBool(value: string | undefined, rowNum: number): boolean {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') return false
  if (trimmed === 'TRUE') return true
  if (trimmed === 'FALSE') return false
  throw new Error(
    `menu-csv: row ${rowNum}: invalid isOffMenu value "${value}" (must be TRUE, FALSE, or empty)`,
  )
}

function parsePrice(
  value: string | undefined,
  priceNote: string | undefined,
  rowNum: number,
): number | undefined {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') {
    if (!priceNote || priceNote.length === 0) {
      throw new Error(
        `menu-csv: row ${rowNum}: empty price requires a non-empty priceNote (item must be priced somehow)`,
      )
    }
    return undefined
  }
  const n = Number(trimmed)
  if (Number.isNaN(n)) {
    throw new Error(`menu-csv: row ${rowNum}: price "${value}" is not a number`)
  }
  return n
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Parse a menu CSV (the 04-{slug}-menu Google Sheet, exported as text/csv) into
 * a typed MenuItem array. Each row is validated against MenuItemSchema; hard
 * fails (with row number) on missing required columns or invalid values.
 *
 * Pure function — no I/O. Empty CSV (header only) returns []. Used by
 * seed-venue.ts to populate venue_configs.venue_info.menu.items.
 */
export function parseMenuCsv(csvText: string): MenuItem[] {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  }) as Array<Record<string, string>>

  if (records.length === 0) return []

  const firstRow = records[0]
  for (const col of REQUIRED_COLUMNS) {
    if (!(col in firstRow)) {
      throw new Error(
        `menu-csv: missing required column "${col}" in header (got: ${Object.keys(firstRow).join(', ')})`,
      )
    }
  }

  const items: MenuItem[] = []
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    const rowNum = i + 2 // header is line 1; data starts at line 2

    const name = nonEmpty(r.name)
    if (!name) throw new Error(`menu-csv: row ${rowNum}: empty name`)
    const category = nonEmpty(r.category)
    if (!category) throw new Error(`menu-csv: row ${rowNum}: empty category`)

    const priceNote = nonEmpty(r.priceNote)
    const price = parsePrice(r.price, priceNote, rowNum)

    const candidate = {
      name,
      size: nonEmpty(r.size),
      price,
      priceNote,
      category,
      modifiers: splitPipe(r.modifiers),
      dietary: splitPipe(r.dietary),
      description: nonEmpty(r.description),
      availability: nonEmpty(r.availability),
      isOffMenu: parseBool(r.isOffMenu, rowNum),
    }

    const parsed = MenuItemSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new Error(
        `menu-csv: row ${rowNum} failed schema validation: ${parsed.error.message}`,
      )
    }
    items.push(parsed.data)
  }

  return items
}