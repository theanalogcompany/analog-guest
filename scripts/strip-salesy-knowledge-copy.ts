/**
 * strip-salesy-knowledge-copy.ts - one-off data fix (owner-ruled 2026-10-10).
 *
 * Seven Le Mil's knowledge_corpus rows carried sales copy rather than facts:
 * a ranking stat ("outsells every other drink by six to one"), marketing
 * superlatives ("the finest varieties", "premium"), a uniqueness boast ("isn't
 * found in India or Indian restaurants"), internal business language ("retail
 * pitching") and a discount anchor ("regularly $118.97"). A knowledge row
 * renders in tier 1, AFTER the frame, where proximity gives it the authority
 * (the v2.12.0 lesson), so "never salesy" in # Texting style was arguing with
 * its own data.
 *
 * NOT the whole picture: the line that prompted this ("Nothing else like it",
 * on the Pink Panther) is in NO row of either corpus at this venue. All six
 * Pink Panther knowledge rows and all four voice rows are factual. That half
 * is model behaviour and needs template copy, not a data fix.
 *
 * THE 6-TO-1 FIGURE IS DELIBERATELY NOT IN THE LIST BELOW. It was the eighth
 * rewrite, it was applied, and the owner then reverted it the same day
 * (revert-six-to-one.ts, which also put back the venue_info.menu copy this
 * script never touched). Leaving it here would mean a re-run silently undoes
 * that ruling, so it is recorded in this comment instead of in the data.
 *
 * MATCHES ON EXACT CONTENT, not on an id list, so the live venue and its
 * `-test` twin are both caught and a row that has already been edited is
 * reported as 0 matches rather than silently skipped. Dies before any write if
 * any pair matches nothing.
 *
 * Goes through editKnowledgeEntry, so content and embeddings move together -
 * an updated row with stale embeddings is retrievable by the old wording.
 *
 *   npx tsx --env-file=<main>/.env.local scripts/strip-salesy-knowledge-copy.ts [--apply]
 */
import { editKnowledgeEntry } from '@/app/admin/(authed)/_lib/knowledge-corpus'
import { createAdminClient } from '@/lib/db/admin'

/** Le Mil's live venue and its test twin. */
const VENUE_IDS = [
  '4c523772-34f5-48a9-b882-25ea498553e1',
  '8b985b7e-5f8d-4c67-abff-486aabaa5116',
]

interface Rewrite {
  readonly label: string
  readonly from: string
  readonly to: string
}

const REWRITES: readonly Rewrite[] = [
  {
    label: '"the finest varieties" mission copy',
    from: "Le Mil's Coffee's mission is to introduce the finest varieties of Indian coffee beans to coffee enthusiasts all over the world.",
    to: "Le Mil's Coffee's mission is to introduce Indian coffee to people all over the world.",
  },
  {
    label: 'SoFi uniqueness boast',
    from: "The SoFi name stands for South Indian Filter (or South Filter). The team coined it to give the traditional filter coffee a modern, catchy name accessible to guests who have never heard of filter coffee. It comes four ways: the SoFi Classic with simple syrup or the SoFi MJ with our in-house masala jaggery syrup, each hot or iced. The masala jaggery is a touch that isn't found in India or Indian restaurants and is Le Mil's own signature on the drink.",
    to: "The SoFi name stands for South Indian Filter (or South Filter). The team coined it to give the traditional filter coffee a name that is easier to recognize for guests who have never heard of filter coffee. It comes four ways: the SoFi Classic with simple syrup or the SoFi MJ with our in-house masala jaggery syrup, each hot or iced. The masala jaggery syrup is made in house and is Le Mil's own addition to the drink.",
  },
  {
    label: '"best-selling blend"',
    from: "The Estate Secret Coffee blend is Le Mils' best-selling blend and is included in the South Indian Filter Coffee Premium Bundle pre-ground for use with a South Indian filter.",
    to: 'The Estate Secret Coffee blend is included in the South Indian Filter Coffee Premium Bundle pre-ground for use with a South Indian filter.',
  },
  {
    label: '"best-performing products" / "retail pitching"',
    from: "Le Mil's Coffee started with 9 different coffee variations and later discontinued the lower-selling ones to focus on the best-performing products, simplifying roasting, pricing, marketing, and retail pitching.",
    to: "Le Mil's Coffee started with 9 different coffee variations and later discontinued some to focus on fewer coffees, which simplified roasting and pricing.",
  },
  {
    label: 'discount anchor',
    from: "Le Mil's sells a South Indian Filter Coffee Premium Bundle priced at $99.99, regularly $118.97.",
    to: "Le Mil's sells a South Indian Filter Coffee Premium Bundle priced at $99.99.",
  },
  {
    label: '"premium chicory root beverage"',
    from: 'Le Mils sells a product called Just Chicory, a premium chicory root beverage that serves as a coffee alternative with no caffeine.',
    to: 'Le Mils sells a product called Just Chicory, a chicory root beverage that serves as a coffee alternative with no caffeine.',
  },
]

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const db = createAdminClient()

  const { data, error } = await db
    .from('knowledge_corpus')
    .select('id, venue_id, content')
    .in('venue_id', VENUE_IDS)
  if (error) throw new Error(`read failed: ${error.message}`)
  const rows = data ?? []

  const plan = REWRITES.map((r) => ({
    rewrite: r,
    targets: rows.filter((row) => row.content === r.from),
  }))

  for (const { rewrite, targets } of plan) {
    console.log(`${rewrite.label}: ${targets.length} row(s)`)
  }

  const missed = plan.filter((p) => p.targets.length === 0)
  if (missed.length > 0) {
    throw new Error(
      `VOID RUN: no row matches ${missed.map((m) => m.rewrite.label).join(', ')}. Content drifted, so nothing was written.`,
    )
  }

  if (!apply) {
    console.log('\ndry run. re-run with --apply to write.')
    return
  }

  for (const { rewrite, targets } of plan) {
    for (const target of targets) {
      const result = await editKnowledgeEntry({
        corpusId: target.id,
        content: rewrite.to,
      })
      console.log(
        result.ok
          ? `  ok ${target.id} (re-embedded: ${result.reEmbedded})`
          : `  FAILED ${target.id}: ${result.error}`,
      )
    }
  }
}

void main()
