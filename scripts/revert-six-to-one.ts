/**
 * revert-six-to-one.ts - reverts the 6-to-1 figure removal (owner-ruled
 * 2026-10-10), in both places it was stored:
 *
 *   1. venue_info.menu.highlights[1], which renders into `# What you serve`
 *      on every turn (strip-salesy-menu-highlight.ts)
 *   2. the knowledge_corpus row, retrieved on demand
 *      (strip-salesy-knowledge-copy.ts, first entry only)
 *
 * The other six knowledge rewrites in that script STAY. This reverts one
 * figure, not the salesy-copy pass.
 *
 * Restores the originals BYTE-EXACT, em dash included: a revert that quietly
 * improves the text is not a revert, and the em dash is what was there.
 *
 *   npx tsx --env-file=<main>/.env.local scripts/revert-six-to-one.ts [--apply]
 */
import { editKnowledgeEntry } from '@/app/admin/(authed)/_lib/knowledge-corpus'
import { loadVenueInfo } from '@/app/admin/(authed)/_lib/venue-info'
import { createAdminClient } from '@/lib/db/admin'
import { toJson } from '@/lib/db/json'
import { VenueInfoSchema } from '@/lib/schemas'

const VENUE_IDS = [
  '4c523772-34f5-48a9-b882-25ea498553e1', // le-mils-coffee
  '8b985b7e-5f8d-4c67-abff-486aabaa5116', // le-mils-coffee-test
]

const CORPUS_CURRENT =
  "Filter coffee is what most guests order at Le Mil's. Himanshu has challenged the barista team to create a new drink that dethrones it. Whoever does gets a bounty. Nothing has come close yet."
const CORPUS_ORIGINAL =
  "Filter coffee outsells every other drink at Le Mil's by six to one. Himanshu has challenged the barista team to create a new drink that dethrones it — whoever does gets a bounty. Nothing has come close yet."

/** The sentence to put back, with the space that preceded it. */
const HIGHLIGHT_SUFFIX = ' Outsells every other drink 6-to-1.'
const HIGHLIGHT_ANCHOR = 'Comes with a Parle-G biscuit.'

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const db = createAdminClient()

  // --- 1. the knowledge row
  const { data: rows, error } = await db
    .from('knowledge_corpus')
    .select('id, content')
    .in('venue_id', VENUE_IDS)
  if (error) throw new Error(`read failed: ${error.message}`)

  const corpusTargets = (rows ?? []).filter((r) => r.content === CORPUS_CURRENT)
  console.log(`knowledge_corpus: ${corpusTargets.length} row(s) to revert`)
  if (corpusTargets.length === 0) {
    throw new Error(
      'VOID RUN: no knowledge row holds the edited text, so there is nothing to revert and the content has drifted.',
    )
  }

  // --- 2. the menu highlight
  const menuPlan: Array<{
    venueId: string
    next: ReturnType<typeof toJson>
  }> = []
  for (const venueId of VENUE_IDS) {
    const loaded = await loadVenueInfo(db, venueId)
    if (!loaded.ok) throw new Error(`${venueId}: ${loaded.error}`)

    const highlights = loaded.venueInfo.menu.highlights
    const hits = highlights.filter(
      (h) =>
        h.includes('SoFi') &&
        h.trimEnd().endsWith(HIGHLIGHT_ANCHOR) &&
        !h.includes(HIGHLIGHT_SUFFIX.trim()),
    )
    if (hits.length !== 1) {
      throw new Error(
        `VOID RUN: ${venueId} has ${hits.length} SoFi highlight(s) ending at the anchor, expected 1.`,
      )
    }

    const next = {
      ...loaded.venueInfo,
      menu: {
        ...loaded.venueInfo.menu,
        highlights: highlights.map((h) =>
          h === hits[0] ? `${h}${HIGHLIGHT_SUFFIX}` : h,
        ),
      },
    }
    const revalidated = VenueInfoSchema.safeParse(next)
    if (!revalidated.success) {
      throw new Error(
        `VOID RUN: ${venueId} edited venue_info does not validate: ${revalidated.error.message}`,
      )
    }
    const delta =
      JSON.stringify(revalidated.data).length -
      JSON.stringify(loaded.venueInfo).length
    if (delta !== HIGHLIGHT_SUFFIX.length) {
      throw new Error(
        `VOID RUN: ${venueId} byte delta ${delta}, expected ${HIGHLIGHT_SUFFIX.length}.`,
      )
    }
    console.log(`venue_info ${venueId}: 1 highlight to revert`)
    // toJson, exactly as the admin PATCH route does it: VenueInfoSchema
    // produces Date instances for currentContext[].addedAt, which a JSONB
    // column cannot hold. The helper round-trips them to ISO strings, which is
    // the format they were stored in.
    menuPlan.push({ venueId, next: toJson(revalidated.data) })
  }

  if (!apply) {
    console.log('\ndry run. re-run with --apply to write.')
    return
  }

  for (const target of corpusTargets) {
    const result = await editKnowledgeEntry({
      corpusId: target.id,
      content: CORPUS_ORIGINAL,
    })
    console.log(
      result.ok
        ? `  ok ${target.id} (re-embedded: ${result.reEmbedded})`
        : `  FAILED ${target.id}: ${result.error}`,
    )
  }

  for (const { venueId, next } of menuPlan) {
    const { error: writeErr } = await db
      .from('venue_configs')
      .update({ venue_info: next })
      .eq('venue_id', venueId)
    console.log(
      writeErr
        ? `  WRITE FAILED ${venueId}: ${writeErr.message}`
        : `  ok ${venueId}`,
    )
  }
}

void main()
