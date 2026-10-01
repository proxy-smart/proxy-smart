/**
 * Tenant Isolation Tests
 *
 * Tests for multi-tenant org-enforced routing, query-level isolation,
 * and org resolution from token claims.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import {
  resolveOrganization,
  enforceOrgServerAccess,
  applyQueryIsolation,
  enforceTenantIsolation,
} from '../src/lib/tenant-isolation'
import type { FHIRServerInfo } from '../src/lib/fhir-server-store'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeServer(overrides: Partial<FHIRServerInfo> = {}): FHIRServerInfo {
  return {
    name: 'test-fhir',
    url: 'https://fhir.example.com',
    identifier: 'test-server',
    metadata: { fhirVersion: 'R4', serverName: 'Test FHIR', supported: true },
    lastUpdated: Date.now(),
    ...overrides,
  }
}

// ── resolveOrganization ──────────────────────────────────────────────────────

describe('resolveOrganization', () => {
  it('resolves org from KC 26 organization claim (object format)', () => {
    const result = resolveOrganization({ organization: { 'maxhealth': {} } })
    expect(result.organizationId).toBe('maxhealth')
    expect(result.source).toBe('jwt-claim')
  })

  it('resolves org from KC 26 organization claim (alias list format)', () => {
    const result = resolveOrganization({ organization: ['maxhealth', 'other'] })
    expect(result.organizationId).toBe('maxhealth')
    expect(result.source).toBe('jwt-claim')
  })

  it('resolves org from simple string organization claim', () => {
    const result = resolveOrganization({ organization: 'clinic-abc' })
    expect(result.organizationId).toBe('clinic-abc')
    expect(result.source).toBe('jwt-claim')
  })

  it('resolves org from tenant launch context', () => {
    const result = resolveOrganization({ tenant: 'tenant-xyz' })
    expect(result.organizationId).toBe('tenant-xyz')
    expect(result.source).toBe('launch-context')
  })

  it('resolves org from organization_attribute', () => {
    const result = resolveOrganization({ organization_attribute: 'org-from-profile' })
    expect(result.organizationId).toBe('org-from-profile')
    expect(result.source).toBe('user-attribute')
  })

  it('prefers JWT claim over launch context', () => {
    const result = resolveOrganization({ organization: 'jwt-org', tenant: 'launch-org' })
    expect(result.organizationId).toBe('jwt-org')
    expect(result.source).toBe('jwt-claim')
  })

  it('returns null when no org info available', () => {
    const result = resolveOrganization({ sub: 'user-123' })
    expect(result.organizationId).toBeNull()
    expect(result.source).toBe('none')
  })

  it('ignores empty strings', () => {
    const result = resolveOrganization({ tenant: '', organization_attribute: '' })
    expect(result.organizationId).toBeNull()
    expect(result.source).toBe('none')
  })

  it('handles KC 26 object with multiple orgs (takes first)', () => {
    const result = resolveOrganization({ organization: { 'org-a': {}, 'org-b': {} } })
    expect(result.organizationId).toBe('org-a')
  })
})

// ── enforceOrgServerAccess ───────────────────────────────────────────────────

describe('enforceOrgServerAccess', () => {
  const savedEnv = process.env.TENANT_ISOLATION_MODE

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.TENANT_ISOLATION_MODE
    else process.env.TENANT_ISOLATION_MODE = savedEnv
  })

  it('allows access when tenant isolation is disabled', () => {
    process.env.TENANT_ISOLATION_MODE = 'disabled'
    const server = makeServer({ organizationIds: ['org-a'] })
    const tenant = { organizationId: 'org-b', source: 'jwt-claim' as const }
    const result = enforceOrgServerAccess(server, tenant)
    expect(result.allowed).toBe(true)
  })

  it('allows access when server has no org restrictions', () => {
    process.env.TENANT_ISOLATION_MODE = 'enforce'
    const server = makeServer({ organizationIds: undefined })
    const tenant = { organizationId: 'any-org', source: 'jwt-claim' as const }
    const result = enforceOrgServerAccess(server, tenant)
    expect(result.allowed).toBe(true)
  })

  it('allows access when user org is in server list', () => {
    process.env.TENANT_ISOLATION_MODE = 'enforce'
    const server = makeServer({ organizationIds: ['org-a', 'org-b'] })
    const tenant = { organizationId: 'org-b', source: 'jwt-claim' as const }
    const result = enforceOrgServerAccess(server, tenant)
    expect(result.allowed).toBe(true)
  })

  it('denies access when user org is not in server list (enforce)', () => {
    process.env.TENANT_ISOLATION_MODE = 'enforce'
    const server = makeServer({ organizationIds: ['org-a'] })
    const tenant = { organizationId: 'org-b', source: 'jwt-claim' as const }
    const result = enforceOrgServerAccess(server, tenant)
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
    expect(result.body?.error).toBe('tenant_access_denied')
  })

  it('allows access but logs when user org is not in server list (audit-only)', () => {
    process.env.TENANT_ISOLATION_MODE = 'audit-only'
    const server = makeServer({ organizationIds: ['org-a'] })
    const tenant = { organizationId: 'org-b', source: 'jwt-claim' as const }
    const result = enforceOrgServerAccess(server, tenant)
    expect(result.allowed).toBe(true)
  })

  it('denies access when user has no org but server requires one (enforce)', () => {
    process.env.TENANT_ISOLATION_MODE = 'enforce'
    const server = makeServer({ organizationIds: ['org-a'] })
    const tenant = { organizationId: null, source: 'none' as const }
    const result = enforceOrgServerAccess(server, tenant)
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
  })

  it('allows access with empty organizationIds array (no restrictions)', () => {
    process.env.TENANT_ISOLATION_MODE = 'enforce'
    const server = makeServer({ organizationIds: [] })
    const tenant = { organizationId: 'any-org', source: 'jwt-claim' as const }
    const result = enforceOrgServerAccess(server, tenant)
    expect(result.allowed).toBe(true)
  })
})

// ── applyQueryIsolation ──────────────────────────────────────────────────────

describe('applyQueryIsolation', () => {
  const savedEnv = process.env.TENANT_QUERY_ISOLATION

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.TENANT_QUERY_ISOLATION
    else process.env.TENANT_QUERY_ISOLATION = savedEnv
  })

  it('does nothing when query isolation is disabled', () => {
    process.env.TENANT_QUERY_ISOLATION = 'false'
    const tenant = { organizationId: 'org-a', source: 'jwt-claim' as const }
    const result = applyQueryIsolation(tenant, 'Patient', 'GET', '')
    expect(result).toBe('')
  })

  it('injects _tag for search queries when enabled', () => {
    process.env.TENANT_QUERY_ISOLATION = 'true'
    const tenant = { organizationId: 'org-a', source: 'jwt-claim' as const }
    const result = applyQueryIsolation(tenant, 'Patient', 'GET', '')
    expect(result).toContain('_tag=')
    expect(result).toContain('org-a')
  })

  it('appends to existing query string', () => {
    process.env.TENANT_QUERY_ISOLATION = 'true'
    const tenant = { organizationId: 'org-a', source: 'jwt-claim' as const }
    const result = applyQueryIsolation(tenant, 'Observation', 'GET', '?status=active')
    expect(result).toContain('?status=active&_tag=')
    expect(result).toContain('org-a')
  })

  it('does not inject for direct reads (resource/id)', () => {
    process.env.TENANT_QUERY_ISOLATION = 'true'
    const tenant = { organizationId: 'org-a', source: 'jwt-claim' as const }
    const result = applyQueryIsolation(tenant, 'Patient/123', 'GET', '')
    expect(result).toBe('')
  })

  it('does not inject when user has no org', () => {
    process.env.TENANT_QUERY_ISOLATION = 'true'
    const tenant = { organizationId: null, source: 'none' as const }
    const result = applyQueryIsolation(tenant, 'Patient', 'GET', '')
    expect(result).toBe('')
  })

  it('applies to POST _search', () => {
    process.env.TENANT_QUERY_ISOLATION = 'true'
    const tenant = { organizationId: 'org-b', source: 'jwt-claim' as const }
    const result = applyQueryIsolation(tenant, 'Patient/_search', 'POST', '')
    expect(result).toContain('_tag=')
    expect(result).toContain('org-b')
  })
})

// ── enforceTenantIsolation (combined) ────────────────────────────────────────

describe('enforceTenantIsolation', () => {
  const savedIsolation = process.env.TENANT_ISOLATION_MODE
  const savedQuery = process.env.TENANT_QUERY_ISOLATION

  afterEach(() => {
    if (savedIsolation === undefined) delete process.env.TENANT_ISOLATION_MODE
    else process.env.TENANT_ISOLATION_MODE = savedIsolation
    if (savedQuery === undefined) delete process.env.TENANT_QUERY_ISOLATION
    else process.env.TENANT_QUERY_ISOLATION = savedQuery
  })

  it('resolves tenant and allows when everything matches', () => {
    process.env.TENANT_ISOLATION_MODE = 'enforce'
    process.env.TENANT_QUERY_ISOLATION = 'false'
    const server = makeServer({ organizationIds: ['org-a'] })
    const token = { organization: 'org-a' }
    const result = enforceTenantIsolation(server, token, 'Patient', 'GET', '')
    expect(result.allowed).toBe(true)
    expect(result.tenant.organizationId).toBe('org-a')
  })

  it('denies when org mismatch in enforce mode', () => {
    process.env.TENANT_ISOLATION_MODE = 'enforce'
    const server = makeServer({ organizationIds: ['org-a'] })
    const token = { organization: 'org-wrong' }
    const result = enforceTenantIsolation(server, token, 'Patient', 'GET', '')
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
  })

  it('combines routing + query isolation', () => {
    process.env.TENANT_ISOLATION_MODE = 'enforce'
    process.env.TENANT_QUERY_ISOLATION = 'true'
    const server = makeServer({ organizationIds: ['org-a'] })
    const token = { organization: 'org-a' }
    const result = enforceTenantIsolation(server, token, 'Patient', 'GET', '')
    expect(result.allowed).toBe(true)
    expect(result.modifiedQueryString).toContain('org-a')
  })
})
