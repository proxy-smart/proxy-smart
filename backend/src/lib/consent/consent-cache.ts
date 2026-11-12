// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FhirConsent, ConsentCacheKey, ConsentCacheEntry } from './types'
import { logger } from '../logger'

function generateCacheKey(key: ConsentCacheKey): string {
  return `${key.serverName}:${key.patientId}:${key.clientId}`
}

class ConsentCache {
  private cache = new Map<string, ConsentCacheEntry>()
  private defaultTtl: number

  constructor(defaultTtlMs: number = 60000) {
    this.defaultTtl = defaultTtlMs
  }

  get(key: ConsentCacheKey): FhirConsent[] | null {
    const cacheKey = generateCacheKey(key)
    const entry = this.cache.get(cacheKey)

    if (!entry) {
      logger.debug('consent', 'Cache miss', { key: cacheKey })
      return null
    }

    if (Date.now() > entry.expiresAt) {
      logger.debug('consent', 'Cache entry expired', { 
        key: cacheKey, 
        expiredAt: new Date(entry.expiresAt).toISOString() 
      })
      this.cache.delete(cacheKey)
      return null
    }

    logger.debug('consent', 'Cache hit', { 
      key: cacheKey, 
      consentCount: entry.consents.length,
      expiresIn: Math.round((entry.expiresAt - Date.now()) / 1000) + 's'
    })
    return entry.consents
  }

  set(key: ConsentCacheKey, consents: FhirConsent[], ttlMs?: number): void {
    const cacheKey = generateCacheKey(key)
    const ttl = ttlMs ?? this.defaultTtl
    const now = Date.now()

    const entry: ConsentCacheEntry = {
      consents,
      fetchedAt: now,
      expiresAt: now + ttl
    }

    this.cache.set(cacheKey, entry)
    logger.debug('consent', 'Cached consents', { 
      key: cacheKey, 
      consentCount: consents.length,
      ttlMs: ttl
    })
  }

  invalidate(key: ConsentCacheKey): boolean {
    const cacheKey = generateCacheKey(key)
    const existed = this.cache.has(cacheKey)
    this.cache.delete(cacheKey)
    
    if (existed) {
      logger.debug('consent', 'Cache entry invalidated', { key: cacheKey })
    }
    return existed
  }

  invalidatePatient(patientId: string, serverName?: string): number {
    let invalidated = 0
    const prefix = serverName ? `${serverName}:${patientId}:` : `:${patientId}:`
    
    for (const key of this.cache.keys()) {
      if (key.includes(prefix) || key.startsWith(`${patientId}:`)) {
        this.cache.delete(key)
        invalidated++
      }
    }
    
    if (invalidated > 0) {
      logger.debug('consent', 'Invalidated patient cache entries', { 
        patientId, 
        serverName, 
        count: invalidated 
      })
    }
    return invalidated
  }

  invalidateServer(serverName: string): number {
    let invalidated = 0
    
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${serverName}:`)) {
        this.cache.delete(key)
        invalidated++
      }
    }
    
    if (invalidated > 0) {
      logger.debug('consent', 'Invalidated server cache entries', { 
        serverName, 
        count: invalidated 
      })
    }
    return invalidated
  }

  clear(): void {
    const size = this.cache.size
    this.cache.clear()
    logger.debug('consent', 'Cache cleared', { entriesCleared: size })
  }

  getStats(): { size: number; entries: Array<{ key: string; consentCount: number; expiresIn: number }> } {
    const now = Date.now()
    const entries: Array<{ key: string; consentCount: number; expiresIn: number }> = []
    
    for (const [key, entry] of this.cache.entries()) {
      entries.push({
        key,
        consentCount: entry.consents.length,
        expiresIn: Math.max(0, Math.round((entry.expiresAt - now) / 1000))
      })
    }
    
    return {
      size: this.cache.size,
      entries
    }
  }

  cleanup(): number {
    const now = Date.now()
    let cleaned = 0
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
        cleaned++
      }
    }
    
    if (cleaned > 0) {
      logger.debug('consent', 'Cache cleanup completed', { entriesCleaned: cleaned })
    }
    return cleaned
  }

  setDefaultTtl(ttlMs: number): void {
    this.defaultTtl = ttlMs
    logger.debug('consent', 'Cache TTL updated', { ttlMs })
  }
}

export const consentCache = new ConsentCache()

export { ConsentCache }
