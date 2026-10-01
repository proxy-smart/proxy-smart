// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { join } from 'path'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { validateToken } from '../lib/auth'
import { getFhirResourceAudiences } from '../lib/token-audience'
import { AuthenticationError, ConfigurationError } from '../lib/admin-utils'
import { config } from '../config'
import { getDefaultDicomServer, getDicomServerById, getDicomViewerAppClientId } from '../lib/runtime-config'
import { getPublishedApps } from '../lib/app-store-config'
import type { DicomServerConfigType } from '../schemas'
import { logger } from '../lib/logger'
import { upstreamAuthHeader } from '../lib/http-auth'

/**
 * DICOMweb proxy routes
 * 
 * Proxies WADO-RS and QIDO-RS requests to an upstream DICOMweb-enabled PACS
 * (e.g. Orthanc, DCM4CHEE, Google Cloud Healthcare API).
 * 
 * Authentication: Validates the caller's SMART on FHIR bearer token before
 * forwarding. Optionally attaches upstream PACS credentials (Basic auth, etc.).
 * 
 * Route surface (mirrors the DICOMweb standard):
 * 
 * QIDO-RS (query):
 *   GET /dicomweb/studies
 *   GET /dicomweb/studies/:studyUID/series
 *   GET /dicomweb/studies/:studyUID/series/:seriesUID/instances
 * 
 * WADO-RS (retrieve):
 *   GET /dicomweb/studies/:studyUID
 *   GET /dicomweb/studies/:studyUID/metadata
 *   GET /dicomweb/studies/:studyUID/series/:seriesUID
 *   GET /dicomweb/studies/:studyUID/series/:seriesUID/metadata
 *   GET /dicomweb/studies/:studyUID/series/:seriesUID/instances/:sopUID
 *   GET /dicomweb/studies/:studyUID/series/:seriesUID/instances/:sopUID/frames/:frame
 *   GET /dicomweb/studies/:studyUID/rendered
 *   GET /dicomweb/studies/:studyUID/series/:seriesUID/rendered
 *   GET /dicomweb/studies/:studyUID/series/:seriesUID/instances/:sopUID/rendered
 *   GET /dicomweb/studies/:studyUID/thumbnail
 *   GET /dicomweb/studies/:studyUID/series/:seriesUID/thumbnail
 *   GET /dicomweb/studies/:studyUID/series/:seriesUID/instances/:sopUID/thumbnail
 */

// UID format: DICOM UIDs are dot-separated numeric strings (1.2.840.10008...)
const UidParam = t.String({ pattern: '^[0-9.]+$', description: 'DICOM UID (dot-separated numeric)' })

function pacsAuthHeader(server: DicomServerConfigType | null | undefined): string | null {
  return server ? upstreamAuthHeader(server) : config.dicomweb.upstreamAuth
}

/** Build upstream URL from the DICOMweb base and the incoming sub-path + query string */
function buildUpstreamUrl(subPath: string, queryString: string, server?: DicomServerConfigType | null): string {
  const resolved = server ?? getDefaultDicomServer()
  const base = resolved?.baseUrl ?? config.dicomweb.baseUrl
  if (!base) throw new ConfigurationError('DICOMweb is not configured (no DICOM server or DICOMWEB_BASE_URL)')
  const normalizedBase = base.replace(/\/+$/, '')
  const path = subPath.startsWith('/') ? subPath : `/${subPath}`
  return `${normalizedBase}${path}${queryString}`
}

