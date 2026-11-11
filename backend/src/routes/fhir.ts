// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t, type Context } from 'elysia'
import { validateAdminToken, validateToken } from '../lib/auth'
import { AuthenticationError, AuthorizationError, ConfigurationError, extractBearerToken } from '../lib/admin-utils'
import { config } from '../config'
import { fhirServerStore, getServerInfoByName, publicServerName, type FHIRServerInfo } from '../lib/fhir-server-store'
import { withPublicIdentity } from '../lib/capability-identity'
import { getRuntimeBrandConfig } from '../lib/runtime-config'
import { CommonErrorResponses, ErrorResponse, CacheRefreshResponse, SmartConfigurationResponse, SmartConfigurationErrorResponse, FhirProxyResponse } from '../schemas'
import { smartConfigService, SmartConfigurationUnavailableError } from '../lib/smart-config'
import { withSmartSecurity } from '../lib/capability-security'
import { logger } from '../lib/logger'
import { upstreamFetch } from '@/lib/upstream-fetch'
import {
  authorizeFhirRequest, createFhirTarget, executeFhirPage, executeFhirRequest, forwardableHeaders, forwardToUpstream,
} from '../lib/fhir-request-pipeline'
import { proxyBaseUrl } from '../lib/fhir-proxy-base'
import { handleFhirBundle } from '../lib/fhir-bundle-access'
import { isPageContinuation } from '../lib/fhir-capabilities'
import { enforceServerAudience, invalidTokenChallenge, type AudienceTarget } from '../lib/fhir-audience-binding'

// Single-flight /metadata cache: a discovery burst (e.g. Inferno) otherwise exhausts the upstream
// HAPI Postgres connections. Safe to share because /metadata is unauthenticated and resource-agnostic.
const METADATA_TTL_MS = 60_000
interface MetadataCacheEntry { body: string; contentType: string; status: number; expiresAt: number }
const metadataCache = new Map<string, MetadataCacheEntry>()
const metadataInflight = new Map<string, Promise<MetadataCacheEntry>>()

async function getCachedMetadata(
  serverName: string,
  fhirVersion: string,
  server: FHIRServerInfo,
): Promise<MetadataCacheEntry> {
  const serverUrl = server.url
  const key = `${serverName}/${fhirVersion}`
  const now = Date.now()
  const cached = metadataCache.get(key)
  if (cached && cached.expiresAt > now) return cached
  const inflight = metadataInflight.get(key)
  if (inflight) return inflight

  const promise = (async (): Promise<MetadataCacheEntry> => {
    const target = `${serverUrl}/metadata`
    const resp = await upstreamFetch(target, { headers: { accept: 'application/fhir+json' } })
    const text = await resp.text()
    const replaced = text.replaceAll(
      serverUrl,
      proxyBaseUrl({ serverName, fhirVersion }),
    )
    // Upstream advertises no OAuth endpoints; add ours from the smart-configuration service.
    const annotated = withPublicIdentity(await annotateSecurity(replaced), {
      software: getRuntimeBrandConfig().name,
      description: publicServerName(server),
    })
    const contentType = resp.headers.get('content-type') || 'application/fhir+json'
    const entry: MetadataCacheEntry = { body: annotated, contentType, status: resp.status, expiresAt: now + METADATA_TTL_MS }
    if (resp.status === 200) metadataCache.set(key, entry)
    return entry
  })()

  metadataInflight.set(key, promise)
  try { return await promise } finally { metadataInflight.delete(key) }
}

/** Discovery being unavailable must not make /metadata unavailable, so failure serves upstream unchanged. */
async function annotateSecurity(body: string): Promise<string> {
  try {
    return withSmartSecurity(body, await smartConfigService.getSmartConfiguration())
  } catch (error) {
    logger.fhir.warn('could not advertise SMART endpoints in the CapabilityStatement', {
      error: error instanceof Error ? error.message : String(error),
    })
    return body
  }
}

/** For requests answered outside the pipeline, which binds every other request itself. */
async function audienceRefusal(
  tokenPayload: Record<string, unknown>,
  target: AudienceTarget,
  set: Context['set'],
): Promise<Record<string, unknown> | null> {
  const binding = await enforceServerAudience(tokenPayload, target)
  if (binding.allowed) return null
  set.status = binding.status ?? 401
  Object.assign(set.headers, invalidTokenChallenge(binding))
  return binding.body ?? { error: 'invalid_token' }
}


/** The path params this proxy is mounted on, plus what the handler uses. */
export interface FhirProxyContext {
  params: { server_name: string; fhir_version: string }
  request: Request
  set: Context['set']
}

