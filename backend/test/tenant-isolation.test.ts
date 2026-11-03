// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Multi-tenant org-enforced routing, query-level isolation, and org resolution from token claims.
import { describe, it, expect, afterEach, beforeEach, spyOn } from 'bun:test'
import {
  resolveOrganization,
  enforceOrgServerAccess,
  applyQueryIsolation,
  enforceTenantIsolation,
  type TenantContext,
} from '../src/lib/tenant-isolation'
import type { FHIRServerInfo } from '../src/lib/fhir-server-store'
import { logger } from '../src/lib/logger'
import { applyEnv, useTestEnv } from './helpers/test-env'

const ORG_TAG_SYSTEM = 'https://proxy-smart.com/tenant'

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

const member = (organizationId: string): TenantContext => ({ organizationId, source: 'jwt-claim' })
const NO_ORG: TenantContext = { organizationId: null, source: 'none' }

/** The `_tag` filters a query string carries, decoded. */
function tagFilters(queryString: string): string[] {
  return new URLSearchParams(queryString).getAll('_tag')
}

useTestEnv({ TENANT_ISOLATION_MODE: undefined, TENANT_QUERY_ISOLATION: undefined })

let warn: ReturnType<typeof spyOn<typeof logger.fhir, 'warn'>>
beforeEach(() => {
  warn = spyOn(logger.fhir, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

describe('resolveOrganization', () => {
  it('resolves org from KC 26 organization claim (object format)', () => {
    expect(resolveOrganization({ organization: { 'maxhealth': {} } })).toEqual(member('maxhealth'))
  })

  it('resolves org from KC 26 organization claim (alias list format)', () => {
    expect(resolveOrganization({ organization: ['maxhealth', 'other'] })).toEqual(member('maxhealth'))
  })

  it('resolves org from simple string organization claim', () => {
    expect(resolveOrganization({ organization: 'clinic-abc' })).toEqual(member('clinic-abc'))
  })

  it('resolves org from tenant launch context', () => {
    expect(resolveOrganization({ tenant: 'tenant-xyz' })).toEqual({ organizationId: 'tenant-xyz', source: 'launch-context' })
  })

  it('resolves org from organization_attribute', () => {
    expect(resolveOrganization({ organization_attribute: 'org-from-profile' }))
      .toEqual({ organizationId: 'org-from-profile', source: 'user-attribute' })
  })

  it('prefers JWT claim over launch context', () => {
    expect(resolveOrganization({ organization: 'jwt-org', tenant: 'launch-org' })).toEqual(member('jwt-org'))
  })

  it('returns null when no org info available', () => {
    expect(resolveOrganization({ sub: 'user-123' })).toEqual(NO_ORG)
  })

  it('ignores empty strings', () => {
    expect(resolveOrganization({ tenant: '', organization_attribute: '' })).toEqual(NO_ORG)
  })

  it('ignores an empty organization claim instead of reading it as an org', () => {
    expect(resolveOrganization({ organization: [] })).toEqual(NO_ORG)
    expect(resolveOrganization({ organization: {} })).toEqual(NO_ORG)
  })

  it('handles KC 26 object with multiple orgs (takes first)', () => {
    expect(resolveOrganization({ organization: { 'org-a': {}, 'org-b': {} } }).organizationId).toBe('org-a')
  })
})

describe('enforceOrgServerAccess', () => {
  it('allows access without a word when tenant isolation is disabled', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'disabled' })
    const result = enforceOrgServerAccess(makeServer({ organizationIds: ['org-a'] }), member('org-b'))
    expect(result.allowed).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('allows access when server has no org restrictions', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce' })
    expect(enforceOrgServerAccess(makeServer({ organizationIds: undefined }), member('any-org')).allowed).toBe(true)
  })

  it('allows access when user org is in server list', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce' })
    expect(enforceOrgServerAccess(makeServer({ organizationIds: ['org-a', 'org-b'] }), member('org-b')).allowed).toBe(true)
  })

  it('denies access when user org is not in server list (enforce)', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce' })
    const result = enforceOrgServerAccess(makeServer({ organizationIds: ['org-a'] }), member('org-b'))
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
    expect(result.body?.error).toBe('tenant_access_denied')
  })

  it('matches org ids exactly, not by prefix', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce' })
    expect(enforceOrgServerAccess(makeServer({ organizationIds: ['org-a'] }), member('org-ab')).allowed).toBe(false)
    expect(enforceOrgServerAccess(makeServer({ organizationIds: ['org-ab'] }), member('org-a')).allowed).toBe(false)
  })

  it('allows access but logs the mismatch when user org is not in server list (audit-only)', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'audit-only' })
    const result = enforceOrgServerAccess(makeServer({ organizationIds: ['org-a'] }), member('org-b'))
    expect(result.allowed).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ userOrg: 'org-b', allowedOrgs: ['org-a'], mode: 'audit-only' })
  })

  it('denies access when user has no org but server requires one (enforce)', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce' })
    const result = enforceOrgServerAccess(makeServer({ organizationIds: ['org-a'] }), NO_ORG)
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
    expect(result.body?.error).toBe('tenant_access_denied')
  })

  it('allows access with empty organizationIds array (no restrictions)', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce' })
    expect(enforceOrgServerAccess(makeServer({ organizationIds: [] }), member('any-org')).allowed).toBe(true)
  })
})