/** Forward a request to the upstream PACS and stream the response back */
async function proxyDicomWeb(request: Request, subPath: string, set: { status?: number | string; headers: Record<string, string | number | undefined> }, explicitServer?: DicomServerConfigType | null): Promise<Response | string | object> {
  const server = explicitServer ?? getDefaultDicomServer()
  if (!server && !config.dicomweb.enabled) {
    set.status = 501
    return { error: 'DICOMweb proxy is not configured', message: 'Add a DICOM server or set DICOMWEB_BASE_URL to enable DICOM imaging' }
  }

  // 1) Validate caller token
  const authHeader = request.headers.get('authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) {
    set.status = 401
    return { error: 'Authentication required' }
  }

  try {
    // DICOM imaging is a FHIR-resource-class endpoint: the SMART access token's
    // aud is the FHIR resource server base, not a client id.
    await validateToken(token, { audience: getFhirResourceAudiences() })
  } catch (err) {
    if (err instanceof AuthenticationError) {
      set.status = 401
      return { error: 'Authentication failed', details: { message: err.message } }
    }
    throw err
  }

  // 2) Build upstream URL
  const requestUrl = new URL(request.url)
  const target = buildUpstreamUrl(subPath, requestUrl.search, server)

  // 3) Build upstream headers
  const headers = new Headers()
  // Forward Accept so the PACS can honour content negotiation (e.g. multipart/related, image/jpeg)
  const accept = request.headers.get('accept')
  if (accept) headers.set('accept', accept)

  // Attach upstream PACS auth (runtime server config takes precedence)
  const upstreamAuth = pacsAuthHeader(server)
  if (upstreamAuth) {
    headers.set('authorization', upstreamAuth)
  }

  // 4) Fetch from upstream PACS
  const controller = new AbortController()
  const timeoutMs = server?.timeoutMs ?? config.dicomweb.timeoutMs
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    logger.fhir.debug('DICOMweb proxy →', { target, method: 'GET' })

    const resp = await fetch(target, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })

    // Return a raw Response to preserve the exact content-type from the PACS
    // (e.g. application/dicom+json, multipart/related).
    // Returning a plain JS object would let Elysia re-serialize with
    // application/json, breaking Cornerstone3D's WADO-RS metadata parser.
    const buffer = await resp.arrayBuffer()
    const responseHeaders = new Headers()
    for (const h of ['content-type', 'content-disposition', 'etag']) {
      const v = resp.headers.get(h)
      if (v) responseHeaders.set(h, v)
    }
    return new Response(buffer, {
      status: resp.status,
      headers: responseHeaders,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.fhir.error('DICOMweb upstream timeout', { target, timeoutMs })
      set.status = 504
      return { error: 'DICOMweb upstream timeout' }
    }
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    const isConnectionRefused = errMsg.includes('ECONNREFUSED') || errMsg.includes('fetch failed')
    logger.fhir.error('DICOMweb proxy error', { target, error: errMsg, isConnectionRefused })
    set.status = 502
    return {
      error: isConnectionRefused ? 'PACS server is not reachable' : 'DICOMweb upstream error',
      message: isConnectionRefused ? 'The imaging server (PACS) is not responding. It may be offline or not yet started.' : undefined,
      details: err instanceof Error ? { message: err.message } : undefined,
    }
  } finally {
    clearTimeout(timeout)
  }
}

