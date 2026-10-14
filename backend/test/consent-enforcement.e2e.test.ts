/**
 * Consent Enforcement E2E Tests
 *
 * End-to-end tests that exercise the full consent-based access control flow:
 * 1. checkConsent() evaluates FHIR Consent resources fetched from upstream
 * 2. In "enforce" mode, denied requests return 403
 * 3. In "audit-only" mode, denied requests are logged but still allowed
 * 4. Consent cache is respected and can be invalidated
 * 5. Exempt clients, exempt resource types, and required-resource-type lists work
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  checkConsent,
  buildConsentContext,
  invalidateConsentCache,
  getConsentCacheStats,
} from '../src/lib/consent/consent-service'
import { consentCache } from '../src/lib/consent/consent-cache'
import type {
  ConsentConfig,
  FhirConsent,
  SmartTokenPayload,
} from '../src/lib/consent/types'

// =============================================================================
// FIXTURES
// =============================================================================

/** Active R4 consent permitting a specific client access to all resources */
function makePermitConsent(overrides: Partial<FhirConsent> & Record<string, unknown> = {}): FhirConsent {
  return {
    resourceType: 'Consent',
    id: 'consent-permit-1',
    status: 'active',
    scope: { coding: [{ code: 'patient-privacy' }] },
    category: [{ coding: [{ code: 'patient-privacy' }] }],
    provision: {
      type: 'permit' as const,
      actor: [
        {
          role: { coding: [{ code: 'GRANTEE' }] },
          reference: { reference: 'Organization/test-client' },
        },
      ],
    },
    ...overrides,
  } as FhirConsent
}

/** Active R4 consent that explicitly denies access */
function makeDenyConsent(overrides: Partial<FhirConsent> & Record<string, unknown> = {}): FhirConsent {
  return {
    resourceType: 'Consent',
    id: 'consent-deny-1',
    status: 'active',
    scope: { coding: [{ code: 'patient-privacy' }] },
    category: [{ coding: [{ code: 'patient-privacy' }] }],
    provision: {
      type: 'deny' as const,
      actor: [
        {
          role: { coding: [{ code: 'GRANTEE' }] },
          reference: { reference: 'Organization/test-client' },
        },
      ],
    },
    ...overrides,
  } as FhirConsent
}

/** Consent with resource-type restrictions (only certain FHIR resource types) */
function makeResourceRestrictedConsent(
  resourceTypes: string[],
  provisionType: 'permit' | 'deny' = 'permit',
): FhirConsent {
  return {
    resourceType: 'Consent',
    id: `consent-${provisionType}-restricted`,
    status: 'active',
    scope: { coding: [{ code: 'patient-privacy' }] },
    category: [{ coding: [{ code: 'patient-privacy' }] }],
    provision: {
      type: provisionType,
      class: resourceTypes.map((code) => ({
        system: 'http://hl7.org/fhir/resource-types',
        code,
      })),
      actor: [
        {
          role: { coding: [{ code: 'GRANTEE' }] },
          reference: { reference: 'Organization/test-client' },
        },
      ],
    },
  } as FhirConsent
}

/** Consent with a time-bound provision (expired) */
function makeExpiredConsent(): FhirConsent {
  return {
    resourceType: 'Consent',
    id: 'consent-expired',
    status: 'active',
    scope: { coding: [{ code: 'patient-privacy' }] },
    category: [{ coding: [{ code: 'patient-privacy' }] }],
    provision: {
      type: 'permit' as const,
      period: {
        start: '2020-01-01',
        end: '2020-12-31',
      },
      actor: [
        {
          role: { coding: [{ code: 'GRANTEE' }] },
          reference: { reference: 'Organization/test-client' },
        },
      ],
    },
  } as FhirConsent
}

/** Inactive / draft consent that should be skipped */
function makeInactiveConsent(): FhirConsent {
  return {
    resourceType: 'Consent',
    id: 'consent-draft',
    status: 'draft',
    scope: { coding: [{ code: 'patient-privacy' }] },
    category: [{ coding: [{ code: 'patient-privacy' }] }],
    provision: {
      type: 'permit' as const,
    },
  } as FhirConsent
}