describe('applyQueryIsolation', () => {
  it('does nothing when query isolation is disabled', () => {
    applyEnv({ TENANT_QUERY_ISOLATION: 'false' })
    expect(applyQueryIsolation(member('org-a'), 'Patient', 'GET', '?name=x')).toBe('?name=x')
  })

  it('injects a _tag filter in the tenant system for search queries when enabled', () => {
    applyEnv({ TENANT_QUERY_ISOLATION: 'true' })
    const result = applyQueryIsolation(member('org-a'), 'Patient', 'GET', '')
    expect(result.startsWith('?')).toBe(true)
    expect(tagFilters(result)).toEqual([`${ORG_TAG_SYSTEM}|org-a`])
  })

  it('appends to existing query string, keeping the client parameters', () => {
    applyEnv({ TENANT_QUERY_ISOLATION: 'true' })
    const result = applyQueryIsolation(member('org-a'), 'Observation', 'GET', '?status=active')
    const params = new URLSearchParams(result)
    expect(params.get('status')).toBe('active')
    expect(params.getAll('_tag')).toEqual([`${ORG_TAG_SYSTEM}|org-a`])
  })

  it('keeps a tag filter the client sent alongside the tenant one', () => {
    applyEnv({ TENANT_QUERY_ISOLATION: 'true' })
    const result = applyQueryIsolation(member('org-a'), 'Patient', 'GET', `?_tag=${encodeURIComponent(`${ORG_TAG_SYSTEM}|org-b`)}`)
    expect(tagFilters(result)).toEqual([`${ORG_TAG_SYSTEM}|org-b`, `${ORG_TAG_SYSTEM}|org-a`])
  })

  it('does not inject for direct reads (resource/id)', () => {
    applyEnv({ TENANT_QUERY_ISOLATION: 'true' })
    expect(applyQueryIsolation(member('org-a'), 'Patient/123', 'GET', '')).toBe('')
  })

  it('does not inject when user has no org', () => {
    applyEnv({ TENANT_QUERY_ISOLATION: 'true' })
    expect(applyQueryIsolation(NO_ORG, 'Patient', 'GET', '')).toBe('')
  })

  it('applies to POST _search', () => {
    applyEnv({ TENANT_QUERY_ISOLATION: 'true' })
    expect(tagFilters(applyQueryIsolation(member('org-b'), 'Patient/_search', 'POST', ''))).toEqual([`${ORG_TAG_SYSTEM}|org-b`])
  })
})

describe('enforceTenantIsolation', () => {
  it('resolves tenant and allows when everything matches', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce', TENANT_QUERY_ISOLATION: 'false' })
    const result = enforceTenantIsolation(makeServer({ organizationIds: ['org-a'] }), { organization: 'org-a' }, 'Patient', 'GET', '')
    expect(result.allowed).toBe(true)
    expect(result.tenant.organizationId).toBe('org-a')
    expect(result.modifiedQueryString).toBe('')
  })

  it('denies when org mismatch in enforce mode, with no query to forward', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce', TENANT_QUERY_ISOLATION: 'true' })
    const result = enforceTenantIsolation(makeServer({ organizationIds: ['org-a'] }), { organization: 'org-wrong' }, 'Patient', 'GET', '')
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
    expect(result.body?.error).toBe('tenant_access_denied')
    expect(result.modifiedQueryString).toBeUndefined()
  })

  it('denies a token without any organization on a restricted server', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce' })
    const result = enforceTenantIsolation(makeServer({ organizationIds: ['org-a'] }), { sub: 'user-1' }, 'Patient', 'GET', '')
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
  })

  it('combines routing + query isolation', () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce', TENANT_QUERY_ISOLATION: 'true' })
    const result = enforceTenantIsolation(makeServer({ organizationIds: ['org-a'] }), { organization: 'org-a' }, 'Patient', 'GET', '')
    expect(result.allowed).toBe(true)
    expect(tagFilters(result.modifiedQueryString ?? '')).toEqual([`${ORG_TAG_SYSTEM}|org-a`])
  })
})
