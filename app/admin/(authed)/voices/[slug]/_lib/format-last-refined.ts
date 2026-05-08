// Pure formatter for the topbar "Last refined Xh ago" string. Mirrors
// formatTimeDelta over in lib/ai/prompts/serializers.ts but with longer-
// range buckets ("3d", "2w") since refinement events fire infrequently.

export function formatLastRefined(when: Date | null, now: Date = new Date()): string {
  if (!when) return '—'
  const diffMs = now.getTime() - when.getTime()
  if (diffMs < 0) return 'just now'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 8) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}