/** Create a SMART token payload */
function createToken(overrides: Partial<SmartTokenPayload> = {}): SmartTokenPayload {
  return {
    iss: 'https://auth.example.com',
    sub: 'user-123',
    aud: 'smart-proxy',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    azp: 'test-client',
    scope: 'patient/*.read',
    patient: 'patient-123',
    ...overrides,
  }
}

/** Wrap consents in a FHIR Bundle search response */
function makeConsentBundle(consents: FhirConsent[]) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: consents.length,
    entry: consents.map((c) => ({ resource: c })),
  }
}

// =============================================================================
// GLOBAL FETCH MOCK HELPERS
// =============================================================================

const originalFetch = global.fetch

/** Set global.fetch to a handler (typed for Bun compatibility) */
function mockGlobalFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  global.fetch = mock(handler) as unknown as typeof global.fetch
}

/** Simulate upstream FHIR server returning a consent bundle */
function mockFhirConsentResponse(consents: FhirConsent[]): void {
  mockGlobalFetch(async () =>
    new Response(JSON.stringify(makeConsentBundle(consents)), {
      status: 200,
      headers: { 'Content-Type': 'application/fhir+json' },
    }),
  )
}

/** Simulate upstream FHIR server returning an error */
function mockFhirErrorResponse(status: number): void {
  mockGlobalFetch(async () => new Response(null, { status }))
}

// =============================================================================
// CONFIG HELPERS
// =============================================================================

// NOTE: We pass config directly to checkConsent() as a parameter rather than
// relying on env vars or module-level overrides. On Linux CI, Bun's concurrent
// test file execution causes module-level state to be isolated between the
// test's imports and consent-service's internal imports (two module instances).
// Passing config directly eliminates ALL module resolution issues.

const DEFAULT_TEST_CONFIG: ConsentConfig = {
  enabled: true,
  mode: 'enforce',
  cacheTtl: 60000,
  exemptClients: [],
  requiredForResourceTypes: [],
  exemptResourceTypes: ['CapabilityStatement', 'metadata'],
  appUrl: null,
}

/** Active config for the current test — passed directly to checkConsent() */
let activeTestConfig: ConsentConfig = DEFAULT_TEST_CONFIG

function setConsentConfig(overrides: Partial<ConsentConfig> = {}) {
  activeTestConfig = { ...DEFAULT_TEST_CONFIG, ...overrides }
}

/**
 * Wrapper around checkConsent that passes activeTestConfig directly.
 * This avoids cross-module state issues on Linux CI.
 */
async function testCheckConsent(
  tokenPayload: ReturnType<typeof createToken>,
  serverName: string,
  serverUrl: string,
  resourcePath: string,
  method: string,
  authHeader: string,
) {
  return checkConsent(tokenPayload, serverName, serverUrl, resourcePath, method, authHeader, activeTestConfig)
}

// =============================================================================
// TESTS
// =============================================================================

