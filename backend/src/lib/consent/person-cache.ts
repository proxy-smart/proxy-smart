// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FhirPerson } from './types'
import { logger } from '../logger'
import { TtlCache } from '../cache/ttl-cache'

/** fetchedAt rides along for the cache stats; expiry is the cache's own. */
interface CachedPerson {
  person: FhirPerson | null
  fetchedAt: number
}

const personCache = new TtlCache<CachedPerson>({ ttlMs: 5 * 60 * 1000 })

function getPersonCacheKey(serverName: string, personId: string): string {
  return `${serverName}:${personId}`
}

/** undefined is a miss; a cached null is "not found", which is worth caching. */
export function getCachedPerson(serverName: string, personId: string): FhirPerson | null | undefined {
  const entry = personCache.get(getPersonCacheKey(serverName, personId))
  return entry ? entry.person : undefined
}

export function setCachedPerson(serverName: string, personId: string, person: FhirPerson | null, ttlMs: number): void {
  const key = getPersonCacheKey(serverName, personId)
  personCache.set(key, { person, fetchedAt: Date.now() }, ttlMs)

  logger.consent.debug('Cached person', {
    key,
    found: person !== null,
    ttlMs
  })
}

export function clearPersonCache(): void {
  personCache.clear()
  logger.consent.debug('Person cache cleared')
}

export function getPersonCacheStats(): { entries: number; oldestEntry: number | null } {
  let oldestEntry: number | null = null

  for (const entry of personCache.values()) {
    if (oldestEntry === null || entry.fetchedAt < oldestEntry) {
      oldestEntry = entry.fetchedAt
    }
  }

  return {
    entries: personCache.size,
    oldestEntry
  }
}
