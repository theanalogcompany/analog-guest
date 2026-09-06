// Shared guest recognition state type + normalizer. Extracted so
// `lib/operator/queue.ts` and `lib/operator/conversations.ts` don't each
// carry an independent copy of the same union, value set, and normalizer
// (final-review cleanup, conversations-endpoints branch).

export type GuestRecognitionState =
  | 'new'
  | 'returning'
  | 'regular'
  | 'raving_fan'

const RECOGNITION_STATE_VALUES: ReadonlySet<string> = new Set([
  'new',
  'returning',
  'regular',
  'raving_fan',
])

export function normalizeRecognitionState(s: string | null): GuestRecognitionState | null {
  if (s === null) return null
  return RECOGNITION_STATE_VALUES.has(s) ? (s as GuestRecognitionState) : null
}
