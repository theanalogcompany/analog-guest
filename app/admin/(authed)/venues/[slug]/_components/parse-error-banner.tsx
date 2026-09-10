import { StatusDot } from '@/lib/ui'

export function ParseErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[2px] border border-clay/40 bg-clay/5 px-4 py-3 text-sm text-clay">
      <StatusDot tone="bad" label="parse error" />
      {message}
    </div>
  )
}
