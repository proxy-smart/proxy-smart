// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * MemoryStore Tests
 *
 * In-memory SMART launch context session store:
 * - Basic CRUD operations (set, get, update, delete)
 * - TTL-based expiration
 * - Find by predicate
 * - Cleanup of expired entries
 * - Dispose (shutdown)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

import { MemoryStore } from './memory'
import type { LaunchSession } from '../types'


// ─── Helpers ────────────────────────────────────────────────────────────────

function createSession(overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    clientRedirectUri: 'http://localhost:5176/callback',
    clientState: 'abc123',
    clientId: 'patient-portal',
    scope: 'launch/patient openid fhirUser patient/*.read',
    createdAt: Date.now(),
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MemoryStore', () => {
  let store: MemoryStore

  beforeEach(() => {
    // Short TTL and no auto-cleanup for tests
    store = new MemoryStore({ ttlMs: 5000, cleanupIntervalMs: 999_999 })
  })

  afterEach(() => {
    store.dispose()
  })

  describe('set and get', () => {
    it('stores and retrieves a session', () => {
      const session = createSession()
      store.set('key-1', session)

      const retrieved = store.get('key-1')
      expect(retrieved).not.toBeNull()
      expect(retrieved!.clientId).toBe('patient-portal')
      expect(retrieved!.clientRedirectUri).toBe('http://localhost:5176/callback')
      expect(retrieved!.clientState).toBe('abc123')
    })

    it('returns null for non-existent key', () => {
      expect(store.get('non-existent')).toBeNull()
    })

    it('stores multiple sessions independently', () => {
      store.set('key-a', createSession({ clientId: 'app-a' }))
      store.set('key-b', createSession({ clientId: 'app-b' }))

      expect(store.get('key-a')!.clientId).toBe('app-a')
      expect(store.get('key-b')!.clientId).toBe('app-b')
    })

    it('overwrites existing key', () => {
      store.set('key-1', createSession({ clientId: 'old' }))
      store.set('key-1', createSession({ clientId: 'new' }))

      expect(store.get('key-1')!.clientId).toBe('new')
    })
  })

  describe('TTL expiration', () => {
    it('returns null for expired session', () => {
      // Use a very short TTL
      const shortStore = new MemoryStore({ ttlMs: 1, cleanupIntervalMs: 999_999 })
      shortStore.set('key-1', createSession())

      // Wait for expiration (1ms TTL)
      const start = Date.now()
      while (Date.now() - start < 5) {
        // busy wait to ensure expiry
      }

      expect(shortStore.get('key-1')).toBeNull()
      shortStore.dispose()
    })

    it('returns session before TTL expires', () => {
      store.set('key-1', createSession())
      // TTL is 5000ms, should be available immediately
      expect(store.get('key-1')).not.toBeNull()
    })
  })

  describe('update', () => {
    it('updates existing session with partial data', () => {
      store.set('key-1', createSession())

      const updated = store.update('key-1', {
        patient: 'test-patient',
        encounter: 'Encounter/123',
        needsPatientPicker: false,
      })

      expect(updated).toBe(true)
      const session = store.get('key-1')!
      expect(session.patient).toBe('test-patient')
      expect(session.encounter).toBe('Encounter/123')
      expect(session.needsPatientPicker).toBe(false)
      // Original fields preserved
      expect(session.clientId).toBe('patient-portal')
    })

    it('returns false for non-existent key', () => {
      expect(store.update('ghost', { patient: 'P/1' })).toBe(false)
    })

    it('returns false for expired session', () => {
      const shortStore = new MemoryStore({ ttlMs: 1, cleanupIntervalMs: 999_999 })
      shortStore.set('key-1', createSession())

      const start = Date.now()
      while (Date.now() - start < 5) { /* busy-wait for TTL expiry */ }

      expect(shortStore.update('key-1', { patient: 'P/1' })).toBe(false)
      shortStore.dispose()
    })
  })

  describe('delete', () => {
    it('removes a session', () => {
      store.set('key-1', createSession())
      expect(store.delete('key-1')).toBe(true)
      expect(store.get('key-1')).toBeNull()
    })

    it('returns false for non-existent key', () => {
      expect(store.delete('ghost')).toBe(false)
    })
  })

  describe('find', () => {
    it('finds session matching predicate', () => {
      store.set('key-a', createSession({ clientId: 'app-a', clientRedirectUri: 'http://a/cb' }))
      store.set('key-b', createSession({ clientId: 'app-b', clientRedirectUri: 'http://b/cb' }))
      store.set('key-c', createSession({ clientId: 'app-c', clientRedirectUri: 'http://c/cb' }))

      const result = store.find(s => s.clientId === 'app-b')
      expect(result).not.toBeNull()
      expect(result![0]).toBe('key-b')
      expect(result![1].clientId).toBe('app-b')
    })

    it('returns null when no session matches', () => {
      store.set('key-a', createSession({ clientId: 'app-a' }))
      expect(store.find(s => s.clientId === 'non-existent')).toBeNull()
    })

    it('skips expired sessions', () => {
      const shortStore = new MemoryStore({ ttlMs: 1, cleanupIntervalMs: 999_999 })
      shortStore.set('key-expired', createSession({ clientId: 'expired-app' }))

      const start = Date.now()
      while (Date.now() - start < 5) { /* busy-wait for TTL expiry */ }

      expect(shortStore.find(s => s.clientId === 'expired-app')).toBeNull()
      shortStore.dispose()
    })

    it('returns first match when multiple sessions match', () => {
      store.set('key-1', createSession({ clientId: 'same-app', patient: 'P/1' }))
      store.set('key-2', createSession({ clientId: 'same-app', patient: 'P/2' }))

      const result = store.find(s => s.clientId === 'same-app')
      expect(result).not.toBeNull()
      // Map iteration order is insertion order
      expect(result![0]).toBe('key-1')
    })

    it('finds by composite predicate (clientId + redirectUri)', () => {
      store.set('key-a', createSession({ clientId: 'app-a', clientRedirectUri: 'http://a/cb' }))
      store.set('key-b', createSession({ clientId: 'app-a', clientRedirectUri: 'http://a/other' }))

      const result = store.find(
        s => s.clientId === 'app-a' && s.clientRedirectUri === 'http://a/other'
      )
      expect(result).not.toBeNull()
      expect(result![0]).toBe('key-b')
    })
  })

  describe('size', () => {
    it('returns 0 for empty store', () => {
      expect(store.size()).toBe(0)
    })

    it('returns correct count after inserts', () => {
      store.set('k1', createSession())
      store.set('k2', createSession())
      store.set('k3', createSession())
      expect(store.size()).toBe(3)
    })

    it('includes expired entries in raw count', () => {
      // size() returns Map.size which includes expired entries until cleanup
      const shortStore = new MemoryStore({ ttlMs: 1, cleanupIntervalMs: 999_999 })
      shortStore.set('k1', createSession())

      const start = Date.now()
      while (Date.now() - start < 5) { /* busy-wait for TTL expiry */ }

      // size() reports map size (expired entry not yet cleaned)
      expect(shortStore.size()).toBe(1)
      shortStore.dispose()
    })
  })

  describe('dispose', () => {
    it('clears all entries', () => {
      store.set('k1', createSession())
      store.set('k2', createSession())
      store.dispose()
      expect(store.size()).toBe(0)
    })

    it('can be called multiple times safely', () => {
      store.dispose()
      store.dispose() // no-op, should not throw
    })
  })
})
