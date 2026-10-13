/**
 * Person Resolver Tests
 * 
 * Tests for Person→Patient IAL linking and identity verification.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  resolvePerson,
  checkIal,
  verifyPatientLinkOnly,
  getIalConfig,
  clearPersonCache,
  getPersonCacheStats,
  extractLinkedIdentities,
  resolveFhirUserForClient
} from '../src/lib/consent/person-resolver'
import type { SmartTokenPayload, FhirPerson } from '../src/lib/consent/types'

// =============================================================================
// TEST FIXTURES
// =============================================================================

const mockPerson: FhirPerson = {
  resourceType: 'Person',
  id: 'person-123',
  active: true,
  link: [
    {
      target: { reference: 'Patient/patient-456' },
      assurance: 'level3'
    },
    {
      target: { reference: 'Patient/patient-789' },
      assurance: 'level2'
    }
  ]
}

const mockPersonNoLinks: FhirPerson = {
  resourceType: 'Person',
  id: 'person-no-links',
  active: true
}

const createMockToken = (overrides: Partial<SmartTokenPayload> = {}): SmartTokenPayload => ({
  iss: 'https://auth.example.com',
  sub: 'user-123',
  aud: 'smart-app-client',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  azp: 'smart-app-client',
  scope: 'patient/*.read',
  fhirUser: 'Person/person-123',
  patient: 'patient-456',
  ...overrides
})

// Mock fetch for FHIR server calls
const originalFetch = global.fetch

/**
 * Helper to mock global.fetch with proper typing for bun
 * Bun's fetch type requires a 'preconnect' method, so we use type assertion
 */
function mockFetch(handler: () => Promise<Response>): void {
  global.fetch = mock(handler) as unknown as typeof global.fetch
}

