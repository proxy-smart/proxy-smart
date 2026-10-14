/**
 * @proxy-smart/auth — In-Memory Launch Context Store
 *
 * Map-backed session store with TTL-based expiration.
 * Suitable for single-node deployments. For HA, implement ILaunchContextStore with Redis.
 */

import type { LaunchSession, SmartProxyLogger } from '../types'
import type { ILaunchContextStore, LaunchContextStoreOptions } from './interface'

export class MemoryStore implements ILaunchContextStore {
  private store = new Map<string, { session: LaunchSession; expiresAt: number }>()
  private ttlMs: number
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private logger?: SmartProxyLogger

  constructor(options: LaunchContextStoreOptions & { logger?: SmartProxyLogger } = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000
    this.logger = options.logger
    const cleanupInterval = options.cleanupIntervalMs ?? 60_000

    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval)
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  set(key: string, session: LaunchSession): void {
    this.store.set(key, {
      session,
      expiresAt: Date.now() + this.ttlMs,
    })
    this.logger?.debug('Launch session stored', { key: key.slice(0, 8) + '...', clientId: session.clientId })
  }

  get(key: string): LaunchSession | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      this.logger?.debug('Launch session expired', { key: key.slice(0, 8) + '...' })
      return null
    }
    return entry.session
  }

  update(key: string, partial: Partial<LaunchSession>): boolean {
    const entry = this.store.get(key)
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.store.delete(key)
      return false
    }
    entry.session = { ...entry.session, ...partial }
    return true
  }

  delete(key: string): boolean {
    return this.store.delete(key)
  }

  find(predicate: (session: LaunchSession) => boolean): [string, LaunchSession] | null {
    const now = Date.now()
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) continue
      if (predicate(entry.session)) {
        return [key, entry.session]
      }
    }
    return null
  }

  size(): number {
    return this.store.size
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.store.clear()
  }

  private cleanup(): void {
    const now = Date.now()
    let cleaned = 0
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key)
        cleaned++
      }
    }
    if (cleaned > 0) {
      this.logger?.debug('Launch store cleanup', { removed: cleaned, remaining: this.store.size })
    }
  }
}
