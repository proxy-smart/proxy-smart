/**
 * SMART Scope Enforcement E2E Tests
 *
 * Integration tests that exercise the full scope enforcement flow through
 * an Elysia HTTP pipeline mirroring the production FHIR proxy handler:
 *
 *   HTTP request → auth check → scope enforcement → upstream proxy → response
 *
 * Uses the real enforceScopeAccess() function,
 * mocking only external dependencies (token validation, upstream FHIR server).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { config } from '../src/config'
import { enforceScopeAccess, type AccessControlContext } from '../src/lib/smart-access-control'
import { clearAccessControlModes } from './helpers/access-context'
import { applyEnv } from './helpers/test-env'

// ── Mock token validator ─────────────────────────────────────────────────────

/** Simulated token payloads keyed by bearer token string */
const tokenStore = new Map<string, Record<string, unknown>>()

function mockValidateToken(token: string): Record<string, unknown> {
  const payload = tokenStore.get(token)
  if (!payload) throw new Error('Invalid token')
  return payload
}

// ── Mock upstream FHIR server ────────────────────────────────────────────────

const upstreamResponses = new Map<string, { status: number; body: unknown }>()

function setUpstreamResponse(method: string, resourcePath: string, status: number, body: unknown) {
  upstreamResponses.set(`${method} ${resourcePath}`, { status, body })
}

function getUpstreamResponse(method: string, resourcePath: string) {
  // Try exact match first, then wildcard by method
  return (
    upstreamResponses.get(`${method} ${resourcePath}`) ??
    upstreamResponses.get(`${method} *`) ?? { status: 200, body: { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] } }
  )
}

// ── Build test app mirroring production proxyFHIR pipeline ───────────────────

const FHIR_SERVER_URL = 'https://fhir.test.local/fhir'
const FHIR_SERVER_ID = 'test-fhir'
const FHIR_SERVER_NAME = 'test-fhir-server'

function buildTestApp() {
  return new Elysia()
    .all(`/${config.name}/:server_name/:fhir_version/*`, async ({ params, request, set }) => {
      // 1) Version check
      if (!['R4', 'R5'].includes(params.fhir_version)) {
        set.status = 400
        return { error: `Unsupported FHIR version: ${params.fhir_version}` }
      }

      // 2) Server lookup (mocked — only our test server exists)
      if (params.server_name !== FHIR_SERVER_NAME) {
        set.status = 404
        return { error: `FHIR server '${params.server_name}' not found` }
      }

      // 3) Auth — extract and validate token
      const authHeader = request.headers.get('authorization') || ''
      const token = authHeader.replace(/^Bearer\s+/, '')

      const requestUrl = new URL(request.url)
      const parts = requestUrl.pathname.split('/').filter(Boolean)
      const resourcePath = parts.slice(3).join('/')

      // Skip auth on metadata
      let tokenPayload: Record<string, unknown> | null = null
      if (!(request.method === 'GET' && resourcePath === 'metadata')) {
        if (!token) {
          set.status = 401
          return { error: 'Authentication required' }
        }
        try {
          tokenPayload = mockValidateToken(token)
        } catch {
          set.status = 401
          return { error: 'Authentication failed' }
        }
      }

      // 4) SMART access control (scope enforcement)
      if (tokenPayload) {
        const acCtx: AccessControlContext = {
          tokenPayload,
          resourcePath,
          method: request.method,
          serverUrl: FHIR_SERVER_URL,
          serverId: FHIR_SERVER_ID,
          serverName: FHIR_SERVER_NAME,
          authHeader,
          upstreamFetch: mock(() => Promise.resolve(new Response('{}', { status: 200 }))),
        }

        // Scope enforcement
        const scopeResult = enforceScopeAccess(acCtx)
        if (!scopeResult.allowed) {
          set.status = scopeResult.status!
          return scopeResult.body
        }
      }

      // 5) Proxy to upstream (mocked)
      const upstream = getUpstreamResponse(request.method, resourcePath)
      set.status = upstream.status
      return upstream.body
    })
}

// ── Request helpers ──────────────────────────────────────────────────────────

const BASE = 'http://localhost'
const PREFIX = `/${config.name}/${FHIR_SERVER_NAME}/R4`