/** Forward a POST (STOW-RS) request to the upstream PACS, streaming the body through */
async function proxyDicomWebPost(request: Request, subPath: string, set: { status?: number | string; headers: Record<string, string | number | undefined> }, explicitServer?: DicomServerConfigType | null): Promise<Response | string | object> {
  const server = explicitServer ?? getDefaultDicomServer()
  if (!server && !config.dicomweb.enabled) {
    set.status = 501
    return { error: 'DICOMweb proxy is not configured', message: 'Add a DICOM server or set DICOMWEB_BASE_URL to enable DICOM imaging' }
  }

  const authHeader = request.headers.get('authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) {
    set.status = 401
    return { error: 'Authentication required' }
  }

  try {
    // DICOM imaging is a FHIR-resource-class endpoint: the SMART access token's
    // aud is the FHIR resource server base, not a client id.
    await validateToken(token, { audience: getFhirResourceAudiences() })
  } catch (err) {
    if (err instanceof AuthenticationError) {
      set.status = 401
      return { error: 'Authentication failed', details: { message: err.message } }
    }
    throw err
  }

  const requestUrl = new URL(request.url)
  const target = buildUpstreamUrl(subPath, requestUrl.search, server)

  const headers = new Headers()
  // STOW-RS requires the Content-Type with boundary for multipart/related
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  const accept = request.headers.get('accept')
  if (accept) headers.set('accept', accept)
  const stowAuth = pacsAuthHeader(server)
  if (stowAuth) {
    headers.set('authorization', stowAuth)
  }

  const controller = new AbortController()
  // STOW-RS uploads can be large — use 5× the normal timeout
  const stowTimeoutMs = (server?.timeoutMs ?? config.dicomweb.timeoutMs) * 5
  const timeout = setTimeout(() => controller.abort(), stowTimeoutMs)

  try {
    logger.fhir.info('DICOMweb STOW-RS →', { target })

    const resp = await fetch(target, {
      method: 'POST',
      headers,
      body: request.body,
      signal: controller.signal,
      // @ts-expect-error duplex needed for streaming body in some runtimes
      duplex: 'half',
    })

    set.status = resp.status
    const passthroughHeaders = ['content-type', 'content-length', 'etag']
    for (const h of passthroughHeaders) {
      const v = resp.headers.get(h)
      if (v) set.headers = { ...set.headers, [h]: v }
    }

    const respContentType = resp.headers.get('content-type') || ''
    if (respContentType.includes('json') || respContentType.includes('xml')) {
      return new Response(await resp.text(), {
        status: resp.status,
        headers: { 'content-type': respContentType },
      })
    }

    const buffer = await resp.arrayBuffer()
    return new Response(buffer, {
      status: resp.status,
      headers: { 'content-type': respContentType },
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.fhir.error('DICOMweb STOW-RS timeout', { target })
      set.status = 504
      return { error: 'DICOMweb upstream timeout (STOW-RS)' }
    }
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    const isConnectionRefused = errMsg.includes('ECONNREFUSED') || errMsg.includes('fetch failed')
    logger.fhir.error('DICOMweb STOW-RS error', { target, error: errMsg, isConnectionRefused })
    set.status = 502
    return {
      error: isConnectionRefused ? 'PACS server is not reachable' : 'DICOMweb upstream error',
      message: isConnectionRefused ? 'The imaging server (PACS) is not responding. It may be offline or not yet started.' : undefined,
      details: err instanceof Error ? { message: err.message } : undefined,
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ----- PACS health probe -----

export interface PacsStatus {
  configured: boolean
  reachable: boolean | null
  message: string
}

/** Lightweight probe: is PACS configured + can we reach it? */
async function probePacs(explicitServer?: DicomServerConfigType | null): Promise<PacsStatus> {
  const server = explicitServer ?? getDefaultDicomServer()
  if (!server && (!config.dicomweb.enabled || !config.dicomweb.baseUrl)) {
    return { configured: false, reachable: null, message: 'DICOMweb is not configured. No PACS connection available.' }
  }

  const base = (server?.baseUrl ?? config.dicomweb.baseUrl!).replace(/\/+$/, '')
  const headers = new Headers()
  const auth = pacsAuthHeader(server)
  if (auth) headers.set('authorization', auth)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000) // 5 s ceiling for health probe

  try {
    // Orthanc DICOMweb exposes /studies, a minimal QIDO-RS query with limit=1 is a fast probe
    const resp = await fetch(`${base}/studies?limit=1`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    return {
      configured: true,
      reachable: resp.ok || resp.status === 401, // 401 means PACS is up but auth differs
      message: resp.ok ? 'PACS is available' : `PACS responded with HTTP ${resp.status}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logger.fhir.warn('PACS health probe failed', { base, error: msg })
    return {
      configured: true,
      reachable: false,
      message: `Cannot reach PACS: ${msg.includes('ECONNREFUSED') || msg.includes('fetch failed') ? 'Connection refused — is the PACS server running?' : msg}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ----- Elysia route plugin -----

const PacsStatusResponse = t.Object({
  configured: t.Boolean(),
  reachable: t.Union([t.Boolean(), t.Null()]),
  message: t.String(),
})

const dicomwebDetail = (summary: string, description: string) => ({
  summary,
  description,
  tags: ['dicomweb'],
  security: [{ BearerAuth: [] }],
})

export const dicomwebRoutes = new Elysia({ prefix: '/dicomweb', tags: ['dicomweb'] })

  // ==================== Health / Status ====================

  .get('/status', async () => {
    return probePacs()
  }, {
    response: PacsStatusResponse,
    detail: {
      summary: 'PACS Status',
      description: 'Check whether a PACS is configured and reachable. Does not require authentication so the frontend can show appropriate UI before users attempt to upload.',
      tags: ['dicomweb'],
    },
  })

  // ==================== QIDO-RS (Query) ====================

  .get('/studies', async ({ request, set }) => {
    return proxyDicomWeb(request, '/studies', set)
  }, {
    detail: dicomwebDetail('Search Studies (QIDO-RS)', 'Query for DICOM studies. Supports standard QIDO-RS query parameters (PatientName, PatientID, StudyDate, ModalitiesInStudy, etc.)'),
  })

  .get('/studies/:studyUID/series', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series`, set)
  }, {
    params: t.Object({ studyUID: UidParam }),
    detail: dicomwebDetail('Search Series (QIDO-RS)', 'Query for series within a study'),
  })

  .get('/studies/:studyUID/series/:seriesUID/instances', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}/instances`, set)
  }, {
    params: t.Object({ studyUID: UidParam, seriesUID: UidParam }),
    detail: dicomwebDetail('Search Instances (QIDO-RS)', 'Query for instances within a series'),
  })

  // ==================== WADO-RS (Retrieve) ====================

  // Study-level
  .get('/studies/:studyUID', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}`, set)
  }, {
    params: t.Object({ studyUID: UidParam }),
    detail: dicomwebDetail('Retrieve Study (WADO-RS)', 'Retrieve all instances of a study as multipart DICOM'),
  })

  .get('/studies/:studyUID/metadata', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/metadata`, set)
  }, {
    params: t.Object({ studyUID: UidParam }),
    detail: dicomwebDetail('Study Metadata (WADO-RS)', 'Retrieve DICOM JSON metadata for all instances in a study'),
  })

  .get('/studies/:studyUID/rendered', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/rendered`, set)
  }, {
    params: t.Object({ studyUID: UidParam }),
    detail: dicomwebDetail('Rendered Study (WADO-RS)', 'Retrieve a rendered (JPEG/PNG) representation of a study'),
  })

  .get('/studies/:studyUID/thumbnail', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/thumbnail`, set)
  }, {
    params: t.Object({ studyUID: UidParam }),
    detail: dicomwebDetail('Study Thumbnail (WADO-RS)', 'Retrieve a thumbnail image for a study'),
  })

  // Series-level
  .get('/studies/:studyUID/series/:seriesUID', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}`, set)
  }, {
    params: t.Object({ studyUID: UidParam, seriesUID: UidParam }),
    detail: dicomwebDetail('Retrieve Series (WADO-RS)', 'Retrieve all instances of a series as multipart DICOM'),
  })

  .get('/studies/:studyUID/series/:seriesUID/metadata', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}/metadata`, set)
  }, {
    params: t.Object({ studyUID: UidParam, seriesUID: UidParam }),
    detail: dicomwebDetail('Series Metadata (WADO-RS)', 'Retrieve DICOM JSON metadata for all instances in a series'),
  })

  .get('/studies/:studyUID/series/:seriesUID/rendered', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}/rendered`, set)
  }, {
    params: t.Object({ studyUID: UidParam, seriesUID: UidParam }),
    detail: dicomwebDetail('Rendered Series (WADO-RS)', 'Retrieve a rendered representation of a series'),
  })

  .get('/studies/:studyUID/series/:seriesUID/thumbnail', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}/thumbnail`, set)
  }, {
    params: t.Object({ studyUID: UidParam, seriesUID: UidParam }),
    detail: dicomwebDetail('Series Thumbnail (WADO-RS)', 'Retrieve a thumbnail image for a series'),
  })

  // Instance-level
  .get('/studies/:studyUID/series/:seriesUID/instances/:sopUID', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}/instances/${params.sopUID}`, set)
  }, {
    params: t.Object({ studyUID: UidParam, seriesUID: UidParam, sopUID: UidParam }),
    detail: dicomwebDetail('Retrieve Instance (WADO-RS)', 'Retrieve a single DICOM instance'),
  })

  .get('/studies/:studyUID/series/:seriesUID/instances/:sopUID/metadata', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}/instances/${params.sopUID}/metadata`, set)
  }, {
    params: t.Object({ studyUID: UidParam, seriesUID: UidParam, sopUID: UidParam }),
    detail: dicomwebDetail('Instance Metadata (WADO-RS)', 'Retrieve DICOM JSON metadata for a single instance'),
  })

  .get('/studies/:studyUID/series/:seriesUID/instances/:sopUID/rendered', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}/instances/${params.sopUID}/rendered`, set)
  }, {
    params: t.Object({ studyUID: UidParam, seriesUID: UidParam, sopUID: UidParam }),
    detail: dicomwebDetail('Rendered Instance (WADO-RS)', 'Retrieve a rendered (JPEG/PNG) representation of an instance'),
  })

  .get('/studies/:studyUID/series/:seriesUID/instances/:sopUID/thumbnail', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}/instances/${params.sopUID}/thumbnail`, set)
  }, {
    params: t.Object({ studyUID: UidParam, seriesUID: UidParam, sopUID: UidParam }),
    detail: dicomwebDetail('Instance Thumbnail (WADO-RS)', 'Retrieve a thumbnail image for an instance'),
  })

  // Frame-level
  .get('/studies/:studyUID/series/:seriesUID/instances/:sopUID/frames/:frame', async ({ request, params, set }) => {
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}/instances/${params.sopUID}/frames/${params.frame}`, set)
  }, {
    params: t.Object({
      studyUID: UidParam,
      seriesUID: UidParam,
      sopUID: UidParam,
      frame: t.String({ pattern: '^[0-9,]+$', description: 'Frame number(s), comma-separated for multi-frame' }),
    }),
    detail: dicomwebDetail('Retrieve Frame (WADO-RS)', 'Retrieve specific frame(s) from a multi-frame DICOM instance'),
  })

  // Bulkdata
  .get('/studies/:studyUID/series/:seriesUID/instances/:sopUID/bulkdata/*', async ({ request, params, set }) => {
    const wildcard = (params as Record<string, string>)['*'] || ''
    return proxyDicomWeb(request, `/studies/${params.studyUID}/series/${params.seriesUID}/instances/${params.sopUID}/bulkdata/${wildcard}`, set)
  }, {
    params: t.Object({ studyUID: UidParam, seriesUID: UidParam, sopUID: UidParam, '*': t.String() }),
    detail: dicomwebDetail('Retrieve Bulkdata (WADO-RS)', 'Retrieve bulkdata for an instance (e.g. pixel data by tag)'),
  })

  // ==================== STOW-RS (Store) ====================

  .post('/studies', async ({ request, set }) => {
    return proxyDicomWebPost(request, '/studies', set)
  }, {
    detail: dicomwebDetail('Store Instances (STOW-RS)', 'Store DICOM instances via multipart/related POST. Body must be multipart/related with application/dicom parts.'),
  })

  .post('/studies/:studyUID', async ({ request, params, set }) => {
    return proxyDicomWebPost(request, `/studies/${params.studyUID}`, set)
  }, {
    params: t.Object({ studyUID: UidParam }),
    detail: dicomwebDetail('Store Instances in Study (STOW-RS)', 'Store DICOM instances into a specific study via multipart/related POST.'),
  })

  // ==================== Viewer App ====================

  .get('/viewer-app', async ({ set }) => {
    const clientId = getDicomViewerAppClientId()
    if (!clientId) {
      set.status = 404
      return { error: 'No viewer app configured' }
    }

    // Look up in filesystem apps (public/apps/*/smart-manifest.json)
    const appsDir = join(import.meta.dir, '..', '..', 'public', 'apps')
    if (existsSync(appsDir)) {
      for (const d of readdirSync(appsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const manifestPath = join(appsDir, d.name, 'smart-manifest.json')
        if (!existsSync(manifestPath)) continue
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
          const mClientId = manifest.client_id ?? d.name
          if (mClientId === clientId) {
            return { clientId, name: manifest.client_name ?? d.name, launchUrl: `/apps/${d.name}/` }
          }
        } catch { /* skip malformed manifests */ }
      }
    }

    // Look up in published registered apps
    const published = getPublishedApps().find(pa => pa.clientId === clientId)
    if (published) {
      return { clientId: published.clientId, name: published.name, launchUrl: published.launchUrl }
    }

    set.status = 404
    return { error: 'Configured viewer app not found in app store' }
  }, {
    response: {
      200: t.Object({
        clientId: t.String(),
        name: t.String(),
        launchUrl: t.String(),
      }),
      404: t.Object({ error: t.String() }),
    },
    detail: dicomwebDetail('DICOM Viewer App', 'Get the globally configured DICOM viewer SMART app.'),
  })

  // ==================== Server-scoped routes ====================
  //
  // /dicomweb/servers/:serverId/...  routes DICOMweb requests to a specific
  // DICOM server by its config ID (instead of the default server).
  // This enables multi-PACS routing when ImagingStudy.endpoint identifies
  // which PACS holds a particular study.

  .get('/servers/:serverId/status', async ({ params, set }) => {
    const server = getDicomServerById(params.serverId)
    if (!server) {
      set.status = 404
      return { configured: false, reachable: null, message: `DICOM server '${params.serverId}' not found` }
    }
    return probePacs(server)
  }, {
    params: t.Object({ serverId: t.String({ description: 'DICOM server config ID' }) }),
    response: PacsStatusResponse,
    detail: dicomwebDetail('Server-scoped PACS Status', 'Check whether a specific DICOM server is configured and reachable.'),
  })

  .get('/servers/:serverId/*', async ({ request, params, set }) => {
    const server = getDicomServerById(params.serverId)
    if (!server) {
      set.status = 404
      return { error: 'DICOM server not found', message: `No server with ID '${params.serverId}' is configured` }
    }
    const subPath = `/${(params as Record<string, string>)['*'] || ''}`
    return proxyDicomWeb(request, subPath, set, server)
  }, {
    params: t.Object({ serverId: t.String({ description: 'DICOM server config ID' }), '*': t.String() }),
    detail: dicomwebDetail('Server-scoped DICOMweb (GET)', 'Proxy any DICOMweb GET request to a specific DICOM server (QIDO-RS, WADO-RS).'),
  })

  .post('/servers/:serverId/*', async ({ request, params, set }) => {
    const server = getDicomServerById(params.serverId)
    if (!server) {
      set.status = 404
      return { error: 'DICOM server not found', message: `No server with ID '${params.serverId}' is configured` }
    }
    const subPath = `/${(params as Record<string, string>)['*'] || ''}`
    return proxyDicomWebPost(request, subPath, set, server)
  }, {
    params: t.Object({ serverId: t.String({ description: 'DICOM server config ID' }), '*': t.String() }),
    detail: dicomwebDetail('Server-scoped STOW-RS (POST)', 'Proxy any DICOMweb POST request to a specific DICOM server (STOW-RS).'),
  })
