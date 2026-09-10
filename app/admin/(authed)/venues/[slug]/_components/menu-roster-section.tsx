import type { VenueInfo } from '@/lib/schemas'
import { HairlineRow } from '@/lib/ui'
import { EmptySectionNote, SectionShell } from './section-shell'

function formatPrice(item: VenueInfo['menu']['items'][number]): string {
  if (item.price !== undefined) return `$${item.price.toFixed(2)}`
  if (item.priceNote) return item.priceNote
  return '—'
}

// The technical roster — item name, price, one row per item. Distinct from
// MenuKnowledgeSection (what the owner said ABOUT these items). §2:
// "the menu appears twice, on purpose."
export function MenuRosterSection({ venueInfo }: { venueInfo: VenueInfo }) {
  const { items, notes, highlights } = venueInfo.menu

  return (
    <SectionShell title="The menu" subtitle="roster">
      {items.length === 0 ? (
        <EmptySectionNote>No menu items on file yet.</EmptySectionNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-light/60 text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-2 pr-3 font-normal">Item</th>
                <th className="py-2 pr-3 font-normal">Category</th>
                <th className="py-2 pr-3 font-normal text-right tabular-nums">Price</th>
                <th className="py-2 font-normal">Notes</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr
                  key={`${item.name}-${item.size ?? ''}-${i}`}
                  className="border-b border-stone-light/30 last:border-b-0"
                >
                  <td className="py-2 pr-3 text-ink">
                    {item.name}
                    {item.size ? ` (${item.size})` : ''}
                    {item.isOffMenu && (
                      <span className="ml-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
                        off-menu
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-ink-soft">{item.category}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-ink">
                    {formatPrice(item)}
                  </td>
                  <td className="py-2 text-ink-faint">{item.description ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notes && <p className="mt-4 text-sm text-ink-soft">{notes}</p>}

      <div className="mt-6 border-t border-stone-light/60 pt-4">
        <p className="mb-1 text-xs uppercase tracking-wide text-ink-faint">Highlights</p>
        {/*
          TAC-331 ruling, carried forward: highlights are facts about what's
          on the menu, not advice about what to order. The extraction bug
          that produced "first-timer pick" / opinionated-recommendation
          prose in this exact field is what made the agent recommend a
          latte to a guest already holding a drink — this field renders on
          every prompt turn, so a stray piece of advice here isn't cosmetic.
          Recommendations belong in knowledge_corpus (Menu knowledge above),
          gated by retrieval; this list is always-on.
        */}
        <p className="mb-3 text-xs italic text-ink-faint">
          Facts about what&apos;s on the menu, not advice about what to order —
          recommendations belong in Menu knowledge above.
        </p>
        {highlights.length === 0 ? (
          <EmptySectionNote>No highlights on file yet.</EmptySectionNote>
        ) : (
          <ul className="flex flex-col">
            {highlights.map((highlight, i) => (
              <HairlineRow key={`${highlight}-${i}`} last={i === highlights.length - 1}>
                <span className="text-sm text-ink">{highlight}</span>
              </HairlineRow>
            ))}
          </ul>
        )}
      </div>
    </SectionShell>
  )
}
