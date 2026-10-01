// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { extractBearerToken } from '@/lib/admin-utils'
import { validateToken } from '@/lib/auth'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import { logger } from '@/lib/logger'
import { upstreamAuthHeader } from '@/lib/http-auth'
import {
  getRuntimeDicomServers,
  saveDicomServers,
  getDicomViewerAppClientId,
  saveDicomViewerApp,
} from '@/lib/runtime-config'
import {
  DicomServerConfig,
  DicomServerListResponse,
  DicomServerStatusResponse,
  DicomServerIdParam,
  AddDicomServerRequest,
  UpdateDicomServerRequest,
  type DicomServerConfigType,
} from '@/schemas'
import { ErrorResponse } from '@/schemas'

/** Generate a URL-safe slug ID from a name */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || `dicom-${Date.now()}`
}

/** Probe a DICOM server for reachability */
async function probeDicomServer(server: DicomServerConfigType): Promise<{
  configured: boolean
  reachable: boolean | null
  message: string
}> {
  const base = server.baseUrl.replace(/\/+$/, '')
  const headers = new Headers()
  const auth = upstreamAuthHeader(server)
  if (auth) headers.set('authorization', auth)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)

  try {
    const resp = await fetch(`${base}/studies?limit=1`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    return {
      configured: true,
      reachable: resp.ok || resp.status === 401,
      message: resp.ok ? 'PACS is available' : `PACS responded with HTTP ${resp.status}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return {
      configured: true,
      reachable: false,
      message: `Cannot reach PACS: ${msg.includes('ECONNREFUSED') || msg.includes('fetch failed') ? 'Connection refused' : msg}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Admin routes for DICOM server management.
 * Stores server configs in Keycloak realm attributes.
 */
export const dicomServersAdminRoutes = new Elysia({ prefix: '/dicom-servers', tags: ['admin'] })
  .use(keycloakPlugin)

  // ── List all DICOM servers ──────────────────────────────────────────
  .get('/', async () => {
    const servers = getRuntimeDicomServers()
    return { totalServers: servers.length, servers }
  }, {
    response: { 200: DicomServerListResponse },
    detail: {
      summary: 'List DICOM Servers',
      description: 'List all configured DICOMweb/PACS servers',
      tags: ['admin'],
    },
  })

  // ── Get single DICOM server ─────────────────────────────────────────
  .get('/:server_id', async ({ params, set }) => {
    const servers = getRuntimeDicomServers()
    const server = servers.find(s => s.id === params.server_id)
    if (!server) {
      set.status = 404
      return { error: `DICOM server '${params.server_id}' not found` }
    }
    return server
  }, {
    params: DicomServerIdParam,
    response: { 200: DicomServerConfig, 404: ErrorResponse },
    detail: {
      summary: 'Get DICOM Server',
      description: 'Get a specific DICOM server configuration',
      tags: ['admin'],
    },
  })

  // ── Add a DICOM server ──────────────────────────────────────────────
  .post('/', async ({ body, set, headers, getAdmin }) => {
    try {
      const token = extractBearerToken(headers)
      await validateToken(token!)

      // Validate URL
      try { new URL(body.baseUrl) } catch {
        set.status = 400
        return { error: 'Invalid base URL' }
      }

      const servers = [...getRuntimeDicomServers()]
      const id = slugify(body.name)

      if (servers.some(s => s.id === id)) {
        set.status = 409
        return { error: `DICOM server with id '${id}' already exists` }
      }

      const newServer: DicomServerConfigType = {
        id,
        name: body.name,
        baseUrl: body.baseUrl,
        wadoRoot: body.wadoRoot,
        qidoRoot: body.qidoRoot,
        authType: body.authType ?? 'none',
        authHeader: body.authHeader,
        username: body.username,
        password: body.password,
        timeoutMs: body.timeoutMs ?? 30000,
        isDefault: body.isDefault ?? servers.length === 0, // first server is default
      }

      // If new server is default, unset others
      if (newServer.isDefault) {
        for (const s of servers) s.isDefault = false
      }

      servers.push(newServer)

      const admin = await getAdmin(token!)
      await saveDicomServers(admin, servers)

      set.status = 201
      return { success: true, message: 'DICOM server added', server: newServer }
    } catch (err) {
      logger.admin.error('Failed to add DICOM server', { error: err })
      set.status = 500
      return { error: 'Failed to add DICOM server', details: err instanceof Error ? err.message : 'Unknown error' }
    }
  }, {
    body: AddDicomServerRequest,
    detail: {
      summary: 'Add DICOM Server',
      description: 'Add a new DICOMweb/PACS server',
      tags: ['admin'],
    },
  })

  // ── Update a DICOM server ───────────────────────────────────────────
  .put('/:server_id', async ({ params, body, set, headers, getAdmin }) => {
    try {
      const token = extractBearerToken(headers)
      await validateToken(token!)

      const servers = [...getRuntimeDicomServers()]
      const idx = servers.findIndex(s => s.id === params.server_id)
      if (idx === -1) {
        set.status = 404
        return { error: `DICOM server '${params.server_id}' not found` }
      }

      if (body.baseUrl) {
        try { new URL(body.baseUrl) } catch {
          set.status = 400
          return { error: 'Invalid base URL' }
        }
      }

      const updated = { ...servers[idx], ...body }

      // If marking as default, unset others
      if (body.isDefault) {
        for (const s of servers) s.isDefault = false
      }
      servers[idx] = updated

      const admin = await getAdmin(token!)
      await saveDicomServers(admin, servers)

      return { success: true, message: 'DICOM server updated', server: updated }
    } catch (err) {
      logger.admin.error('Failed to update DICOM server', { error: err })
      set.status = 500
      return { error: 'Failed to update DICOM server', details: err instanceof Error ? err.message : 'Unknown error' }
    }
  }, {
    params: DicomServerIdParam,
    body: UpdateDicomServerRequest,
    detail: {
      summary: 'Update DICOM Server',
      description: 'Update an existing DICOM server configuration',
      tags: ['admin'],
    },
  })

  // ── Delete a DICOM server ───────────────────────────────────────────
  .delete('/:server_id', async ({ params, set, headers, getAdmin }) => {
    try {
      const token = extractBearerToken(headers)
      await validateToken(token!)

      const servers = getRuntimeDicomServers()
      const filtered = servers.filter(s => s.id !== params.server_id)
      if (filtered.length === servers.length) {
        set.status = 404
        return { error: `DICOM server '${params.server_id}' not found` }
      }

      // If deleted server was default and others remain, make first one default
      if (filtered.length > 0 && !filtered.some(s => s.isDefault)) {
        filtered[0].isDefault = true
      }

      const admin = await getAdmin(token!)
      await saveDicomServers(admin, filtered)

      return { success: true, message: `DICOM server '${params.server_id}' deleted` }
    } catch (err) {
      logger.admin.error('Failed to delete DICOM server', { error: err })
      set.status = 500
      return { error: 'Failed to delete DICOM server', details: err instanceof Error ? err.message : 'Unknown error' }
    }
  }, {
    params: DicomServerIdParam,
    detail: {
      summary: 'Delete DICOM Server',
      description: 'Remove a DICOM server configuration',
      tags: ['admin'],
    },
  })

  // ── Probe a DICOM server status ─────────────────────────────────────
  .get('/:server_id/status', async ({ params, set }) => {
    const servers = getRuntimeDicomServers()
    const server = servers.find(s => s.id === params.server_id)
    if (!server) {
      set.status = 404
      return { error: `DICOM server '${params.server_id}' not found` }
    }

    const status = await probeDicomServer(server)
    return { id: server.id, name: server.name, ...status }
  }, {
    params: DicomServerIdParam,
    response: { 200: DicomServerStatusResponse, 404: ErrorResponse },
    detail: {
      summary: 'DICOM Server Status',
      description: 'Probe a DICOM server for reachability',
      tags: ['admin'],
    },
  })

  // ── Get DICOM viewer app setting ────────────────────────────────────
  .get('/viewer-app', async () => {
    const clientId = getDicomViewerAppClientId()
    return { viewerAppClientId: clientId }
  }, {
    response: {
      200: t.Object({ viewerAppClientId: t.Union([t.String(), t.Null()]) }),
    },
    detail: {
      summary: 'Get DICOM Viewer App',
      description: 'Get the globally configured SMART app used as DICOM viewer',
      tags: ['admin'],
    },
  })

  // ── Set DICOM viewer app setting ────────────────────────────────────
  .put('/viewer-app', async ({ body, set, headers, getAdmin }) => {
    try {
      const token = extractBearerToken(headers)
      await validateToken(token!)
      const admin = await getAdmin(token!)
      await saveDicomViewerApp(admin, body.viewerAppClientId || null)
      return { success: true, message: 'DICOM viewer app updated', viewerAppClientId: body.viewerAppClientId || null }
    } catch (err) {
      logger.admin.error('Failed to update DICOM viewer app', { error: err })
      set.status = 500
      return { error: 'Failed to update DICOM viewer app', details: err instanceof Error ? err.message : 'Unknown error' }
    }
  }, {
    body: t.Object({
      viewerAppClientId: t.Optional(t.Union([t.String(), t.Null()], { description: 'Client ID of the SMART app to use as DICOM viewer, or null to clear' })),
    }),
    detail: {
      summary: 'Set DICOM Viewer App',
      description: 'Set the globally configured SMART app used as DICOM viewer',
      tags: ['admin'],
    },
  })
