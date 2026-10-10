/**
 * strip-salesy-menu-highlight.ts - one-off data fix (owner-ruled 2026-10-10).
 *
 * The "Outsells every other drink 6-to-1" figure was stored TWICE. The
 * knowledge_corpus copy went in strip-salesy-knowledge-copy.ts; this is the
 * other one, and it was the load-bearing one: `venue_info.menu.highlights[1]`
 * renders into `# What you serve` on EVERY turn for EVERY guest, where the
 * knowledge row only appeared when retrieval returned it. The first fix was
 * reported as complete on the strength of a corpus-only audit, which is why
 * the owner could still see the figure in the prompt afterwards.
 *
 * READ-MODIFY-WRITE THROUGH VenueInfoSchema, per app/admin/CLAUDE.md: the
 * whole object is parsed, one string is edited, and the whole object is
 * validated and written back. venue_info renders into every prompt turn, so a
 * partial write that drops a sibling key is the agent losing a fact with no
 * error anywhere.
 *
 * NO EMBEDDINGS TO REFRESH, unlike the corpus fix - venue_info is rendered
 * verbatim by lib/ai/v2/venue-profile.ts and is never retrieved by similarity.
 *
 *   npx tsx --env-file=<main>/.env.local scripts/strip-salesy-menu-highlight.ts [--apply]
 */
import { loadVenueInfo } from '@/app/admin/(authed)/_lib/venue-info'
import { createAdminClient } from '@/lib/db/admin'
import { toJson } from '@/lib/db/json'
import { VenueInfoSchema } from '@/lib/schemas'

const VENUE_IDS = [
  '4c523772-34f5-48a9-b882-25ea498553e1', // le-mils-coffee
  '8b985b7e-5f8d-4c67-abff-486aabaa5116', // le-mils-coffee-test
]

/** The sentence to drop, with the space that precedes it. */
const SALESY = ' Outsells every other drink 6-to-1.'

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const db = createAdminClient()

  for (const venueId of VENUE_IDS) {
    const loaded = await loadVenueInfo(db, venueId)
    if (!loaded.ok) {
      console.log(`${venueId}: ${loaded.error}`)
      continue
    }

    const highlights = loaded.venueInfo.menu.highlights
    const targets = highlights.filter((h) => h.includes(SALESY.trim()))
    if (targets.length === 0) {
      console.log(`${venueId}: no highlight carries the figure (already done?)`)
      continue
    }

    const next = {
      ...loaded.venueInfo,
      menu: {
        ...loaded.venueInfo.menu,
        highlights: highlights.map((h) =>
          h.includes(SALESY.trim()) ? h.replace(SALESY, '').trim() : h,
        ),
      },
    }

    // Validate the WHOLE object before it goes back, not just the field.
    const revalidated = VenueInfoSchema.safeParse(next)
    if (!revalidated.success) {
      throw new Error(
        `VOID RUN: edited venue_info no longer validates for ${venueId}: ${revalidated.error.message}`,
      )
    }

    // Prove the edit changed exactly the one string and nothing else.
    const before = JSON.stringify(loaded.venueInfo)
    const after = JSON.stringify(revalidated.data)
    if (before.length - after.length !== SALESY.length * targets.length) {
      throw new Error(
        `VOID RUN: ${venueId} byte delta is ${before.length - after.length}, expected ${SALESY.length * targets.length}. Something other than the sentence changed.`,
      )
    }

    console.log(`${venueId}: ${targets.length} highlight(s) ->`)
    for (const h of revalidated.data.menu.highlights.filter((h) =>
      h.includes('SoFi'),
    )) {
      console.log(`  ${h}`)
    }

    if (!apply) continue

    const { error } = await db
      .from('venue_configs')
      // toJson, exactly as the admin PATCH route does it - see the note in
      // revert-six-to-one.ts about currentContext[].addedAt being a Date.
      .update({ venue_info: toJson(revalidated.data) })
      .eq('venue_id', venueId)
    console.log(error ? `  WRITE FAILED: ${error.message}` : '  written')
  }

  if (!apply) console.log('\ndry run. re-run with --apply to write.')
}

void main()
