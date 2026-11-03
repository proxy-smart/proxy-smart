// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// The per-server FHIR MCP tools, called over MCP against a stubbed upstream; shared modules are spied, not mock.module'd, so other files keep them.
import { describe, it, expect, beforeEach, mock, afterAll, spyOn } from 'bun:test'
import { McpServer } from '@modelcontextprotocol/server'
import { fakeFetch, jsonResponse } from './helpers/fake-fetch'
import { connectMcpClient, toolJson, toolText, type McpTestClient } from './helpers/mcp-client'
import { consentPermit, makeConsentConfig } from './helpers/consent'

import * as consentModule from '../src/lib/consent'
import * as fhirCapModule from '../src/lib/fhir-capabilities'
import * as mcpConfigModule from '../src/lib/mcp-endpoint-config'
import * as clientConfigModule from '../src/lib/smart-client-config-cache'

spyOn(consentModule, 'checkConsentWithIal').mockImplementation(async (_token, serverName, _url, resourcePath, method) =>
  consentPermit(serverName, resourcePath, method))
spyOn(consentModule, 'getConsentConfig').mockImplementation(() => makeConsentConfig({ enabled: false, mode: 'disabled' }))

spyOn(fhirCapModule, 'getServerCapabilities').mockImplementation(async () => null)
spyOn(fhirCapModule, 'normalizeSearchParams').mockImplementation(() => ({
  originalParams: new URLSearchParams(),
  normalizedParams: new URLSearchParams(),
  strippedParams: [],
  strippedIncludes: [],
  resourceType: '',
  supported: true,
}))
spyOn(fhirCapModule, 'parseFhirPath').mockImplementation((path: string, method: string) => ({
  resourceType: path.split('/')[0],
  resourceId: path.split('/')[1] ?? null,
  compartmentType: null,
  hasSearchSemantics: method === 'GET' && !path.includes('/'),
  isSearchEndpoint: method === 'GET' && !path.includes('/'),
  isOperation: false,
  operationName: null,
  isHistory: false,
  isInstance: path.includes('/'),
}))
spyOn(fhirCapModule, 'isInteractionSupported').mockImplementation(() => true)

spyOn(clientConfigModule, 'getClientServerAccess').mockImplementation(async () => null)

spyOn(mcpConfigModule, 'isToolExposed').mockImplementation(() => true)
spyOn(mcpConfigModule, 'isResourceExposed').mockImplementation(() => true)
spyOn(mcpConfigModule, 'loadMcpEndpointConfig').mockImplementation(() => ({
  enabled: true, exposeResourcesAsTools: true, disabledTools: [],
  enabledTools: null, updatedAt: new Date().toISOString(),
}))

afterAll(() => { mock.restore() })

const MCP_AUD = `${process.env.BASE_URL || 'http://localhost:8445'}/fhir/hapi/mcp`

const adminClaims = (): Record<string, unknown> => ({
  aud: MCP_AUD,
  sub: 'test-user',
  azp: 'test-client',
  iss: 'http://localhost:8080/realms/proxy-smart',
  realm_access: { roles: ['admin'] },
  resource_access: {},
  scope: 'openid user/Patient.read user/Patient.write user/Observation.read',
})

const mockValidateToken = mock(async (_token: string): Promise<Record<string, unknown>> => adminClaims())

mock.module('../src/lib/auth', () => ({
  validateToken: mockValidateToken,
}))

const fhirJson = (body: unknown, status = 200) => jsonResponse(body, status, 'application/fhir+json')
const PATIENT = { resourceType: 'Patient', id: '123', name: [{ family: 'Test' }] }

const mockFetch = mock(async (_url: string, _init?: RequestInit) => fhirJson(PATIENT))

/** The upstream call made with this method; access checks may look the record up first. */
function upstreamCall(method: string): [string, RequestInit?] | undefined {
  return mockFetch.mock.calls.find(([, init]) => init?.method === method)
}

function firstUpstreamUrl(): string {
  const [first] = mockFetch.mock.calls
  if (!first) throw new Error('nothing reached upstream')
  return first[0]
}

globalThis.fetch = fakeFetch(mockFetch)

const realStore = await import('../src/lib/fhir-server-store')
mock.module('../src/lib/fhir-server-store', () => ({
  ...realStore,
  getAllServers: async () => [
    { identifier: 'hapi', name: 'HAPI FHIR', url: 'http://localhost:8081/fhir' },
  ],
  getServerInfoByName: async (name: string) => {
    if (name === 'hapi' || !name) {
      return {
        identifier: 'hapi',
        name: 'HAPI FHIR',
        url: 'http://localhost:8081/fhir',
        strictCapabilities: false,
        metadata: { fhirVersion: 'R4' },
      }
    }
    return null
  },
  fhirServerStore: { getAllServers: () => [] },
}))

