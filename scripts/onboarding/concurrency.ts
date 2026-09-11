/**
 * TAC-347 Stage 1 (redesign): bounded-concurrency map. Replaces the earlier
 * Message-Batches-API proposal per plan review — "the call count is small,
 * cost isn't a constraint, and owner iteration speed matters." Runs `fn`
 * over `items` with at most `limit` in flight at once, preserving output
 * order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex
      nextIndex += 1
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
