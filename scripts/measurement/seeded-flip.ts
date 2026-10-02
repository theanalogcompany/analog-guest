/**
 * A deterministic [0,1) from a string seed, so a scenario sees the same coin in
 * every arm of a measurement run.
 *
 * Extracted from `intention-bubble.ts` by TAC-558, which needs the same
 * instrument. A second copy of a hash function is a second thing to get subtly
 * wrong, and the hazard here is not correctness but DISTRIBUTION, which a copy
 * would have to rediscover.
 *
 * FNV-1a WITH A MURMUR3 FINALIZER, and the finalizer is not decoration. Bare
 * FNV-1a over eighteen near-identical short ids clustered hard: TAC-554's first
 * control run produced 0.52-0.58 for s01-s09 and 0.065-0.085 for s10-s15, two
 * tight bands with nothing between, so the coin was effectively constant per
 * band rather than fair. That is an instrument that cannot represent
 * production's 50/50, which is the thing that decided TAC-554's own incident.
 *
 * This is the measurement-harness convention's point 10 in a module: a variable
 * you hold fixed is an instrument too, so check its distribution before
 * trusting a run.
 */
export function seededFlip(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return (h >>> 8) / 0x1000000
}