process.env.SCOPE_ENFORCEMENT_MODE = 'disabled'
process.env.ROLE_BASED_FILTERING_MODE = 'disabled'

mock.module('../src/lib/fhir-proxy-metrics-logger', () => ({
  fhirProxyMetricsLogger: {
    logRequest: () => Promise.resolve(),
  },
}))

process.env.KEYCLOAK_BASE_URL = 'http://localhost:8080'
process.env.KEYCLOAK_PUBLIC_URL = 'http://localhost:8080'
process.env.KEYCLOAK_REALM = 'proxy-smart'

const { registerFhirToolsForServer } = await import('../src/lib/ai/fhir-tools')

const tokenRef = { current: 'valid-test-token' }

/** The tools registered for the hapi server, reached through an MCP client. */
async function fhirTools(ref: { current?: string } = tokenRef): Promise<McpTestClient> {
  const server = new McpServer({ name: 'fhir-tools-test', version: '0.0.0' })
  registerFhirToolsForServer(server, ref, 'hapi')
  return connectMcpClient(server)
}

describe('FHIR MCP Tools', () => {
  beforeEach(() => {
    process.env.SCOPE_ENFORCEMENT_MODE = 'disabled'
    process.env.ROLE_BASED_FILTERING_MODE = 'disabled'

    mockValidateToken.mockClear()
    mockFetch.mockClear()
    mockValidateToken.mockImplementation(async () => adminClaims())
    mockFetch.mockImplementation(async () => fhirJson(PATIENT))
  })

  describe('registerFhirToolsForServer', () => {
    it('registers all 6 FHIR tools', async () => {
      const names = (await (await fhirTools()).listTools()).map((t) => t.name)
      expect(names.sort()).toEqual(['fhir_capabilities', 'fhir_create', 'fhir_delete', 'fhir_read', 'fhir_search', 'fhir_update'])
    })

    it('marks read-only tools with readOnlyHint annotation', async () => {
      const tools = await (await fhirTools()).listTools()
      const annotations = (name: string) => tools.find((t) => t.name === name)?.annotations

      expect(annotations('fhir_read')).toEqual({ readOnlyHint: true, idempotentHint: true })
      expect(annotations('fhir_search')).toEqual({ readOnlyHint: true, idempotentHint: true })
      expect(annotations('fhir_create')).toBeUndefined()
    })
  })

  describe('fhir_read', () => {
    it('reads a Patient by ID', async () => {
      const result = await (await fhirTools()).callTool('fhir_read', { resourceType: 'Patient', id: '123' })
      expect(result.isError ?? false).toBe(false)

      expect(toolJson(result)).toMatchObject({ resourceType: 'Patient', id: '123' })
      expect(firstUpstreamUrl()).toContain('/Patient/123')
    })

    it('returns error when no auth token', async () => {
      const result = await (await fhirTools({})).callTool('fhir_read', { resourceType: 'Patient', id: '123' })
      expect(result.isError).toBe(true)
      expect(toolText(result)).toContain('Authentication required')
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('fhir_search', () => {
    it('searches for Observations with query params', async () => {
      mockFetch.mockImplementation(async () => fhirJson({
        resourceType: 'Bundle',
        type: 'searchset',
        total: 2,
        entry: [
          { resource: { resourceType: 'Observation', id: '1' } },
          { resource: { resourceType: 'Observation', id: '2' } },
        ],
      }))

      const result = await (await fhirTools()).callTool('fhir_search', {
        resourceType: 'Observation',
        queryParams: 'patient=Patient/123&code=http://loinc.org|8867-4',
      })
      expect(result.isError ?? false).toBe(false)

      expect(toolJson(result)).toMatchObject({ resourceType: 'Bundle', total: 2 })
      expect(firstUpstreamUrl()).toContain('/Observation')
      expect(firstUpstreamUrl()).toContain('patient=Patient')
    })

    it('searches without query params', async () => {
      mockFetch.mockImplementation(async () => fhirJson({ resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] }))

      const result = await (await fhirTools()).callTool('fhir_search', { resourceType: 'Patient' })
      expect(result.isError ?? false).toBe(false)
    })
  })

  describe('fhir_create', () => {
    it('creates a new Observation', async () => {
      mockFetch.mockImplementation(async () => fhirJson({ resourceType: 'Observation', id: 'new-1', status: 'final' }, 201))

      const result = await (await fhirTools()).callTool('fhir_create', {
        resourceType: 'Observation',
        resource: {
          resourceType: 'Observation',
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
          subject: { reference: 'Patient/123' },
        },
      })
      expect(result.isError ?? false).toBe(false)
      expect(upstreamCall('POST')?.[0]).toContain('/Observation')
    })
  })

  describe('fhir_update', () => {
    it('updates an existing Patient', async () => {
      mockFetch.mockImplementation(async () => fhirJson({ resourceType: 'Patient', id: '123', name: [{ family: 'Updated' }] }))

      const result = await (await fhirTools()).callTool('fhir_update', {
        resourceType: 'Patient',
        id: '123',
        resource: { resourceType: 'Patient', id: '123', name: [{ family: 'Updated' }] },
      })
      expect(result.isError ?? false).toBe(false)
      expect(upstreamCall('PUT')?.[0]).toContain('/Patient/123')
    })
  })

  describe('fhir_delete', () => {
    it('deletes a resource', async () => {
      mockFetch.mockImplementation(async () =>
        fhirJson({ resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'deleted' }] }))

      const result = await (await fhirTools()).callTool('fhir_delete', { resourceType: 'Patient', id: '123' })
      expect(result.isError ?? false).toBe(false)
      expect(upstreamCall('DELETE')?.[0]).toContain('/Patient/123')
    })
  })

  describe('fhir_capabilities', () => {
    it('returns CapabilityStatement', async () => {
      mockFetch.mockImplementation(async () => fhirJson({
        resourceType: 'CapabilityStatement',
        status: 'active',
        fhirVersion: '4.0.1',
        rest: [{ mode: 'server', resource: [{ type: 'Patient' }] }],
      }))

      const result = await (await fhirTools()).callTool('fhir_capabilities')
      expect(result.isError ?? false).toBe(false)
      expect(toolJson(result).resourceType).toBe('CapabilityStatement')
    })
  })

  describe('server resolution', () => {
    it('uses the hardcoded server name', async () => {
      await (await fhirTools()).callTool('fhir_read', { resourceType: 'Patient', id: '123' })
      expect(firstUpstreamUrl()).toStartWith('http://localhost:8081/fhir/')
    })
  })

  describe('error handling', () => {
    it('reports upstream 404 as error', async () => {
      mockFetch.mockImplementation(async () =>
        fhirJson({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] }, 404))

      const result = await (await fhirTools()).callTool('fhir_read', { resourceType: 'Patient', id: '999' })
      expect(result.isError).toBe(true)
    })
  })

  describe('access control', () => {
    it.serial('runs writes through the proxy pipeline, so a patient-scoped grant stays in its compartment', async () => {
      process.env.SCOPE_ENFORCEMENT_MODE = 'enforce'
      process.env.ROLE_BASED_FILTERING_MODE = 'enforce'
      try {
        mockValidateToken.mockImplementation(async () => ({
          aud: MCP_AUD,
          sub: 'test-user',
          azp: 'test-client',
          iss: 'http://localhost:8080/realms/proxy-smart',
          scope: 'openid patient/Observation.c',
          patient: 'p1',
        }))
        const tools = await fhirTools()

        const result = await tools.callTool('fhir_create', {
          resourceType: 'Observation',
          resource: { resourceType: 'Observation', status: 'final', subject: { reference: 'Patient/p2' } },
        })
        expect(result.isError).toBe(true)
        expect(toolText(result)).toContain('Patient/p1')
        expect(upstreamCall('POST')).toBeUndefined()

        const own = await tools.callTool('fhir_create', {
          resourceType: 'Observation',
          resource: { resourceType: 'Observation', status: 'final', subject: { reference: 'Patient/p1' } },
        })
        expect(own.isError ?? false).toBe(false)
        expect(upstreamCall('POST')).toBeDefined()
      } finally {
        process.env.SCOPE_ENFORCEMENT_MODE = 'disabled'
        process.env.ROLE_BASED_FILTERING_MODE = 'disabled'
      }
    })

    it.serial('refuses a token issued for another server before anything reaches upstream', async () => {
      process.env.FHIR_AUDIENCE_ENFORCEMENT = 'enforce'
      try {
        for (const aud of [MCP_AUD.replace('/hapi/', '/other/'), 'http://localhost:8445/proxy-smart-backend/other/R4']) {
          mockFetch.mockClear()
          mockValidateToken.mockImplementation(async () => ({ aud, sub: 'test-user', azp: 'test-client', scope: 'openid user/Patient.read' }))
          const result = await (await fhirTools()).callTool('fhir_read', { resourceType: 'Patient', id: '123' })
          expect(result.isError).toBe(true)
          expect(toolText(result)).toContain('invalid_token')
          expect(mockFetch).not.toHaveBeenCalled()
        }
      } finally {
        delete process.env.FHIR_AUDIENCE_ENFORCEMENT
      }
    })

    it.serial('admits a token issued for the FHIR base of this server', async () => {
      mockValidateToken.mockImplementation(async () => ({ aud: 'http://localhost:8081/fhir', sub: 'test-user', azp: 'test-client', scope: 'openid user/Patient.read' }))
      const result = await (await fhirTools()).callTool('fhir_read', { resourceType: 'Patient', id: '123' })
      expect(result.isError ?? false).toBe(false)
    })
  })
})