export async function proxyFHIR({ params, request, set }: FhirProxyContext) {
  if (!config.fhir.supportedVersions.includes(params.fhir_version)) {
    set.status = 400
    return { error: `Unsupported FHIR version: ${params.fhir_version}` }
  }

  try {
    const serverInfo = await getServerInfoByName(params.server_name)
    if (!serverInfo) {
      set.status = 404
      return { error: `FHIR server '${params.server_name}' not found` }
    }

    const authHeader = request.headers.get('authorization') || ''
    const auth = authHeader.replace(/^Bearer\s+/, '')
    let tokenPayload = null

    if (request.method !== 'GET' || !request.url.endsWith('/metadata')) {
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }
      tokenPayload = await validateToken(auth, { enforceAudience: false })
    }

    if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/metadata')) {
      const entry = await getCachedMetadata(params.server_name, params.fhir_version, serverInfo)
      set.status = entry.status
      set.headers['content-type'] = entry.contentType
      if (entry.contentType.includes('json')) {
        try { return JSON.parse(entry.body) } catch { /* fall through to string */ }
      }
      return entry.body
    }

    if (!tokenPayload) {
      set.status = 401
      return { error: 'Authentication required' }
    }

    const requestUrl = new URL(request.url)
    const resourcePath = requestUrl.pathname.split('/').filter(Boolean).slice(3).join('/')
    const target = createFhirTarget(serverInfo, params.server_name, params.fhir_version)
    if (!resourcePath && request.method === 'POST') {
      const refusal = await audienceRefusal(tokenPayload, target, set)
      if (refusal) return refusal
    }
    const caller = { tokenPayload, authHeader }
    const headers = forwardableHeaders(request.headers)
    const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await request.text() : undefined

    const result = !resourcePath && request.method === 'POST'
      ? await handleFhirBundle(body ?? '', {
        proxyBase: proxyBaseUrl(target),
        maxEntries: config.fhir.maxBundleEntries,
        headers,
        authorize: (req) => authorizeFhirRequest(target, caller, req),
        execute: (req) => executeFhirRequest(target, caller, req),
        forwardTransaction: (bundle) => forwardToUpstream(target, caller, {
          method: 'POST', resourcePath: '', queryString: requestUrl.search, headers, body: bundle,
        }, { resourceType: 'Bundle' }),
      })
      : await executeFhirRequest(target, caller, {
        method: request.method, resourcePath, queryString: requestUrl.search, headers, body,
      })

    set.status = result.status
    set.headers = { ...set.headers, ...result.headers }
    return result.body
  } catch (error) {
    if (error instanceof AuthenticationError) {
      set.status = 401
      return { error: 'Authentication failed', details: { message: error.message } }
    }
    if (error instanceof ConfigurationError) {
      set.status = 503
      return { error: 'Service configuration error', details: { message: error.message } }
    }
    logger.fhir.error('FHIR proxy error', { server: params.server_name, error })
    set.status = 500
    return { error: 'Failed to proxy FHIR request', details: { message: error instanceof Error ? error.message : 'Internal error' } }
  }
}

const proxySchema = {
  response: {
    200: FhirProxyResponse
  },
  detail: {
    summary: 'FHIR Resource Proxy',
    description: 'Proxy authenticated FHIR requests to the upstream FHIR server',
    tags: ['fhir'],
    security: [{ BearerAuth: [] }]
  }
}

