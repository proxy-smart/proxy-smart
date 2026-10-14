// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { getServerInfoByName, ensureServersInitialized, getAllServers } from '../lib/fhir-server-store'
import { getServerCapabilities, serializeCapabilities, clearCapabilitiesCache, getCapabilitiesCacheStats } from '../lib/fhir-capabilities'
import { validateToken } from '../lib/auth'
import { extractBearerToken } from '../lib/admin-utils'
import { CommonErrorResponses } from '../schemas'
import { logger } from '../lib/logger'

/**
 * Admin API for introspecting FHIR server capabilities.
 * Exposes the parsed CapabilityStatement data that the proxy uses
 * to normalize search parameters before forwarding requests.
 */
export const fhirCapabilitiesRoutes = new Elysia({ prefix: '/admin/capabilities', tags: ['fhir-capabilities'] })

  // List capabilities for all servers
  .get('/', async ({ set, headers }) => {
    try {
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }
      await validateToken(auth)
      await ensureServersInitialized()

      const servers = await getAllServers()
      const results: Record<string, ReturnType<typeof serializeCapabilities> | { error: string }> = {}

      for (const server of servers) {
        const caps = await getServerCapabilities(server.url, server.identifier)
        if (caps) {
          results[server.identifier] = serializeCapabilities(caps)
        } else {
          results[server.identifier] = { error: 'CapabilityStatement not available' }
        }
      }

      return { servers: results, cache: getCapabilitiesCacheStats() }
    } catch (error) {
      logger.fhir.error('Failed to list capabilities', { error })
      set.status = 500
      return { error: 'Failed to list capabilities' }
    }
  }, {
    response: { 200: t.Any(), ...CommonErrorResponses },
    detail: {
      summary: 'List All Server Capabilities',
      description: 'Get parsed CapabilityStatement data for all configured FHIR servers',
      tags: ['fhir-capabilities'],
      security: [{ BearerAuth: [] }],
    },
  })

  // Get capabilities for a specific server
  .get('/:server_id', async ({ params, set, headers }) => {
    try {
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }
      await validateToken(auth)
      await ensureServersInitialized()

      const serverInfo = await getServerInfoByName(params.server_id)
      if (!serverInfo) {
        set.status = 404
        return { error: `FHIR server '${params.server_id}' not found` }
      }

      const caps = await getServerCapabilities(serverInfo.url, serverInfo.identifier)
      if (!caps) {
        set.status = 503
        return { error: 'CapabilityStatement not available for this server' }
      }

      return serializeCapabilities(caps)
    } catch (error) {
      logger.fhir.error('Failed to get capabilities', { error, serverId: params.server_id })
      set.status = 500
      return { error: 'Failed to get capabilities' }
    }
  }, {
    params: t.Object({ server_id: t.String({ description: 'FHIR server identifier' }) }),
    response: { 200: t.Any(), ...CommonErrorResponses },
    detail: {
      summary: 'Get Server Capabilities',
      description: 'Get parsed CapabilityStatement for a specific FHIR server, including supported resources, search params, and interactions',
      tags: ['fhir-capabilities'],
      security: [{ BearerAuth: [] }],
    },
  })

  // Get capabilities for a specific resource type on a specific server
  .get('/:server_id/:resource_type', async ({ params, set, headers }) => {
    try {
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }
      await validateToken(auth)
      await ensureServersInitialized()

      const serverInfo = await getServerInfoByName(params.server_id)
      if (!serverInfo) {
        set.status = 404
        return { error: `FHIR server '${params.server_id}' not found` }
      }

      const caps = await getServerCapabilities(serverInfo.url, serverInfo.identifier)
      if (!caps) {
        set.status = 503
        return { error: 'CapabilityStatement not available for this server' }
      }

      const resourceCap = caps.resources.get(params.resource_type)
      if (!resourceCap) {
        set.status = 404
        return {
          error: `Resource type '${params.resource_type}' not found in CapabilityStatement`,
          availableResources: [...caps.resources.keys()].sort(),
        }
      }

      return {
        type: resourceCap.type,
        interactions: [...resourceCap.interactions],
        searchParams: Object.fromEntries(resourceCap.searchParams),
        searchInclude: [...resourceCap.searchInclude],
        searchRevInclude: [...resourceCap.searchRevInclude],
        operations: [...resourceCap.operations],
      }
    } catch (error) {
      logger.fhir.error('Failed to get resource capabilities', { error, serverId: params.server_id, resourceType: params.resource_type })
      set.status = 500
      return { error: 'Failed to get resource capabilities' }
    }
  }, {
    params: t.Object({
      server_id: t.String({ description: 'FHIR server identifier' }),
      resource_type: t.String({ description: 'FHIR resource type (e.g., Patient, Observation)' }),
    }),
    response: { 200: t.Any(), ...CommonErrorResponses },
    detail: {
      summary: 'Get Resource Type Capabilities',
      description: 'Get supported interactions, search parameters, includes, and operations for a specific resource type on a FHIR server',
      tags: ['fhir-capabilities'],
      security: [{ BearerAuth: [] }],
    },
  })

  // Refresh capabilities cache
  .post('/refresh', async ({ set, headers, query }) => {
    try {
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }
      await validateToken(auth)

      const serverId = query?.server_id
      clearCapabilitiesCache(serverId)

      // If a specific server was requested, eagerly re-fetch
      if (serverId) {
        await ensureServersInitialized()
        const serverInfo = await getServerInfoByName(serverId)
        if (serverInfo) {
          await getServerCapabilities(serverInfo.url, serverInfo.identifier, { force: true })
        }
      }

      return {
        success: true,
        message: serverId
          ? `Capabilities cache refreshed for ${serverId}`
          : 'Capabilities cache cleared for all servers',
      }
    } catch (error) {
      logger.fhir.error('Failed to refresh capabilities', { error })
      set.status = 500
      return { error: 'Failed to refresh capabilities cache' }
    }
  }, {
    query: t.Optional(t.Object({ server_id: t.Optional(t.String()) })),
    response: { 200: t.Any(), ...CommonErrorResponses },
    detail: {
      summary: 'Refresh Capabilities Cache',
      description: 'Clear and optionally re-fetch the CapabilityStatement cache for one or all servers',
      tags: ['fhir-capabilities'],
      security: [{ BearerAuth: [] }],
    },
  })
