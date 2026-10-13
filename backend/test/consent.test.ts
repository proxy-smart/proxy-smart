/**
 * Consent Enforcement Tests
 * 
 * Unit tests for the consent enforcement module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ConsentCache } from '../src/lib/consent/consent-cache'
import { buildConsentContext } from '../src/lib/consent/consent-service'
import type { FhirConsent, SmartTokenPayload } from '../src/lib/consent/types'

describe('ConsentCache', () => {
  let cache: ConsentCache

  beforeEach(() => {
    cache = new ConsentCache(1000) // 1 second TTL for tests
  })

  afterEach(() => {
    cache.clear()
  })

  describe('get/set', () => {
    it('should return null for cache miss', () => {
      const result = cache.get({
        patientId: 'patient-1',
        clientId: 'client-1',
        serverName: 'server-1'
      })
      expect(result).toBeNull()
    })

    it('should return cached consents on cache hit', () => {
      const key = {
        patientId: 'patient-1',
        clientId: 'client-1',
        serverName: 'server-1'
      }
      const consents: FhirConsent[] = [{
        resourceType: 'Consent',
        id: 'consent-1',
        status: 'active',
        scope: { coding: [{ code: 'patient-privacy' }] },
        category: []
      }]

      cache.set(key, consents)
      const result = cache.get(key)

      expect(result).toEqual(consents)
    })

    it('should return null for expired entries', async () => {
      const key = {
        patientId: 'patient-1',
        clientId: 'client-1',
        serverName: 'server-1'
      }
      const consents: FhirConsent[] = [{
        resourceType: 'Consent',
        id: 'consent-1',
        status: 'active',
        scope: { coding: [{ code: 'patient-privacy' }] },
        category: []
      }]

      cache.set(key, consents, 50) // 50ms TTL
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const result = cache.get(key)
      expect(result).toBeNull()
    })
  })

  describe('invalidate', () => {
    it('should invalidate specific cache entry', () => {
      const key1 = { patientId: 'p1', clientId: 'c1', serverName: 's1' }
      const key2 = { patientId: 'p2', clientId: 'c2', serverName: 's1' }
      
      cache.set(key1, [])
      cache.set(key2, [])
      
      cache.invalidate(key1)
      
      expect(cache.get(key1)).toBeNull()
      expect(cache.get(key2)).toEqual([])
    })

    it('should invalidate all entries for a patient', () => {
      const key1 = { patientId: 'p1', clientId: 'c1', serverName: 's1' }
      const key2 = { patientId: 'p1', clientId: 'c2', serverName: 's1' }
      const key3 = { patientId: 'p2', clientId: 'c1', serverName: 's1' }
      
      cache.set(key1, [])
      cache.set(key2, [])
      cache.set(key3, [])
      
      const count = cache.invalidatePatient('p1')
      
      expect(count).toBe(2)
      expect(cache.get(key1)).toBeNull()
      expect(cache.get(key2)).toBeNull()
      expect(cache.get(key3)).toEqual([])
    })

    it('should invalidate all entries for a server', () => {
      const key1 = { patientId: 'p1', clientId: 'c1', serverName: 's1' }
      const key2 = { patientId: 'p2', clientId: 'c2', serverName: 's1' }
      const key3 = { patientId: 'p1', clientId: 'c1', serverName: 's2' }
      
      cache.set(key1, [])
      cache.set(key2, [])
      cache.set(key3, [])
      
      const count = cache.invalidateServer('s1')
      
      expect(count).toBe(2)
      expect(cache.get(key1)).toBeNull()
      expect(cache.get(key2)).toBeNull()
      expect(cache.get(key3)).toEqual([])
    })
  })

  describe('getStats', () => {
    it('should return cache statistics', () => {
      const key1 = { patientId: 'p1', clientId: 'c1', serverName: 's1' }
      const key2 = { patientId: 'p2', clientId: 'c2', serverName: 's1' }
      
      cache.set(key1, [{ resourceType: 'Consent', status: 'active', scope: {}, category: [] } as FhirConsent])
      cache.set(key2, [])
      
      const stats = cache.getStats()
      
      expect(stats.size).toBe(2)
      expect(stats.entries).toHaveLength(2)
      expect(stats.entries[0].consentCount).toBe(1)
      expect(stats.entries[1].consentCount).toBe(0)
    })
  })

  describe('cleanup', () => {
    it('should remove expired entries', () => {
      const key1 = { patientId: 'p1', clientId: 'c1', serverName: 's1' }
      const key2 = { patientId: 'p2', clientId: 'c2', serverName: 's1' }
      
      // Already expired when stored, rather than a short TTL raced against a
      // sleep: the claim under test is that cleanup() removes expired entries
      // and keeps live ones, not that a 10ms deadline beats a 50ms timer on a
      // loaded runner. It did not, intermittently, in CI.
      cache.set(key1, [], -1)
      cache.set(key2, [], 60000) // doesn't expire (60s)

      const cleaned = cache.cleanup()
      
      // First entry should be cleaned, second should remain
      expect(cleaned).toBeGreaterThanOrEqual(1)
      expect(cache.get(key1)).toBeNull()
      expect(cache.get(key2)).toEqual([])
    })
  })
})

describe('buildConsentContext', () => {
  it('should extract patient ID from token patient claim', async () => {
    const token: SmartTokenPayload = {
      azp: 'test-client',
      scope: 'patient/*.read',
      patient: 'patient-123'
    }
    
    const context = await buildConsentContext(token, 'test-server', 'Observation?patient=Patient/123', 'GET')
    
    expect(context.patientId).toBe('patient-123')
    expect(context.clientId).toBe('test-client')
    expect(context.resourceType).toBe('Observation')
    expect(context.method).toBe('GET')
  })

  it('should extract patient ID from Patient resource path', async () => {
    const token: SmartTokenPayload = {
      azp: 'test-client',
      scope: 'patient/Patient.read'
    }
    
    const context = await buildConsentContext(token, 'test-server', 'Patient/456', 'GET')
    
    expect(context.patientId).toBe('456')
    expect(context.resourceType).toBe('Patient')
    expect(context.resourceId).toBe('456')
  })

  it('should return null patientId if not determinable', async () => {
    const token: SmartTokenPayload = {
      azp: 'test-client',
      scope: 'system/*.read'
    }

    const context = await buildConsentContext(token, 'test-server', 'Observation', 'GET')

    expect(context.patientId).toBeNull()
  })

  /** The URL must never outrank the token. */
  it('prefers the patient the token is about over the one named in the path', async () => {
    const token: SmartTokenPayload = {
      azp: 'patient-portal',
      scope: 'patient/*.read',
      fhirUser: 'Patient/1005',
    }

    const context = await buildConsentContext(token, 'test-server', 'Patient/2000', 'GET')

    expect(context.patientId).toBe('1005')
  })

  it('resolves the patient from a Patient fhirUser when there is no claim', async () => {
    const token: SmartTokenPayload = {
      azp: 'patient-portal',
      scope: 'patient/*.read',
      fhirUser: 'https://fhir.example.com/Patient/1005',
    }

    const context = await buildConsentContext(token, 'test-server', 'Observation', 'GET')

    expect(context.patientId).toBe('1005')
  })

  it('does not treat a Practitioner fhirUser as a patient', async () => {
    const token: SmartTokenPayload = {
      azp: 'aihr-portal',
      scope: 'user/*.read',
      fhirUser: 'Practitioner/dr-smith',
    }

    const context = await buildConsentContext(token, 'test-server', 'Observation', 'GET')

    expect(context.patientId).toBeNull()
  })

  it('should parse scopes correctly', async () => {
    const token: SmartTokenPayload = {
      azp: 'test-client',
      scope: 'patient/*.read patient/Observation.write openid profile'
    }
    
    const context = await buildConsentContext(token, 'test-server', 'Observation', 'GET')
    
    expect(context.scopes).toEqual([
      'patient/*.read',
      'patient/Observation.write',
      'openid',
      'profile'
    ])
  })

  it('should handle fhirUser claim', async () => {
    const token: SmartTokenPayload = {
      azp: 'test-client',
      scope: 'patient/*.read',
      fhirUser: 'Practitioner/dr-123'
    }
    
    const context = await buildConsentContext(token, 'test-server', 'Patient/123', 'GET')
    
    expect(context.fhirUser).toBe('Practitioner/dr-123')
  })

  it('should use sub as fallback for clientId', async () => {
    const token: SmartTokenPayload = {
      sub: 'user-123',
      scope: 'patient/*.read'
    }
    
    const context = await buildConsentContext(token, 'test-server', 'Patient/123', 'GET')
    
    expect(context.clientId).toBe('user-123')
  })
})

describe('Consent Evaluation', () => {
  // These tests would require mocking the FHIR fetch calls
  // For now, we test the context building and caching logic
  
  describe('Resource type extraction', () => {
    it('should extract resource type from simple paths', async () => {
      const testCases = [
        { path: 'Patient/123', expected: 'Patient' },
        { path: 'Observation', expected: 'Observation' },
        { path: 'Observation?patient=Patient/123', expected: 'Observation' },
        { path: 'MedicationRequest/456/_history/1', expected: 'MedicationRequest' },
      ]
      
      for (const { path, expected } of testCases) {
        const token: SmartTokenPayload = { azp: 'client', scope: '' }
        const context = await buildConsentContext(token, 'server', path, 'GET')
        expect(context.resourceType).toBe(expected)
      }
    })

    it('should return null for non-resource paths', async () => {
      const token: SmartTokenPayload = { azp: 'client', scope: '' }
      
      const context1 = await buildConsentContext(token, 'server', '', 'GET')
      expect(context1.resourceType).toBeNull()
      
      const context2 = await buildConsentContext(token, 'server', '/', 'GET')
      expect(context2.resourceType).toBeNull()
    })
  })
})
