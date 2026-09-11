/**
 * A size-capped Map that evicts least-recently-used entries once the cap is
 * reached (issue #113). Recency is refreshed by both get and set. Backs the
 * engine's per-session caches so idle sessions can be dropped and later
 * rebuilt from the durable session log instead of accumulating forever.
 * @module billion-context-dsh/lru
 */

/** Default cap for the engine's per-session caches (kernel states, nudge dedup). */
export const DEFAULT_SESSION_CACHE_LIMIT = 512

export class LruMap<K, V> extends Map<K, V> {
  private readonly maxEntries: number

  constructor(maxEntries: number) {
    super()
    this.maxEntries = Math.max(1, Math.floor(maxEntries))
  }

  get(key: K): V | undefined {
    if (!super.has(key)) return undefined
    const value = super.get(key)!
    super.delete(key)
    super.set(key, value)
    return value
  }

  set(key: K, value: V): this {
    super.delete(key)
    super.set(key, value)
    while (this.size > this.maxEntries) {
      const oldest = this.keys().next().value
      if (oldest === undefined) break
      super.delete(oldest)
    }
    return this
  }
}
