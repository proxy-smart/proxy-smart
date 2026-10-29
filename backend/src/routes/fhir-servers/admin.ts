// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import {
  addServer,
  updateServer,
  getServerInfoByName,
  deleteServer,
  refreshServer,
  setStrictCapabilities,
  setMcpEnabled,
} from '@/lib/fhir-server-store'
import { logger } from '@/lib/logger'
import { validateAdminToken } from '@/lib/auth'
import { extractBearerToken } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'
import {
  FhirServerResponse,
  AddFhirServerRequest,
  UpdateFhirServerRequest,
  ServerIdParam,
  CommonErrorResponses,
} from '@/schemas'
import { fhirServersMtlsRoutes } from './admin-mtls'
import { fhirServerView, metadataFailure, serverUrlRejection } from './server-view'

/**
 * FHIR server administration — mounted INSIDE `adminRoutes`, so it serves /admin/fhir-servers.
 *
 * Registering a server, repointing one, uploading mTLS client certificates and deleting
 * servers all sat behind a bare `validateToken`, whose default audience set matches the proxy
 * FHIR base — the audience every SMART app token carries. Any signed-in end user satisfied it.
 * Under `adminRoutes` they inherit `adminAuthGuard`, which demands an admin-audienced token
 * AND admin roles before a handler runs, plus the admin audit log.
 */