describe('Person Resolver', () => {
  beforeEach(() => {
    clearPersonCache()
    // Reset env vars
    delete process.env.IAL_ENABLED
    delete process.env.IAL_MINIMUM_LEVEL
    delete process.env.IAL_SENSITIVE_RESOURCE_TYPES
    delete process.env.IAL_SENSITIVE_MINIMUM_LEVEL
    delete process.env.IAL_VERIFY_PATIENT_LINK
    delete process.env.IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE
  })

  afterEach(() => {
    global.fetch = originalFetch
    clearPersonCache()
  })

  describe('getIalConfig', () => {
    it('should return default config when no env vars set', () => {
      const config = getIalConfig()
      
      expect(config.enabled).toBe(false)
      expect(config.minimumLevel).toBe('level1')
      expect(config.sensitiveResourceTypes).toEqual([])
      expect(config.sensitiveMinimumLevel).toBe('level3')
      expect(config.verifyPatientLink).toBe(true)
      expect(config.allowOnPersonLookupFailure).toBe(false)
      expect(config.cacheTtl).toBe(300000)
    })

    it('should read config from env vars', () => {
      process.env.IAL_ENABLED = 'true'
      process.env.IAL_MINIMUM_LEVEL = 'level2'
      process.env.IAL_SENSITIVE_RESOURCE_TYPES = 'MedicationRequest,DiagnosticReport'
      process.env.IAL_SENSITIVE_MINIMUM_LEVEL = 'level4'
      process.env.IAL_VERIFY_PATIENT_LINK = 'false'
      process.env.IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE = 'true'
      
      const config = getIalConfig()
      
      expect(config.enabled).toBe(true)
      expect(config.minimumLevel).toBe('level2')
      expect(config.sensitiveResourceTypes).toEqual(['MedicationRequest', 'DiagnosticReport'])
      expect(config.sensitiveMinimumLevel).toBe('level4')
      expect(config.verifyPatientLink).toBe(false)
      expect(config.allowOnPersonLookupFailure).toBe(true)
    })
  })

  describe('resolvePerson', () => {
    it('should return error when no Person in fhirUser', async () => {
      const token = createMockToken({ fhirUser: undefined })
      
      const result = await resolvePerson(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.success).toBe(false)
      expect(result.error).toContain('No Person reference')
      expect(result.linkedPatients).toEqual([])
    })

    it('should return error when fhirUser is not a Person', async () => {
      const token = createMockToken({ fhirUser: 'Practitioner/doc-123' })
      
      const result = await resolvePerson(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.success).toBe(false)
      expect(result.error).toContain('No Person reference')
    })

    it('should fetch Person from FHIR server and extract links', async () => {
      mockFetch(async () => new Response(JSON.stringify(mockPerson), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const token = createMockToken()
      
      const result = await resolvePerson(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.success).toBe(true)
      expect(result.person).toEqual(mockPerson)
      expect(result.linkedPatients).toHaveLength(2)
      expect(result.linkedPatients[0].patientId).toBe('patient-456')
      expect(result.linkedPatients[0].assuranceLevel).toBe('level3')
      expect(result.linkedPatients[1].patientId).toBe('patient-789')
      expect(result.linkedPatients[1].assuranceLevel).toBe('level2')
      expect(result.patientLinkVerified).toBe(true)
      expect(result.validatedPatient?.patientId).toBe('patient-456')
    })

    it('should cache Person after fetch', async () => {
      let fetchCount = 0
      mockFetch(async () => {
        fetchCount++
        return new Response(JSON.stringify(mockPerson), {
          status: 200,
          headers: { 'Content-Type': 'application/fhir+json' }
        })
      })

      const token = createMockToken()
      
      // First call - should fetch
      const result1 = await resolvePerson(token, 'server-1', 'https://fhir.example.com', 'Bearer token')
      expect(result1.cached).toBe(false)
      expect(fetchCount).toBe(1)
      
      // Second call - should use cache
      const result2 = await resolvePerson(token, 'server-1', 'https://fhir.example.com', 'Bearer token')
      expect(result2.cached).toBe(true)
      expect(fetchCount).toBe(1) // No additional fetch
      expect(result2.person).toEqual(mockPerson)
    })

    it('should handle 404 Person not found', async () => {
      mockFetch(async () => new Response(null, { status: 404 }))

      const token = createMockToken()
      
      const result = await resolvePerson(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.success).toBe(false)
      expect(result.error).toBe('Person not found')
    })

    it('should handle fetch errors gracefully', async () => {
      mockFetch(async () => { throw new Error('Network error') })

      const token = createMockToken()
      
      const result = await resolvePerson(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.success).toBe(false)
      expect(result.error).toBe('Person not found')
    })

    it('should handle Person with no links', async () => {
      mockFetch(async () => new Response(JSON.stringify(mockPersonNoLinks), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const token = createMockToken()
      
      const result = await resolvePerson(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.success).toBe(true)
      expect(result.linkedPatients).toEqual([])
      expect(result.patientLinkVerified).toBe(false)
    })

    it('should extract Person ID from full URL', async () => {
      mockFetch(async () => new Response(JSON.stringify(mockPerson), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const token = createMockToken({ fhirUser: 'https://fhir.example.com/Person/person-123' })
      
      const result = await resolvePerson(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.success).toBe(true)
      expect(result.person?.id).toBe('person-123')
    })
  })

  describe('checkIal', () => {
    beforeEach(() => {
      mockFetch(async () => new Response(JSON.stringify(mockPerson), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))
    })

    it('should allow when IAL checking is disabled', async () => {
      // IAL_ENABLED defaults to false
      const token = createMockToken()
      
      const result = await checkIal(
        token,
        'server-1',
        'https://fhir.example.com',
        'Observation',
        'Bearer token'
      )
      
      expect(result.allowed).toBe(true)
      expect(result.reason).toContain('disabled')
    })

    it('should enforce minimum IAL when enabled', async () => {
      process.env.IAL_ENABLED = 'true'
      process.env.IAL_MINIMUM_LEVEL = 'level3'
      
      const token = createMockToken({ patient: 'patient-789' }) // level2 link
      
      const result = await checkIal(
        token,
        'server-1',
        'https://fhir.example.com',
        'Observation',
        'Bearer token'
      )
      
      expect(result.allowed).toBe(false)
      expect(result.actualLevel).toBe('level2')
      expect(result.requiredLevel).toBe('level3')
    })

    it('should allow when IAL meets requirement', async () => {
      process.env.IAL_ENABLED = 'true'
      process.env.IAL_MINIMUM_LEVEL = 'level2'
      
      const token = createMockToken({ patient: 'patient-456' }) // level3 link
      
      const result = await checkIal(
        token,
        'server-1',
        'https://fhir.example.com',
        'Observation',
        'Bearer token'
      )
      
      expect(result.allowed).toBe(true)
      expect(result.actualLevel).toBe('level3')
    })

    it('should enforce higher IAL for sensitive resources', async () => {
      process.env.IAL_ENABLED = 'true'
      process.env.IAL_MINIMUM_LEVEL = 'level1'
      process.env.IAL_SENSITIVE_RESOURCE_TYPES = 'MedicationRequest,DiagnosticReport'
      process.env.IAL_SENSITIVE_MINIMUM_LEVEL = 'level4'
      
      const token = createMockToken({ patient: 'patient-456' }) // level3 link
      
      const result = await checkIal(
        token,
        'server-1',
        'https://fhir.example.com',
        'MedicationRequest',
        'Bearer token'
      )
      
      expect(result.allowed).toBe(false)
      expect(result.isSensitiveResource).toBe(true)
      expect(result.requiredLevel).toBe('level4')
      expect(result.actualLevel).toBe('level3')
    })

    it('should deny when patient link not verified', async () => {
      process.env.IAL_ENABLED = 'true'
      process.env.IAL_VERIFY_PATIENT_LINK = 'true'
      
      const token = createMockToken({ patient: 'patient-unknown' })
      
      const result = await checkIal(
        token,
        'server-1',
        'https://fhir.example.com',
        'Observation',
        'Bearer token'
      )
      
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('not linked')
    })

    it('should allow on Person lookup failure when configured', async () => {
      process.env.IAL_ENABLED = 'true'
      process.env.IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE = 'true'
      
      mockFetch(async () => new Response(null, { status: 404 }))
      
      const token = createMockToken()
      
      const result = await checkIal(
        token,
        'server-1',
        'https://fhir.example.com',
        'Observation',
        'Bearer token'
      )
      
      expect(result.allowed).toBe(true)
      expect(result.reason).toContain('allowing due to config')
    })
  })

  describe('verifyPatientLinkOnly', () => {
    it('should return verified true when no patient context', async () => {
      const token = createMockToken({ patient: undefined })
      
      const result = await verifyPatientLinkOnly(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.verified).toBe(true)
      expect(result.reason).toContain('No patient context')
    })

    it('should return verified true when fhirUser is not a Person', async () => {
      const token = createMockToken({ fhirUser: 'Practitioner/doc-123' })
      
      const result = await verifyPatientLinkOnly(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.verified).toBe(true)
      expect(result.reason).toContain('not a Person reference')
    })

    it('should verify patient link when present', async () => {
      mockFetch(async () => new Response(JSON.stringify(mockPerson), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const token = createMockToken({ patient: 'patient-456' })
      
      const result = await verifyPatientLinkOnly(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.verified).toBe(true)
      expect(result.reason).toContain('verified via Person link')
      expect(result.reason).toContain('IAL: level3')
    })

    it('should fail verification when patient not linked', async () => {
      mockFetch(async () => new Response(JSON.stringify(mockPerson), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const token = createMockToken({ patient: 'unknown-patient' })
      
      const result = await verifyPatientLinkOnly(
        token,
        'server-1',
        'https://fhir.example.com',
        'Bearer token'
      )
      
      expect(result.verified).toBe(false)
      expect(result.reason).toContain('not linked to Person')
    })
  })

  describe('Person Cache', () => {
    it('should track cache statistics', async () => {
      const initialStats = getPersonCacheStats()
      expect(initialStats.entries).toBe(0)
      expect(initialStats.oldestEntry).toBeNull()

      mockFetch(async () => new Response(JSON.stringify(mockPerson), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const token = createMockToken()
      await resolvePerson(token, 'server-1', 'https://fhir.example.com', 'Bearer token')
      
      const statsAfter = getPersonCacheStats()
      expect(statsAfter.entries).toBe(1)
      expect(statsAfter.oldestEntry).not.toBeNull()
    })

    it('should clear cache', async () => {
      mockFetch(async () => new Response(JSON.stringify(mockPerson), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const token = createMockToken()
      await resolvePerson(token, 'server-1', 'https://fhir.example.com', 'Bearer token')
      
      expect(getPersonCacheStats().entries).toBe(1)
      
      clearPersonCache()
      
      expect(getPersonCacheStats().entries).toBe(0)
    })
  })

  // ===========================================================================
  // Per-Client fhirUser Resolution (patientFacing)
  // ===========================================================================

  describe('extractLinkedIdentities', () => {
    it('should extract Patient and Practitioner links', () => {
      const person: FhirPerson = {
        resourceType: 'Person',
        id: 'person-multi',
        active: true,
        link: [
          { target: { reference: 'Patient/pat-1' }, assurance: 'level3' },
          { target: { reference: 'Practitioner/pract-1' }, assurance: 'level2' },
          { target: { reference: 'RelatedPerson/rel-1' }, assurance: 'level1' },
        ]
      }

      const identities = extractLinkedIdentities(person)

      expect(identities).toHaveLength(3)
      expect(identities[0]).toEqual({
        resourceType: 'Patient',
        resourceId: 'pat-1',
        reference: 'Patient/pat-1',
        assuranceLevel: 'level3',
      })
      expect(identities[1]).toEqual({
        resourceType: 'Practitioner',
        resourceId: 'pract-1',
        reference: 'Practitioner/pract-1',
        assuranceLevel: 'level2',
      })
      expect(identities[2]).toEqual({
        resourceType: 'RelatedPerson',
        resourceId: 'rel-1',
        reference: 'RelatedPerson/rel-1',
        assuranceLevel: 'level1',
      })
    })

    it('should return empty array for person without links', () => {
      expect(extractLinkedIdentities(mockPersonNoLinks)).toEqual([])
    })

    it('should skip non-standard resource types in links', () => {
      const person: FhirPerson = {
        resourceType: 'Person',
        id: 'person-odd',
        active: true,
        link: [
          { target: { reference: 'Organization/org-1' } },
          { target: { reference: 'Patient/pat-1' }, assurance: 'level2' },
        ]
      }

      const identities = extractLinkedIdentities(person)
      expect(identities).toHaveLength(1)
      expect(identities[0].resourceType).toBe('Patient')
    })
  })

  describe('resolveFhirUserForClient', () => {
    const personWithBothLinks: FhirPerson = {
      resourceType: 'Person',
      id: 'person-dual',
      active: true,
      link: [
        { target: { reference: 'Patient/pat-dual' }, assurance: 'level3' },
        { target: { reference: 'Practitioner/pract-dual' }, assurance: 'level2' },
      ]
    }

    it('should return raw fhirUser when patientFacing is undefined (backward compat)', async () => {
      const result = await resolveFhirUserForClient(
        'Practitioner/abc',
        undefined,
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBe('Practitioner/abc')
    })

    it('should return raw fhirUser when it already matches expected type (patientFacing=true, Patient/*)', async () => {
      const result = await resolveFhirUserForClient(
        'Patient/xyz',
        true,
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBe('Patient/xyz')
    })

    it('keeps a PractitionerRole fhirUser for a clinician-facing client (SMART 2.1)', async () => {
      for (const fhirUser of ['PractitionerRole/role-1', 'https://fhir.example.com/PractitionerRole/role-1']) {
        expect(await resolveFhirUserForClient(fhirUser, false, 'https://fhir.example.com', 'server-1', 'Bearer token')).toBe(fhirUser)
      }
    })

    it('does not hand a PractitionerRole fhirUser to a patient-facing client', async () => {
      expect(await resolveFhirUserForClient('PractitionerRole/role-1', true, 'https://fhir.example.com', 'server-1', 'Bearer token')).toBeUndefined()
    })

    it('should return raw fhirUser when it already matches expected type (patientFacing=false, Practitioner/*)', async () => {
      const result = await resolveFhirUserForClient(
        'Practitioner/abc',
        false,
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBe('Practitioner/abc')
    })

    it('should return undefined when fhirUser is wrong type and not Person (omit claim)', async () => {
      const result = await resolveFhirUserForClient(
        'Practitioner/abc',
        true, // wants Patient
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBeUndefined()
    })

    it('should resolve Person → Patient when patientFacing=true', async () => {
      mockFetch(async () => new Response(JSON.stringify(personWithBothLinks), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const result = await resolveFhirUserForClient(
        'Person/person-dual',
        true,
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBe('Patient/pat-dual')
    })

    it('should resolve Person → Practitioner when patientFacing=false', async () => {
      mockFetch(async () => new Response(JSON.stringify(personWithBothLinks), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const result = await resolveFhirUserForClient(
        'Person/person-dual',
        false,
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBe('Practitioner/pract-dual')
    })

    it('should return undefined when Person has no matching link type', async () => {
      const personOnlyPatient: FhirPerson = {
        resourceType: 'Person',
        id: 'person-patient-only',
        active: true,
        link: [
          { target: { reference: 'Patient/pat-only' }, assurance: 'level3' }
        ]
      }

      mockFetch(async () => new Response(JSON.stringify(personOnlyPatient), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const result = await resolveFhirUserForClient(
        'Person/person-patient-only',
        false, // wants Practitioner but none exists
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBeUndefined()
    })

    it('should return undefined when Person not found (404)', async () => {
      mockFetch(async () => new Response('', { status: 404 }))

      const result = await resolveFhirUserForClient(
        'Person/nonexistent',
        true,
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBeUndefined()
    })

    // ─── Edge cases & bug regression ───────────────────────────────────

    it('BUG: should NOT treat RelatedPerson/* as Person/* (substring false match)', async () => {
      // "RelatedPerson/rel-1".includes("Person/") === true — must not trigger Person resolution
      // No fetch mock — if it tries to fetch, it proves the bug
      const fetchSpy = mock(() => Promise.resolve(new Response('SHOULD NOT BE CALLED', { status: 500 })))
      global.fetch = fetchSpy as unknown as typeof global.fetch

      const result = await resolveFhirUserForClient(
        'RelatedPerson/rel-1',
        true, // wants Patient
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      // Should omit claim (not try to fetch "rel-1" as a Person resource)
      expect(result).toBeUndefined()
      // Must NOT have made any network call
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('BUG: should NOT treat RelatedPerson/* as Person/* when patientFacing=false', async () => {
      const fetchSpy = mock(() => Promise.resolve(new Response('SHOULD NOT BE CALLED', { status: 500 })))
      global.fetch = fetchSpy as unknown as typeof global.fetch

      const result = await resolveFhirUserForClient(
        'RelatedPerson/rel-1',
        false, // wants Practitioner
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBeUndefined()
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('should handle full URL fhirUser that matches expected type', async () => {
      const result = await resolveFhirUserForClient(
        'https://fhir.example.com/Patient/pat-url',
        true,
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBe('https://fhir.example.com/Patient/pat-url')
    })

    it('should handle full URL fhirUser for Person resolution', async () => {
      mockFetch(async () => new Response(JSON.stringify(personWithBothLinks), {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' }
      }))

      const result = await resolveFhirUserForClient(
        'https://fhir.example.com/Person/person-dual',
        true,
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBe('Patient/pat-dual')
    })

    it('should omit claim when full URL fhirUser is wrong type and not Person', async () => {
      const result = await resolveFhirUserForClient(
        'https://fhir.example.com/Practitioner/pract-1',
        true, // wants Patient
        'https://fhir.example.com',
        'server-1',
        'Bearer token'
      )
      expect(result).toBeUndefined()
    })

    it('should handle empty serverUrl gracefully (no servers configured)', async () => {
      mockFetch(async () => new Response('', { status: 500 }))

      const result = await resolveFhirUserForClient(
        'Person/person-123',
        true,
        '', // empty server URL
        '',
        'Bearer token'
      )
      // fetchPerson will fail with invalid URL → returns undefined
      expect(result).toBeUndefined()
    })
  })
})
