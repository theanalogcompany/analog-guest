// TAC-575: do generated closes repeat? The pure half.
//
// No @/* imports, no clients, no model calls; the runner that spends the model
// calls holds no scoring logic.
//
// THE BAR, pre-registered on the ticket before any generation (2026-10-06) and
// evaluated here in code rather than read off a table:
//
//   1. exact duplicates among the closes: 0
//   2. no opening four words shared by more than a quarter of them
//
// It measures REPETITION, the thing the acceptance criterion names ("no two
// guests get the identical warm close"). It says nothing about whether a close
// reads well; nothing in this repo measures that.

/** The opening-phrase width the bar names. */
export const OPENING_WORDS = 4

/** The most of the closes one opening may account for. */
export const MAX_OPENING_SHARE = 0.25

/**
 * A close as compared: lowercased, punctuation and emoji dropped, whitespace
 * collapsed. STRICTER than byte equality on purpose, in the direction that
 * finds more duplicates: two closes differing only in a full stop or an emoji
 * are the same sentence to the guest who gets them.
 */
export function foldClose(body: string): string {
  return body
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first OPENING_WORDS words of a folded close, or all of it if shorter. */
export function openingOf(body: string): string {
  return foldClose(body).split(' ').slice(0, OPENING_WORDS).join(' ')
}

export interface VarietyVerdict {
  total: number
  /** Groups of unit ids whose folded closes are identical. Bar: none. */
  duplicateGroups: string[][]
  /** Every opening and the unit ids that used it, most used first. */
  openings: { opening: string; unitIds: string[]; share: number }[]
  /** Openings over MAX_OPENING_SHARE. Bar: none. */
  overusedOpenings: { opening: string; unitIds: string[]; share: number }[]
  /**
   * Closes too short to have OPENING_WORDS words. Reported because bar 2 is
   * weaker for them: a three-word close can only collide on all three.
   */
  shortCloses: string[]
  pass: boolean
}

/**
 * Score one pool of closes against both bars.
 *
 * The share is of the POOL HANDED IN. The runner pools both kinds of close for
 * the pre-registered verdict and also scores each kind alone as information,
 * since a template can form inside one kind and hide in the mixed pool.
 */
export function scoreVariety(
  closes: readonly { id: string; body: string }[],
): VarietyVerdict {
  const byFolded = new Map<string, string[]>()
  const byOpening = new Map<string, string[]>()
  const shortCloses: string[] = []
  for (const c of closes) {
    const folded = foldClose(c.body)
    byFolded.set(folded, [...(byFolded.get(folded) ?? []), c.id])
    const opening = openingOf(c.body)
    byOpening.set(opening, [...(byOpening.get(opening) ?? []), c.id])
    if (folded.split(' ').length < OPENING_WORDS) shortCloses.push(c.id)
  }
  const total = closes.length
  const duplicateGroups = [...byFolded.values()].filter((ids) => ids.length > 1)
  const openings = [...byOpening.entries()]
    .map(([opening, unitIds]) => ({
      opening,
      unitIds,
      share: total === 0 ? 0 : unitIds.length / total,
    }))
    .sort((a, b) => b.unitIds.length - a.unitIds.length)
  const overusedOpenings = openings.filter((o) => o.share > MAX_OPENING_SHARE)
  return {
    total,
    duplicateGroups,
    openings,
    overusedOpenings,
    shortCloses,
    pass:
      total > 0 &&
      duplicateGroups.length === 0 &&
      overusedOpenings.length === 0,
  }
}