export const fhirServersAdminRoutes = new Elysia({ prefix: '/fhir-servers', tags: ['fhir-servers'] })
  // Create a new FHIR server
  .post('/', async ({ body, set, headers }) => {
    try {
      // Require authentication for server management
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }

      await validateAdminToken(auth)

      const rejection = serverUrlRejection(body.url)
      if (rejection) {
        set.status = 400
        return { error: rejection }
      }

      // Add the server to the store (this will test connectivity)
      const serverInfo = await addServer(body.url, body.name, body.organizationIds)

      return {
        success: true,
        message: 'FHIR server added successfully',
        server: fhirServerView(serverInfo),
      }
    } catch (error) {
      logger.fhir.error('Failed to add FHIR server', { error, body })
      const failure = metadataFailure(error)
      if (failure) {
        set.status = 400
        return failure
      }

      return handleAdminError(error, set)
    }
  }, {
    body: AddFhirServerRequest,
    response: {
      200: t.Object({
        success: t.Boolean({ description: 'Whether the server was added successfully' }),
        message: t.String({ description: 'Success message' }),
        server: FhirServerResponse
      }, { title: 'AddFhirServerResponse' }),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Add New FHIR Server',
      description: 'Add a new FHIR server to the system by providing its base URL',
      tags: ['servers'],
      security: [{ BearerAuth: [] }]
    }
  })
  // Update an existing FHIR server
  .put('/:server_id', async ({ params, body, set, headers }) => {
    try {
      // Require authentication for server management
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }

      await validateAdminToken(auth)

      if (!(await getServerInfoByName(params.server_id))) {
        set.status = 404
        return { error: `FHIR server '${params.server_id}' not found` }
      }

      const rejection = serverUrlRejection(body.url)
      if (rejection) {
        set.status = 400
        return { error: rejection }
      }

      const serverInfo = await updateServer(params.server_id, body.url, body.name, body.organizationIds)

      return {
        success: true,
        message: 'FHIR server updated successfully',
        server: fhirServerView(serverInfo),
      }
    } catch (error) {
      logger.fhir.error('Failed to update FHIR server', { error, params, body })
      const failure = metadataFailure(error)
      if (failure) {
        set.status = 400
        return failure
      }

      return handleAdminError(error, set)
    }
  }, {
    params: ServerIdParam,
    body: UpdateFhirServerRequest,
    response: {
      200: t.Object({
        success: t.Boolean({ description: 'Whether the server was updated successfully' }),
        message: t.String({ description: 'Success message' }),
        server: FhirServerResponse
      }, { title: 'UpdateFhirServerResponse' }),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Update FHIR Server',
      description: 'Update an existing FHIR server by providing its new base URL',
      tags: ['servers'],
      security: [{ BearerAuth: [] }]
    }
  })
  .use(fhirServersMtlsRoutes)
  // Toggle strict capability enforcement for a server
  .patch('/:server_id/strict-capabilities', async ({ params, body, set, headers }) => {
    try {
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }

      await validateAdminToken(auth)

      const updated = await setStrictCapabilities(params.server_id, body.strict)

      return {
        success: true,
        message: `Strict capability enforcement ${body.strict ? 'enabled' : 'disabled'} for server '${params.server_id}'`,
        strictCapabilities: updated.strictCapabilities ?? false
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        set.status = 404
        return { error: error.message }
      }
      logger.fhir.error('Failed to update strict capabilities', { error, serverId: params.server_id })
      return handleAdminError(error, set)
    }
  }, {
    params: ServerIdParam,
    body: t.Object({
      strict: t.Boolean({ description: 'Whether to enforce the FHIR CapabilityStatement strictly' })
    }, { title: 'SetStrictCapabilitiesRequest' }),
    response: {
      200: t.Object({
        success: t.Boolean(),
        message: t.String(),
        strictCapabilities: t.Boolean()
      }, { title: 'SetStrictCapabilitiesResponse' }),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Toggle Strict Capability Enforcement',
      description: 'Enable or disable strict CapabilityStatement enforcement on the FHIR proxy for this server. When strict, the proxy rejects requests for interactions/operations not declared in the server\'s CapabilityStatement.',
      tags: ['servers'],
      security: [{ BearerAuth: [] }]
    }
  })
  // Toggle MCP endpoint for a server
  .patch('/:server_id/mcp', async ({ params, body, set, headers }) => {
    try {
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }

      await validateAdminToken(auth)

      const updated = await setMcpEnabled(params.server_id, body.enabled)

      return {
        success: true,
        message: `MCP endpoint ${body.enabled ? 'enabled' : 'disabled'} for server '${params.server_id}'`,
        mcpEnabled: updated.mcpEnabled ?? false
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        set.status = 404
        return { error: error.message }
      }
      logger.fhir.error('Failed to update MCP setting', { error, serverId: params.server_id })
      return handleAdminError(error, set)
    }
  }, {
    params: ServerIdParam,
    body: t.Object({
      enabled: t.Boolean({ description: 'Whether to enable the deprecated per-server MCP endpoint' })
    }, { title: 'SetMcpEnabledRequest' }),
    response: {
      200: t.Object({
        success: t.Boolean(),
        message: t.String(),
        mcpEnabled: t.Boolean()
      }, { title: 'SetMcpEnabledResponse' }),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Toggle MCP Endpoint (deprecated)',
      description: 'Enable or disable the per-server MCP endpoint at /fhir/{server_id}/mcp. Deprecated: the endpoint is removed in 0.8.0 (sunset 2027-01-31); serve FHIR tools to agents from a FHIR MCP server instead.',
      deprecated: true,
      tags: ['servers'],
      security: [{ BearerAuth: [] }]
    }
  })
  // Delete a FHIR server
  .delete('/:server_id', async ({ params, set, headers }) => {
    try {
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }

      await validateAdminToken(auth)

      await deleteServer(params.server_id)

      return {
        success: true,
        message: `FHIR server '${params.server_id}' deleted successfully`,
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        set.status = 404
        return { error: error.message }
      }
      logger.fhir.error('Failed to delete FHIR server', { error, serverId: params.server_id })
      return handleAdminError(error, set)
    }
  }, {
    params: ServerIdParam,
    response: {
      200: t.Object({
        success: t.Boolean({ description: 'Whether the server was deleted successfully' }),
        message: t.String({ description: 'Success message' }),
      }, { title: 'DeleteFhirServerResponse' }),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Delete FHIR Server',
      description: 'Remove a FHIR server from the system. This does not delete any patient data on the FHIR server itself.',
      tags: ['servers'],
      security: [{ BearerAuth: [] }]
    }
  })
  // Refresh metadata for a FHIR server (re-fetch from origin)
  .post('/:server_id/refresh', async ({ params, set, headers }) => {
    try {
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }

      await validateAdminToken(auth)

      const updated = await refreshServer(params.server_id)

      return {
        success: true,
        message: `Server metadata refreshed successfully`,
        server: {
          id: updated.identifier,
          name: updated.name,
          url: updated.url,
          fhirVersion: updated.metadata.fhirVersion,
          serverName: updated.metadata.serverName || 'Unknown FHIR Server',
          supported: updated.metadata.supported,
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        set.status = 404
        return { error: error.message }
      }
      logger.fhir.error('Failed to refresh FHIR server metadata', { error, serverId: params.server_id })
      return handleAdminError(error, set)
    }
  }, {
    params: ServerIdParam,
    response: {
      200: t.Object({
        success: t.Boolean(),
        message: t.String(),
        server: t.Object({
          id: t.String(),
          name: t.String(),
          url: t.String(),
          fhirVersion: t.String(),
          serverName: t.String(),
          supported: t.Boolean(),
        }),
      }, { title: 'RefreshFhirServerResponse' }),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Refresh FHIR Server Metadata',
      description: 'Re-fetch the CapabilityStatement from the FHIR server to update metadata like server name, version, and connection status.',
      tags: ['servers'],
      security: [{ BearerAuth: [] }]
    }
  })
