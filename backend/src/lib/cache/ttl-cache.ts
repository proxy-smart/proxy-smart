// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** TTL cache. `getOrLoad` collapses concurrent misses onto a single load. */

export interface TtlCacheOptions {
  /** Default entry lifetime. `set` and `getOrLoad` may override it per entry. */
  ttlMs: number
  /** Cap on live entries; the soonest-expiring entry is dropped past it. */
  maxEntries?: number
  /** Background sweep interval. Without it, entries are dropped on read. */
  cleanupIntervalMs?: number
}

interface Entry<TValue> {
  value: TValue
  expiresAt: number
}

export class TtlCache<TValue> {
  private readonly entries = new Map<string, Entry<TValue>>()
  private readonly inFlight = new Map<string, Promise<TValue>>()
  private readonly ttlMs: number
  private readonly maxEntries: number | null
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs
    this.maxEntries = options.maxEntries ?? null

    if (options.cleanupIntervalMs) {
      this.sweeper = setInterval(() => this.sweep(), options.cleanupIntervalMs)
      if (this.sweeper.unref) this.sweeper.unref()
    }
  }

  get(key: string): TValue | undefined {
    const entry = this.live(key)
    return entry ? entry.value : undefined
  }

  /** Distinguishes a cached `null`/`undefined` value from a miss, which `get` cannot. */
  has(key: string): boolean {
    return this.live(key) !== null
  }

  set(key: string, value: TValue, ttlMs?: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.ttlMs) })
    if (this.maxEntries !== null && this.entries.size > this.maxEntries) {
      this.evictSoonestToExpire()
    }
  }

  /** Cached value, or `load()`'s. A rejection is not cached. `ttlMs` may derive from the value. */
  async getOrLoad(
    key: string,
    load: () => Promise<TValue>,
    ttlMs?: number | ((value: TValue) => number),
  ): Promise<TValue> {
    const entry = this.live(key)
    if (entry) return entry.value

    const pending = this.inFlight.get(key)
    if (pending) return pending

    const promise = load()
      .then(value => {
        this.set(key, value, typeof ttlMs === 'function' ? ttlMs(value) : ttlMs)
        return value
      })
      .finally(() => {
        this.inFlight.delete(key)
      })

    this.inFlight.set(key, promise)
    return promise
  }

  delete(key: string): boolean {
    this.inFlight.delete(key)
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.inFlight.clear()
  }

  /** Live entries only; expired ones are dropped as a side effect. */
  get size(): number {
    this.sweep()
    return this.entries.size
  }

  keys(): string[] {
    this.sweep()
    return Array.from(this.entries.keys())
  }

  values(): TValue[] {
    this.sweep()
    return Array.from(this.entries.values(), entry => entry.value)
  }

  dispose(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }
    this.clear()
  }

  private live(key: string): Entry<TValue> | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key)
      return null
    }
    return entry
  }

  private sweep(): void {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key)
    }
  }

  private evictSoonestToExpire(): void {
    let target: string | null = null
    let soonest = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt < soonest) {
        soonest = entry.expiresAt
        target = key
      }
    }
    if (target !== null) this.entries.delete(target)
  }
}