export const fhirRoutes = new Elysia({ prefix: `/${config.name}/:server_name/:fhir_version`, tags: ['fhir'] })
  .get('/.well-known/smart-configuration', async ({ params, set }) => {
    // SMART 2.2: the configuration SHALL be JSON, its failures included.
    const known = config.fhir.supportedVersions.includes(params.fhir_version)
      && (await getServerInfoByName(params.server_name)) !== null
    if (!known) {
      set.status = 404
      return { error: 'not_found', error_description: `No FHIR server ${params.server_name} is served at ${params.fhir_version}` }
    }
    try {
      return await smartConfigService.getSmartConfiguration()
    } catch (error) {
      if (!(error instanceof SmartConfigurationUnavailableError)) throw error
      set.status = 503
      set.headers['Retry-After'] = '30'
      return { error: 'temporarily_unavailable', error_description: 'The authorization server cannot be reached' }
    }
  }, {
    params: t.Object({
      server_name: t.String({ description: 'FHIR server name or identifier' }),
      fhir_version: t.String({ description: 'FHIR version (e.g., R4, R5)' })
    }),
    response: {
      200: SmartConfigurationResponse,
      404: SmartConfigurationErrorResponse,
      503: SmartConfigurationErrorResponse,
    },
    detail: {
      summary: 'SMART on FHIR Configuration for Specific Server',
      description: 'Get SMART on FHIR well-known configuration for this specific FHIR server and version',
      tags: ['smart-apps']
    }
  })

  .get('/', async ({ params, set, request, headers: requestHeaders }) => {
    if (!config.fhir.supportedVersions.includes(params.fhir_version)) {
      set.status = 400
      return { error: `Unsupported FHIR version: ${params.fhir_version}` }
    }

    const query = new URL(request.url).searchParams
    if (query.size > 0 && !isPageContinuation(query)) return proxyFHIR({ params, request, set })

    try {
      const serverInfo = await getServerInfoByName(params.server_name)
      if (!serverInfo) {
        set.status = 404
        return { error: `FHIR server '${params.server_name}' not found` }
      }
      const serverUrl = serverInfo.url

      if (query.size > 0) {
        const token = extractBearerToken(requestHeaders)
        const payload = token ? await validateToken(token, { enforceAudience: false }).catch(() => null) : null
        if (!payload) {
          set.status = 401
          return { error: 'Authentication required' }
        }
        const target = createFhirTarget(serverInfo, params.server_name, params.fhir_version)
        const page = await executeFhirPage(
          target, { tokenPayload: payload, authHeader: `Bearer ${token}` }, new URL(request.url).search, forwardableHeaders(request.headers),
        )
        set.status = page.status
        set.headers = { ...set.headers, ...page.headers }
        return page.body
      }

      const headers = new Headers()
      headers.set('accept', 'application/fhir+json')

      const resp = await upstreamFetch(serverUrl, { method: 'GET', headers })

      set.status = resp.status
      resp.headers.forEach((v: string, k: string) => {
        if (k.match(/content-type|etag/)) {
          set.headers = { ...set.headers, [k]: v }
        }
      })

      const text = await resp.text()
      const body = text.replaceAll(
        serverUrl,
        `${config.baseUrl}/${config.name}/${params.server_name}/${params.fhir_version}`
      )
      return body
    } catch (error) {
      set.status = 500
      return { error: 'Failed to serve FHIR server base URL', details: error instanceof Error ? error.message : String(error) }
    }
  }, {
    params: t.Object({
      server_name: t.String({ description: 'FHIR server name or identifier' }),
      fhir_version: t.String({ description: 'FHIR version (e.g., R4, R5)' })
    }),
    response: {
      200: t.Any({ description: 'FHIR server base response' }),
      500: ErrorResponse
    },
    detail: {
      summary: 'FHIR Server Base URL',
      description: 'Serve the content from the FHIR server base URL',
      tags: ['fhir']
    }
  })

  .post('/cache/refresh', async ({ set, headers, params }) => {
    const auth = extractBearerToken(headers)
    if (!auth) {
      set.status = 401
      return { error: 'Authentication required' }
    }

    try {
      await validateAdminToken(auth)
    } catch (error) {
      set.status = error instanceof AuthorizationError ? 403 : 401
      return { error: error instanceof AuthorizationError ? 'Admin role required' : 'Invalid or expired token' }
    }

    try {
      const serverInfo = await getServerInfoByName(params.server_name)
      if (!serverInfo) {
        set.status = 404
        return { error: `FHIR server '${params.server_name}' not found` }
      }

      await fhirServerStore.refreshServer(params.server_name)

      const updatedServerInfo = fhirServerStore.getServerByName(params.server_name)

      if (!updatedServerInfo) {
        set.status = 500
        return { error: 'Failed to refresh server info' }
      }

      return {
        success: true,
        message: 'FHIR server cache refreshed successfully',
        serverInfo: updatedServerInfo.metadata
      }
    } catch (error) {
      set.status = 500
      return { error: 'Failed to refresh FHIR server cache', details: error instanceof Error ? error.message : String(error) }
    }
  }, {
    params: t.Object({
      server_name: t.String({ description: 'FHIR server name or identifier' }),
      fhir_version: t.String({ description: 'FHIR version (e.g., R4, R5)' })
    }),
    response: {
      200: CacheRefreshResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Refresh FHIR Server Cache',
      description: 'Clear and refresh the cached FHIR server information',
      tags: ['fhir'],
      security: [{ BearerAuth: [] }]
    }
  })

  .get('/*', proxyFHIR, proxySchema)
  .post('/', proxyFHIR, proxySchema)
  .post('/*', proxyFHIR, proxySchema)
  .put('/*', proxyFHIR, proxySchema)
  .patch('/*', proxyFHIR, proxySchema)
  .delete('/*', proxyFHIR, proxySchema)