function fhirRequest(method: string, path: string, token?: string, body?: string) {
  const headers: Record<string, string> = { Accept: 'application/fhir+json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/fhir+json'

  return new Request(`${BASE}${PREFIX}/${path}`, {
    method,
    headers,
    body: ['POST', 'PUT', 'PATCH'].includes(method) ? (body ?? '{}') : undefined,
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('Scope Enforcement E2E — FHIR Proxy Pipeline', () => {
  let app: ReturnType<typeof buildTestApp>

  beforeEach(() => {
    app = buildTestApp()
    tokenStore.clear()
    upstreamResponses.clear()

    // Register test tokens
    tokenStore.set('patient-read-all', {
      sub: 'user-1',
      scope: 'openid fhirUser patient/*.read',
      fhirUser: 'Patient/p-1',
    })
    tokenStore.set('patient-obs-read', {
      sub: 'user-2',
      scope: 'openid patient/Observation.read',
      fhirUser: 'Patient/p-2',
    })
    tokenStore.set('patient-obs-rs', {
      sub: 'user-3',
      scope: 'openid patient/Observation.rs',
      fhirUser: 'Patient/p-3',
    })
    tokenStore.set('patient-cruds', {
      sub: 'user-4',
      scope: 'openid patient/Patient.cruds',
      fhirUser: 'Patient/p-4',
    })
    tokenStore.set('system-read', {
      sub: 'service-1',
      scope: 'openid system/*.read',
    })
    tokenStore.set('user-write-obs', {
      sub: 'practitioner-1',
      scope: 'openid user/Observation.write',
      fhirUser: 'Practitioner/dr-1',
    })
    tokenStore.set('no-smart-scopes', {
      sub: 'user-5',
      scope: 'openid profile email',
      fhirUser: 'Patient/p-5',
    })
    tokenStore.set('patient-obs-write', {
      sub: 'user-6',
      scope: 'openid patient/Observation.write',
      fhirUser: 'Patient/p-6',
    })
    tokenStore.set('superuser', {
      sub: 'admin-1',
      scope: 'openid system/*.*',
    })
    tokenStore.set('patient-multi', {
      sub: 'user-7',
      scope: 'openid patient/Observation.rs patient/Condition.rs patient/Patient.rs',
      fhirUser: 'Patient/p-7',
    })
    tokenStore.set('v2-patient-cu', {
      sub: 'user-8',
      scope: 'openid patient/Patient.cu',
      fhirUser: 'Patient/p-8',
    })

    // Default upstream response
    setUpstreamResponse('GET', '*', 200, { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] })
    setUpstreamResponse('POST', '*', 201, { resourceType: 'Observation', id: 'new-1' })
    setUpstreamResponse('PUT', '*', 200, { resourceType: 'Patient', id: 'p-4' })
    setUpstreamResponse('DELETE', '*', 204, '')
  })

  afterEach(clearAccessControlModes)

  // ── Authentication ─────────────────────────────────────────────────────────

  describe('authentication layer', () => {
    it('should return 401 when no token is provided', async () => {
      applyEnv({ SCOPE_ENFORCEMENT_MODE: 'enforce' })
      const res = await app.handle(fhirRequest('GET', 'Patient'))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Authentication required')
    })

    it('should return 401 for invalid token', async () => {
      applyEnv({ SCOPE_ENFORCEMENT_MODE: 'enforce' })
      const res = await app.handle(fhirRequest('GET', 'Patient', 'invalid-token'))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Authentication failed')
    })

    it('should allow unauthenticated access to metadata endpoint', async () => {
      applyEnv({ SCOPE_ENFORCEMENT_MODE: 'enforce' })
      setUpstreamResponse('GET', 'metadata', 200, { resourceType: 'CapabilityStatement' })
      const res = await app.handle(fhirRequest('GET', 'metadata'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.resourceType).toBe('CapabilityStatement')
    })
  })

  // ── Scope enforcement: disabled ─────────────────────────────────────────

  describe('scope enforcement disabled', () => {
    beforeEach(() => applyEnv({ SCOPE_ENFORCEMENT_MODE: 'disabled' }))

    it('should allow any request regardless of scopes', async () => {
      const res = await app.handle(fhirRequest('GET', 'Patient', 'no-smart-scopes'))
      expect(res.status).toBe(200)
    })

    it('should allow writes even without write scopes', async () => {
      const res = await app.handle(fhirRequest('POST', 'Observation', 'patient-obs-read'))
      expect(res.status).toBe(201)
    })
  })

  // ── Scope enforcement: enforce mode ────────────────────────────────────────

  describe('scope enforcement — enforce mode', () => {
    beforeEach(() => applyEnv({ SCOPE_ENFORCEMENT_MODE: 'enforce' }))

    // ── Allowed requests ──

    it('should allow GET Patient with patient/*.read scope', async () => {
      const res = await app.handle(fhirRequest('GET', 'Patient', 'patient-read-all'))
      expect(res.status).toBe(200)
    })

    it('should allow GET Observation with patient/Observation.read scope', async () => {
      const res = await app.handle(fhirRequest('GET', 'Observation', 'patient-obs-read'))
      expect(res.status).toBe(200)
    })

    it('should allow GET Patient/123 with patient/*.read scope', async () => {
      setUpstreamResponse('GET', 'Patient/123', 200, { resourceType: 'Patient', id: '123' })
      const res = await app.handle(fhirRequest('GET', 'Patient/123', 'patient-read-all'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.resourceType).toBe('Patient')
    })

    it('should allow GET with system/*.read scope for any resource', async () => {
      for (const resource of ['Patient', 'Observation', 'Condition', 'Encounter']) {
        const res = await app.handle(fhirRequest('GET', resource, 'system-read'))
        expect(res.status).toBe(200)
      }
    })

    it('should allow system/*.* (superuser) for any method and resource', async () => {
      const cases = [
        { method: 'GET', path: 'Patient' },
        { method: 'POST', path: 'Observation' },
        { method: 'PUT', path: 'Patient/123' },
        { method: 'DELETE', path: 'Observation/456' },
      ]
      for (const { method, path } of cases) {
        const res = await app.handle(fhirRequest(method, path, 'superuser'))
        expect(res.status).toBeLessThan(400)
      }
    })

    // ── Denied requests ──

    it('should deny GET Patient with patient/Observation.read scope (wrong resource)', async () => {
      const res = await app.handle(fhirRequest('GET', 'Patient', 'patient-obs-read'))
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('insufficient_scope')
      expect(body.message).toContain('Patient')
    })

    it('should deny POST Observation with patient/Observation.read scope (read-only)', async () => {
      const res = await app.handle(fhirRequest('POST', 'Observation', 'patient-obs-read'))
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('insufficient_scope')
    })

    it('should deny GET when token has no SMART scopes (only openid/profile/email)', async () => {
      const res = await app.handle(fhirRequest('GET', 'Observation', 'no-smart-scopes'))
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('insufficient_scope')
    })

    it('should deny DELETE with system/*.read scope (read does not grant delete)', async () => {
      const res = await app.handle(fhirRequest('DELETE', 'Patient/123', 'system-read'))
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('insufficient_scope')
    })

    it('should deny GET Observation with user/Observation.write scope', async () => {
      const res = await app.handle(fhirRequest('GET', 'Observation', 'user-write-obs'))
      expect(res.status).toBe(403)
    })

    it('should deny PUT with only read+search scope (rs)', async () => {
      const res = await app.handle(fhirRequest('PUT', 'Observation/123', 'patient-obs-rs'))
      expect(res.status).toBe(403)
    })
  })

  // ── Resource-type isolation ────────────────────────────────────────────────

  describe('resource-type isolation', () => {
    beforeEach(() => applyEnv({ SCOPE_ENFORCEMENT_MODE: 'enforce' }))

    it('should allow only the resource types granted by the token', async () => {
      // patient-multi has: patient/Observation.rs patient/Condition.rs patient/Patient.rs
      const allowed = ['Observation', 'Condition', 'Patient']
      const denied = ['Encounter', 'MedicationRequest', 'AllergyIntolerance', 'Procedure']

      for (const resource of allowed) {
        const res = await app.handle(fhirRequest('GET', resource, 'patient-multi'))
        expect(res.status).toBe(200)
      }
      for (const resource of denied) {
        const res = await app.handle(fhirRequest('GET', resource, 'patient-multi'))
        expect(res.status).toBe(403)
      }
    })
  })

  // ── v2 CRUDS scopes through the pipeline ───────────────────────────────────

  describe('v2 CRUDS scopes', () => {
    beforeEach(() => applyEnv({ SCOPE_ENFORCEMENT_MODE: 'enforce' }))

    it('should allow POST and PUT with patient/Patient.cu scope', async () => {
      const post = await app.handle(fhirRequest('POST', 'Patient', 'v2-patient-cu'))
      expect(post.status).toBeLessThan(400)

      const put = await app.handle(fhirRequest('PUT', 'Patient/123', 'v2-patient-cu'))
      expect(put.status).toBeLessThan(400)
    })

    it('should deny GET with patient/Patient.cu scope (no read)', async () => {
      const res = await app.handle(fhirRequest('GET', 'Patient', 'v2-patient-cu'))
      expect(res.status).toBe(403)
    })

    it('should deny DELETE with patient/Patient.cu scope (no delete)', async () => {
      const res = await app.handle(fhirRequest('DELETE', 'Patient/123', 'v2-patient-cu'))
      expect(res.status).toBe(403)
    })

    it('should allow all CRUD operations with patient/Patient.cruds scope', async () => {
      const methods: Array<{ method: string; path: string }> = [
        { method: 'GET', path: 'Patient' },
        { method: 'POST', path: 'Patient' },
        { method: 'PUT', path: 'Patient/p-4' },
        { method: 'DELETE', path: 'Patient/p-4' },
      ]
      for (const { method, path } of methods) {
        const res = await app.handle(fhirRequest(method, path, 'patient-cruds'))
        expect(res.status).toBeLessThan(400)
      }
    })
  })

  // ── POST _search handling ──────────────────────────────────────────────────

  describe('POST _search (search via POST)', () => {
    beforeEach(() => applyEnv({ SCOPE_ENFORCEMENT_MODE: 'enforce' }))

    it('should allow POST _search with read scope (treated as search)', async () => {
      setUpstreamResponse('POST', 'Observation/_search', 200, { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] })
      const res = await app.handle(fhirRequest('POST', 'Observation/_search', 'patient-obs-read'))
      expect(res.status).toBe(200)
    })

    it('should allow POST _search with rs scope', async () => {
      setUpstreamResponse('POST', 'Observation/_search', 200, { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] })
      const res = await app.handle(fhirRequest('POST', 'Observation/_search', 'patient-obs-rs'))
      expect(res.status).toBe(200)
    })

    it('should deny POST _search when only write scope is present', async () => {
      const res = await app.handle(fhirRequest('POST', 'Observation/_search', 'patient-obs-write'))
      expect(res.status).toBe(403)
    })

    it('should deny POST _search for wrong resource type', async () => {
      const res = await app.handle(fhirRequest('POST', 'Patient/_search', 'patient-obs-read'))
      expect(res.status).toBe(403)
    })

    it('should still require create scope for regular POST (not _search)', async () => {
      // patient-obs-read only has read scope — regular POST (create) should fail
      const res = await app.handle(fhirRequest('POST', 'Observation', 'patient-obs-read'))
      expect(res.status).toBe(403)
    })
  })

  // ── Audit-only mode ────────────────────────────────────────────────────────

  describe('scope enforcement — audit-only mode', () => {
    beforeEach(() => applyEnv({ SCOPE_ENFORCEMENT_MODE: 'audit-only' }))

    it('should allow request even when scopes do not match (logs only)', async () => {
      const res = await app.handle(fhirRequest('GET', 'Patient', 'no-smart-scopes'))
      expect(res.status).toBe(200)
    })

    it('should allow writes without write scopes in audit-only mode', async () => {
      const res = await app.handle(fhirRequest('POST', 'Observation', 'patient-obs-read'))
      expect(res.status).toBe(201)
    })
  })

  // ── Edge cases through the pipeline ────────────────────────────────────────

  describe('edge cases through HTTP pipeline', () => {
    beforeEach(() => applyEnv({ SCOPE_ENFORCEMENT_MODE: 'enforce' }))

    it('should handle resource paths with IDs (Patient/123)', async () => {
      setUpstreamResponse('GET', 'Patient/123', 200, { resourceType: 'Patient', id: '123' })
      const res = await app.handle(fhirRequest('GET', 'Patient/123', 'patient-read-all'))
      expect(res.status).toBe(200)
    })

    it('should handle nested paths (Patient/123/_history)', async () => {
      setUpstreamResponse('GET', 'Patient/123/_history', 200, { resourceType: 'Bundle', type: 'history' })
      const res = await app.handle(fhirRequest('GET', 'Patient/123/_history', 'patient-read-all'))
      expect(res.status).toBe(200)
    })

    it('should return 400 for unsupported FHIR version', async () => {
      const req = new Request(`${BASE}/${config.name}/${FHIR_SERVER_NAME}/STU3/Patient`, {
        headers: { Authorization: 'Bearer patient-read-all' },
      })
      const res = await app.handle(req)
      expect(res.status).toBe(400)
    })

    it('should return 404 for unknown FHIR server', async () => {
      const req = new Request(`${BASE}/${config.name}/nonexistent-server/R4/Patient`, {
        headers: { Authorization: 'Bearer patient-read-all' },
      })
      const res = await app.handle(req)
      expect(res.status).toBe(404)
    })

    it('should handle $operation paths with correct scope', async () => {
      setUpstreamResponse('GET', 'Patient/$everything', 200, { resourceType: 'Bundle', type: 'searchset' })
      const res = await app.handle(fhirRequest('GET', 'Patient/$everything', 'patient-read-all'))
      expect(res.status).toBe(200)
    })
  })
})
