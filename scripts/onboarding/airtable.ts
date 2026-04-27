import Airtable from 'airtable'

export interface AirtableVenueRecord {
  id: string
  fields: Record<string, unknown>
}

/**
 * Fetch a single Airtable venue record by slug. The lookup tries both
 * lowercase (`slug`) and capitalized (`Slug`) field names — the two common
 * Airtable conventions — without making further schema assumptions about the
 * record's other fields. Returns the raw `fields` object as-is for the
 * extraction prompt to consume.
 */
export async function getAirtableRecord(slug: string): Promise<AirtableVenueRecord> {
  const apiKey = process.env.AIRTABLE_API_KEY
  if (!apiKey) throw new Error('Missing env var: AIRTABLE_API_KEY')
  const baseId = process.env.AIRTABLE_BASE_ID
  if (!baseId) throw new Error('Missing env var: AIRTABLE_BASE_ID')
  const tableId = process.env.AIRTABLE_TABLE_ID
  if (!tableId) throw new Error('Missing env var: AIRTABLE_TABLE_ID')

  const escaped = slug.replace(/'/g, "\\'")
  const base = new Airtable({ apiKey }).base(baseId)
  const records = await base(tableId)
    .select({
      filterByFormula: `OR({slug} = '${escaped}', {Slug} = '${escaped}')`,
      maxRecords: 2,
    })
    .all()

  if (records.length === 0) {
    throw new Error(
      `airtable: no record found for slug="${slug}" (tried fields: slug, Slug)`,
    )
  }
  if (records.length > 1) {
    throw new Error(`airtable: multiple records match slug="${slug}" — ambiguous`)
  }

  return {
    id: records[0].id,
    fields: records[0].fields as Record<string, unknown>,
  }
}