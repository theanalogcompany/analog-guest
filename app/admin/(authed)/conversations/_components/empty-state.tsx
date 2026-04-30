import { Eyebrow, SectionHeader } from '@/lib/ui'
import { RecentActivity, type RecentActivityRow } from './recent-activity'

// What you see before / between filter selections. Pre-filter: prompt + recent
// activity. Mid-filter (venue picked, no guest yet): same shell, recent
// activity scoped to that venue. No-conversation (both filters set, no
// messages): handled inside the conversation column itself, not here.

interface EmptyStateProps {
  variant: 'pre-filter' | 'venue-only'
  recentRows: RecentActivityRow[]
}

export function EmptyState({ variant, recentRows }: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-stretch p-12 max-w-3xl mx-auto w-full gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>Conversations</Eyebrow>
        <SectionHeader
          title={variant === 'pre-filter' ? 'Pick a venue and guest' : 'Pick a guest'}
          subtitle={
            variant === 'pre-filter'
              ? 'Select a venue to see active guests, then pick one to load the conversation.'
              : 'Pick from this venue’s recent guests, or use the dropdown above.'
          }
        />
      </div>

      <RecentActivity
        rows={recentRows}
        emptyMessage={
          variant === 'pre-filter'
            ? 'No recent activity across your venues yet.'
            : 'No recent activity at this venue.'
        }
      />
    </div>
  )
}