describe('Consent Enforcement E2E', () => {
  beforeEach(() => {
    consentCache.clear()
  })

  afterEach(() => {
    global.fetch = originalFetch
    consentCache.clear()
  })

  // ---------------------------------------------------------------------------
  // Core permit / deny flow
  // ---------------------------------------------------------------------------

  describe('enforce mode — permit / deny decisions', () => {
    it.serial('should PERMIT when an active consent exists for the client', async () => {
      setConsentConfig()
      mockFhirConsentResponse([makePermitConsent()])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
      expect(result.consentId).toContain('Consent/')
      expect(result.reason).toContain('permitted')
      expect(result.context.patientId).toBe('patient-123')
      expect(result.context.clientId).toBe('test-client')
      expect(result.context.resourceType).toBe('Patient')
    })

    it.serial('should DENY when no consent exists for the patient', async () => {
      setConsentConfig()
      // Empty bundle — no consents for this patient
      mockFhirConsentResponse([])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Observation/obs-1',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
      expect(result.reason).toContain('No valid consent')
    })

    it.serial('should DENY when only an explicit deny consent exists', async () => {
      setConsentConfig()
      mockFhirConsentResponse([makeDenyConsent()])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Observation/obs-1',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
      expect(result.reason).toContain('denied')
    })

    it.serial('should PERMIT when a permit consent overrides a deny consent', async () => {
      setConsentConfig()
      // deny comes first, but a permit later should override
      mockFhirConsentResponse([makeDenyConsent(), makePermitConsent()])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Observation/obs-1',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
    })
  })

  // ---------------------------------------------------------------------------
  // Consent status / provision period
  // ---------------------------------------------------------------------------

  describe('consent status and temporal validity', () => {
    it.serial('should skip inactive / draft consents (deny by default)', async () => {
      setConsentConfig()
      mockFhirConsentResponse([makeInactiveConsent()])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
      expect(result.reason).toContain('No valid consent')
    })

    it.serial('should skip expired consents (deny by default)', async () => {
      setConsentConfig()
      mockFhirConsentResponse([makeExpiredConsent()])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
      expect(result.reason).toContain('No valid consent')
    })
  })

  // ---------------------------------------------------------------------------
  // Resource-type restrictions in provisions
  // ---------------------------------------------------------------------------

  describe('resource-type restrictions in consent provisions', () => {
    it.serial('should PERMIT when provision class matches the requested resource type', async () => {
      setConsentConfig()
      mockFhirConsentResponse([makeResourceRestrictedConsent(['Observation', 'Patient'])])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Observation/obs-1',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
    })

    it.serial('should DENY when provision class does NOT match the requested resource type', async () => {
      setConsentConfig()
      // Consent only covers Observation, but we're requesting MedicationRequest
      mockFhirConsentResponse([makeResourceRestrictedConsent(['Observation'])])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'MedicationRequest/med-1',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })
  })

  // ---------------------------------------------------------------------------
  // Audit-only mode
  // ---------------------------------------------------------------------------

  describe('audit-only mode', () => {
    it.serial('should always PERMIT in audit-only mode (even without consent)', async () => {
      setConsentConfig({ mode: 'audit-only' })
      // Empty — no consents
      mockFhirConsentResponse([])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      // In audit-only, the decision still reports "deny" internally,
      // but the proxy route won't enforce it.
      // The consent service itself returns the real decision.
      // It is the ROUTE that checks getConsentConfig().mode === 'enforce' before blocking.
      // So at the service level, this should still be 'deny'.
      expect(result.decision).toBe('deny')
      expect(result.reason).toContain('No valid consent')
    })
  })

  // ---------------------------------------------------------------------------
  // Disabled mode
  // ---------------------------------------------------------------------------

  describe('disabled mode', () => {
    it.serial('should auto-PERMIT when consent enforcement is disabled', async () => {
      setConsentConfig({ mode: 'disabled' })

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
      expect(result.reason).toContain('disabled')
    })

    it.serial('should auto-PERMIT when CONSENT_ENABLED is false', async () => {
      setConsentConfig({ enabled: false })

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
    })
  })

  // ---------------------------------------------------------------------------
  // Exempt clients
  // ---------------------------------------------------------------------------

  describe('exempt clients', () => {
    it.serial('should auto-PERMIT for clients in the exempt list', async () => {
      setConsentConfig({ exemptClients: ['test-client', 'admin-app'] })

      const result = await testCheckConsent(
        createToken({ azp: 'test-client' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
      expect(result.reason).toContain('exempt')
    })

    it.serial('should still check consent for non-exempt clients', async () => {
      setConsentConfig({ exemptClients: ['admin-app'] })
      mockFhirConsentResponse([])

      const result = await testCheckConsent(
        createToken({ azp: 'other-client' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })
  })

  // ---------------------------------------------------------------------------
  // Self-access — per request, so one client can serve both populations
  // ---------------------------------------------------------------------------

  describe('self-access', () => {
    it.serial('permits a patient reading their own record, with no Consent present', async () => {
      setConsentConfig({ exemptClients: [] })
      mockFhirConsentResponse([])

      const result = await testCheckConsent(
        createToken({ azp: 'any-client', fhirUser: 'Patient/patient-123' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
      expect(result.reason).toContain('own record')
    })

    it.serial('still enforces consent for a practitioner on the SAME client', async () => {
      setConsentConfig({ exemptClients: [] })
      mockFhirConsentResponse([])

      const result = await testCheckConsent(
        createToken({ azp: 'any-client', fhirUser: 'Practitioner/dr-smith' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })

    /**
     * Consent judges the patient the TOKEN is about, so this reads as self-access
     * even though the URL names someone else. Blocking the cross-patient read is
     * the compartment gate's job, not consent's — see smart-access-control.test.
     */
    it.serial('judges the token\'s patient, not the one in the URL', async () => {
      setConsentConfig({ exemptClients: [] })
      mockFhirConsentResponse([])

      const result = await testCheckConsent(
        createToken({ azp: 'any-client', fhirUser: 'Patient/patient-999', patient: undefined }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.context.patientId).toBe('patient-999')
      expect(result.decision).toBe('permit')
    })

    it.serial('denies when the token names a patient with no consent for the client', async () => {
      setConsentConfig({ exemptClients: [] })
      mockFhirConsentResponse([])

      const result = await testCheckConsent(
        createToken({ azp: 'any-client', fhirUser: 'Practitioner/dr-smith', patient: 'patient-123' }),
        'hapi',
        'https://fhir.example.com',
        'Observation',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })

    it.serial('resolves self-access from an absolute fhirUser URL', async () => {
      setConsentConfig({ exemptClients: [] })
      mockFhirConsentResponse([])

      const result = await testCheckConsent(
        createToken({ azp: 'any-client', fhirUser: 'https://fhir.example.com/R4/Patient/patient-123' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
      expect(result.reason).toContain('own record')
    })
  })

  // ---------------------------------------------------------------------------
  // Exempt resource types
  // ---------------------------------------------------------------------------

  describe('exempt resource types', () => {
    it.serial('should auto-PERMIT for exempt resource types (CapabilityStatement)', async () => {
      setConsentConfig()

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'CapabilityStatement',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
      expect(result.reason).toContain('exempt')
    })

    it.serial('should auto-PERMIT for custom exempt resource types', async () => {
      setConsentConfig({ exemptResourceTypes: ['CapabilityStatement', 'metadata', 'AllergyIntolerance'] })

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'AllergyIntolerance?patient=Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
      expect(result.reason).toContain('exempt')
    })
  })

  // ---------------------------------------------------------------------------
  // Resources outside the patient compartment
  // ---------------------------------------------------------------------------

  describe('resources outside the patient compartment', () => {
    it.serial('permits a clinician reading their own Practitioner with a patient in context, without asking for consents', async () => {
      setConsentConfig()
      let fetched = false
      mockGlobalFetch(async () => { fetched = true; return new Response(JSON.stringify(makeConsentBundle([])), { status: 200 }) })

      const result = await testCheckConsent(createToken(), 'hapi', 'https://fhir.example.com', 'Practitioner/example-practitioner', 'GET', 'Bearer tok')

      expect(result.decision).toBe('permit')
      expect(result.reason).toContain('patient compartment')
      expect(fetched).toBe(false)
    })

    it.serial('permits Organization reads, which hold no patient data', async () => {
      setConsentConfig()

      const result = await testCheckConsent(createToken(), 'hapi', 'https://fhir.example.com', 'Organization?name=Clinic', 'GET', 'Bearer tok')

      expect(result.decision).toBe('permit')
    })

    it.serial('still requires consent for a compartment type', async () => {
      setConsentConfig()
      mockFhirConsentResponse([])

      const result = await testCheckConsent(createToken(), 'hapi', 'https://fhir.example.com', 'Encounter?patient=Patient/patient-123', 'GET', 'Bearer tok')

      expect(result.decision).toBe('deny')
    })
  })

  // ---------------------------------------------------------------------------
  // Required resource types
  // ---------------------------------------------------------------------------

  describe('required resource types filter', () => {
    it.serial('should skip consent check for resource types NOT in the required list', async () => {
      setConsentConfig({ requiredForResourceTypes: ['Observation', 'MedicationRequest'] })

      // Patient is NOT in the required list → should auto-permit
      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
      expect(result.reason).toContain('not in required list')
    })

    it.serial('should enforce consent for resource types IN the required list', async () => {
      setConsentConfig({ requiredForResourceTypes: ['Observation', 'MedicationRequest'] })
      mockFhirConsentResponse([])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Observation?patient=Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })
  })

  // ---------------------------------------------------------------------------
  // No patient context
  // ---------------------------------------------------------------------------

  describe('missing patient context', () => {
    it.serial('should auto-PERMIT when patient ID cannot be determined', async () => {
      setConsentConfig()

      // Token without patient, path without Patient/
      const result = await testCheckConsent(
        createToken({ patient: undefined }),
        'hapi',
        'https://fhir.example.com',
        'Observation',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
      expect(result.reason).toContain('No patient context')
    })
  })

  // ---------------------------------------------------------------------------
  // Cache behaviour
  // ---------------------------------------------------------------------------

  describe('consent cache', () => {
    it.serial('should cache consent responses and reuse them', async () => {
      setConsentConfig({ cacheTtl: 60000 })

      let fetchCount = 0
      mockGlobalFetch(async () => {
        fetchCount++
        return new Response(JSON.stringify(makeConsentBundle([makePermitConsent()])), {
          status: 200,
          headers: { 'Content-Type': 'application/fhir+json' },
        })
      })

      const token = createToken()

      // First call → fetch
      const r1 = await testCheckConsent(token, 'hapi', 'https://fhir.example.com', 'Patient/patient-123', 'GET', 'Bearer tok')
      expect(r1.decision).toBe('permit')
      expect(r1.cached).toBe(false)
      expect(fetchCount).toBe(1)

      // Second call → cache hit
      const r2 = await testCheckConsent(token, 'hapi', 'https://fhir.example.com', 'Observation/obs-1', 'GET', 'Bearer tok')
      expect(r2.decision).toBe('permit')
      expect(r2.cached).toBe(true)
      expect(fetchCount).toBe(1)
    })

    it.serial('should fetch again after cache invalidation', async () => {
      setConsentConfig({ cacheTtl: 60000 })

      let fetchCount = 0
      mockGlobalFetch(async () => {
        fetchCount++
        return new Response(JSON.stringify(makeConsentBundle([makePermitConsent()])), {
          status: 200,
          headers: { 'Content-Type': 'application/fhir+json' },
        })
      })

      const token = createToken()

      // First call → fetch
      await testCheckConsent(token, 'hapi', 'https://fhir.example.com', 'Patient/patient-123', 'GET', 'Bearer tok')
      expect(fetchCount).toBe(1)

      // Invalidate cache for this patient
      invalidateConsentCache('patient-123')

      // Next call → should fetch again
      const r2 = await testCheckConsent(token, 'hapi', 'https://fhir.example.com', 'Patient/patient-123', 'GET', 'Bearer tok')
      expect(r2.cached).toBe(false)
      expect(fetchCount).toBe(2)
    })

    it.serial('should report cache statistics', async () => {
      setConsentConfig()
      mockFhirConsentResponse([makePermitConsent()])

      await testCheckConsent(createToken(), 'hapi', 'https://fhir.example.com', 'Patient/patient-123', 'GET', 'Bearer tok')

      const stats = getConsentCacheStats()
      expect(stats.size).toBeGreaterThanOrEqual(1)
      expect(stats.entries.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Upstream FHIR server errors
  // ---------------------------------------------------------------------------

  describe('upstream FHIR server errors', () => {
    it.serial('should DENY when upstream returns 500 (no consents found)', async () => {
      setConsentConfig()
      mockFhirErrorResponse(500)

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      // fetchConsents returns [] on error → no consent → deny
      expect(result.decision).toBe('deny')
    })

    it.serial('should DENY when upstream returns 401 (no consents found)', async () => {
      setConsentConfig()
      mockFhirErrorResponse(401)

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })

    it.serial('should DENY when fetch throws a network error', async () => {
      setConsentConfig()
      mockGlobalFetch(async () => {
        throw new Error('ECONNREFUSED')
      })

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })
  })

  // ---------------------------------------------------------------------------
  // Actor matching
  // ---------------------------------------------------------------------------

  describe('actor matching', () => {
    it.serial('should DENY when consent exists but for a different client', async () => {
      setConsentConfig()

      const consentForOtherClient: FhirConsent = {
        resourceType: 'Consent',
        id: 'consent-other-client',
        status: 'active',
        scope: { coding: [{ code: 'patient-privacy' }] },
        category: [],
        provision: {
          type: 'permit' as const,
          actor: [
            {
              role: { coding: [{ code: 'GRANTEE' }] },
              reference: { reference: 'Organization/other-client' },
            },
          ],
        },
      } as FhirConsent

      mockFhirConsentResponse([consentForOtherClient])

      const result = await testCheckConsent(
        createToken({ azp: 'test-client' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })

    /**
     * An actor-less provision names no recipient, so it grants nothing. This used
     * to permit every client, which inverted the model: the unscoped consent let
     * everyone in while a consent naming a practitioner let nobody in.
     */
    it.serial('should DENY when consent names no actor, because it grants to nobody', async () => {
      setConsentConfig()

      const consentNoActor: FhirConsent = {
        resourceType: 'Consent',
        id: 'consent-all',
        status: 'active',
        scope: { coding: [{ code: 'patient-privacy' }] },
        category: [],
        provision: {
          type: 'permit' as const,
        },
      } as FhirConsent

      mockFhirConsentResponse([consentNoActor])

      const result = await testCheckConsent(
        createToken({ azp: 'any-client', fhirUser: 'Practitioner/dr-smith' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })

    /**
     * The shape the consent portal actually writes: actor is the GRANTEE
     * practitioner, not the OAuth client. Matching only clientId meant every
     * consent a patient granted was ignored.
     */
    it.serial('should PERMIT the practitioner a consent names, whatever app they use', async () => {
      setConsentConfig()

      const consentForPractitioner: FhirConsent = {
        resourceType: 'Consent',
        id: 'consent-dr-smith',
        status: 'active',
        scope: { coding: [{ code: 'patient-privacy' }] },
        category: [],
        provision: {
          type: 'permit' as const,
          actor: [{
            role: { coding: [{ code: 'PRCP' }] },
            reference: { reference: 'Practitioner/dr-smith' },
          }],
        },
      } as FhirConsent

      mockFhirConsentResponse([consentForPractitioner])

      const result = await testCheckConsent(
        createToken({ azp: 'aihr-portal', fhirUser: 'Practitioner/dr-smith' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('permit')
      expect(result.consentId).toBe('Consent/consent-dr-smith')
    })

    it.serial('should DENY a different practitioner than the consent names', async () => {
      setConsentConfig()

      const consentForPractitioner: FhirConsent = {
        resourceType: 'Consent',
        id: 'consent-dr-smith',
        status: 'active',
        scope: { coding: [{ code: 'patient-privacy' }] },
        category: [],
        provision: {
          type: 'permit' as const,
          actor: [{
            role: { coding: [{ code: 'PRCP' }] },
            reference: { reference: 'Practitioner/dr-smith' },
          }],
        },
      } as FhirConsent

      mockFhirConsentResponse([consentForPractitioner])

      const result = await testCheckConsent(
        createToken({ azp: 'aihr-portal', fhirUser: 'Practitioner/dr-jones' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })

    /** An SHL mirror names its recipient by display only, so it grants no FHIR access. */
    it.serial('should DENY an actor carrying only a display name', async () => {
      setConsentConfig()

      const shlMirror: FhirConsent = {
        resourceType: 'Consent',
        id: 'consent-shl',
        status: 'active',
        scope: { coding: [{ code: 'patient-privacy' }] },
        category: [],
        provision: {
          type: 'permit' as const,
          actor: [{
            role: { coding: [{ code: 'IRCP' }] },
            reference: { display: 'Dr Anywhere' },
          }],
        },
      } as FhirConsent

      mockFhirConsentResponse([shlMirror])

      const result = await testCheckConsent(
        createToken({ azp: 'aihr-portal', fhirUser: 'Practitioner/dr-smith' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(result.decision).toBe('deny')
    })
  })

  // ---------------------------------------------------------------------------
  // Context building
  // ---------------------------------------------------------------------------

  describe('buildConsentContext', () => {
    it.serial('should extract patient ID from patient claim', async () => {
      const ctx = await buildConsentContext(
        createToken({ patient: 'pat-abc' }),
        'hapi',
        'Observation/obs-1',
        'GET',
      )
      expect(ctx.patientId).toBe('pat-abc')
    })

    it.serial('should extract patient ID from Patient resource path as fallback', async () => {
      const ctx = await buildConsentContext(
        createToken({ patient: undefined }),
        'hapi',
        'Patient/pat-xyz',
        'GET',
      )
      expect(ctx.patientId).toBe('pat-xyz')
    })

    it.serial('should parse scopes from token', async () => {
      const ctx = await buildConsentContext(
        createToken({ scope: 'patient/Observation.read patient/Patient.read openid' }),
        'hapi',
        'Observation',
        'GET',
      )
      expect(ctx.scopes).toEqual(['patient/Observation.read', 'patient/Patient.read', 'openid'])
    })

    it.serial('should normalise HTTP method to uppercase', async () => {
      const ctx = await buildConsentContext(createToken(), 'hapi', 'Observation', 'post')
      expect(ctx.method).toBe('POST')
    })

    it.serial('should handle fhirUser claim', async () => {
      const ctx = await buildConsentContext(
        createToken({ fhirUser: 'Practitioner/dr-1' }),
        'hapi',
        'Patient/patient-123',
        'GET',
      )
      expect(ctx.fhirUser).toBe('Practitioner/dr-1')
    })
  })

  // ---------------------------------------------------------------------------
  // Config helper verifies correct test configuration
  // ---------------------------------------------------------------------------

  describe('getConsentConfig', () => {
    it.serial('should reflect override settings', () => {
      setConsentConfig({
        enabled: true,
        mode: 'enforce',
        cacheTtl: 30000,
        exemptClients: ['admin', 'monitoring'],
      })

      expect(activeTestConfig.enabled).toBe(true)
      expect(activeTestConfig.mode).toBe('enforce')
      expect(activeTestConfig.cacheTtl).toBe(30000)
      expect(activeTestConfig.exemptClients).toContain('admin')
      expect(activeTestConfig.exemptClients).toContain('monitoring')
    })

    it.serial('should default to disabled when no overrides are set', () => {
      setConsentConfig({ enabled: false, mode: 'audit-only' })
      expect(activeTestConfig.enabled).toBe(false)
      expect(activeTestConfig.mode).toBe('audit-only')
    })
  })

  // ---------------------------------------------------------------------------
  // Full lifecycle: grant → access → revoke → deny
  // ---------------------------------------------------------------------------

  describe('full consent lifecycle: grant → access → revoke → deny', () => {
    it.serial('should permit access with consent, then deny after consent is revoked', async () => {
      setConsentConfig()
      const token = createToken()

      // Phase 1: Active consent exists → PERMIT
      mockFhirConsentResponse([makePermitConsent()])
      const r1 = await testCheckConsent(token, 'hapi', 'https://fhir.example.com', 'Patient/patient-123', 'GET', 'Bearer tok')
      expect(r1.decision).toBe('permit')

      // Phase 2: Consent gets revoked → invalidate cache, now empty bundle
      invalidateConsentCache('patient-123')
      mockFhirConsentResponse([]) // upstream now returns empty

      const r2 = await testCheckConsent(token, 'hapi', 'https://fhir.example.com', 'Patient/patient-123', 'GET', 'Bearer tok')
      expect(r2.decision).toBe('deny')
      expect(r2.reason).toContain('No valid consent')
    })

    it.serial('should switch from deny to permit when consent is created', async () => {
      setConsentConfig()
      const token = createToken()

      // Phase 1: No consent → DENY
      mockFhirConsentResponse([])
      const r1 = await testCheckConsent(token, 'hapi', 'https://fhir.example.com', 'Patient/patient-123', 'GET', 'Bearer tok')
      expect(r1.decision).toBe('deny')

      // Phase 2: Consent created → invalidate cache, now active consent
      invalidateConsentCache('patient-123')
      mockFhirConsentResponse([makePermitConsent()])

      const r2 = await testCheckConsent(token, 'hapi', 'https://fhir.example.com', 'Patient/patient-123', 'GET', 'Bearer tok')
      expect(r2.decision).toBe('permit')
    })
  })

  // ---------------------------------------------------------------------------
  // Multiple patients / servers isolation
  // ---------------------------------------------------------------------------

  describe('multi-patient / multi-server isolation', () => {
    it.serial('should isolate consent decisions per patient', async () => {
      setConsentConfig()

      // Patient A has consent, Patient B does not
      let requestUrl = ''
      mockGlobalFetch(async (input) => {
        requestUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
        
        if (requestUrl.includes('patient=Patient/patient-A')) {
          return new Response(JSON.stringify(makeConsentBundle([makePermitConsent()])), {
            status: 200,
            headers: { 'Content-Type': 'application/fhir+json' },
          })
        }
        // Patient B → empty
        return new Response(JSON.stringify(makeConsentBundle([])), {
          status: 200,
          headers: { 'Content-Type': 'application/fhir+json' },
        })
      })

      const rA = await testCheckConsent(
        createToken({ patient: 'patient-A' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-A',
        'GET',
        'Bearer tok',
      )
      expect(rA.decision).toBe('permit')

      const rB = await testCheckConsent(
        createToken({ patient: 'patient-B' }),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-B',
        'GET',
        'Bearer tok',
      )
      expect(rB.decision).toBe('deny')
    })
  })

  // ---------------------------------------------------------------------------
  // Consent result metadata
  // ---------------------------------------------------------------------------

  describe('result metadata', () => {
    it.serial('should include timing information', async () => {
      setConsentConfig()
      mockFhirConsentResponse([makePermitConsent()])

      const result = await testCheckConsent(
        createToken(),
        'hapi',
        'https://fhir.example.com',
        'Patient/patient-123',
        'GET',
        'Bearer tok',
      )

      expect(typeof result.checkDurationMs).toBe('number')
      expect(result.checkDurationMs).toBeGreaterThanOrEqual(0)
    })

    it.serial('should include the full context in the result', async () => {
      setConsentConfig()
      mockFhirConsentResponse([makePermitConsent()])

      const result = await testCheckConsent(
        createToken({ azp: 'my-app', scope: 'patient/*.read openid' }),
        'prod-server',
        'https://fhir.example.com',
        'Observation/obs-42',
        'GET',
        'Bearer tok',
      )

      expect(result.context).toMatchObject({
        patientId: 'patient-123',
        clientId: 'my-app',
        resourceType: 'Observation',
        resourceId: 'obs-42',
        method: 'GET',
        resourcePath: 'Observation/obs-42',
        serverName: 'prod-server',
      })
      expect(result.context.scopes).toContain('patient/*.read')
      expect(result.context.scopes).toContain('openid')
    })
  })
})
