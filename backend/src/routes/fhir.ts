// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import type { Context } from 'elysia'
import fetch from 'cross-fetch'
import { validateToken } from '../lib/auth'
import { AuthenticationError, ConfigurationError, extractBearerToken } from '../lib/admin-utils'
import { config } from '../config'
import { fhirServerStore, getServerByName, getServerInfoByName } from '../lib/fhir-server-store'
import { CommonErrorResponses, ErrorResponse, CacheRefreshResponse, SmartConfigurationResponse, FhirProxyResponse, type SmartConfigurationResponseType } from '../schemas'
import { smartConfigService } from '../lib/smart-config'
import { withSmartSecurity } from '../lib/capability-security'
import { logger } from '../lib/logger'
import { fetchWithMtls, getMtlsConfig } from '@/lib/mtls'
import {
  authorizeFhirRequest, executeFhirRequest, forwardableHeaders, forwardToUpstream, proxyBaseUrl, type FhirTarget,
} from '../lib/fhir-request-pipeline'
import { handleFhirBundle } from '../lib/fhir-bundle-access'

/**
 * Short-lived CapabilityStatement (/metadata) cache with single-flight coalescing.
 *
 * Inferno (and any SMART client doing discovery) re-requests /metadata from many
 * test groups near-simultaneously. Each uncached hit opens an upstream
 * HAPI→Postgres connection; a burst can trip the shared Postgres limit
 * ("sorry, too many clients already") and surface as a 500. Caching the
 * (URL-rewritten) response for a short TTL and collapsing concurrent misses into
 * a single upstream call removes that DB pressure. /metadata is unauthenticated
 * and resource-agnostic, so it is safe to serve from a per-(server,version) cache.
 */
const METADATA_TTL_MS = 60_000
interface MetadataCacheEntry { body: string; contentType: string; status: number; expiresAt: number }
const metadataCache = new Map<string, MetadataCacheEntry>()
const metadataInflight = new Map<string, Promise<MetadataCacheEntry>>()

async function getCachedMetadata(
  serverName: string,
  fhirVersion: string,
  serverUrl: string,
  serverId: string,
  mtlsConfig: { enabled?: boolean } | null | undefined,
): Promise<MetadataCacheEntry> {
  const key = `${serverName}/${fhirVersion}`
  const now = Date.now()
  const cached = metadataCache.get(key)
  if (cached && cached.expiresAt > now) return cached
  const inflight = metadataInflight.get(key)
  if (inflight) return inflight

  const promise = (async (): Promise<MetadataCacheEntry> => {
    const target = `${serverUrl}/metadata`
    const useMtls = mtlsConfig?.enabled === true && target.startsWith('https://')
    const resp = useMtls
      ? await fetchWithMtls(target, { headers: { accept: 'application/fhir+json' }, serverId })
      : await fetch(target, { headers: { accept: 'application/fhir+json' } })
    const text = await resp.text()
    const replaced = text.replaceAll(
      serverUrl,
      `${config.baseUrl}/${config.name}/${serverName}/${fhirVersion}`,
    )
    // Upstream does not know it is behind a SMART layer, so it advertises no OAuth endpoints. We
    // are the layer, so we add them from the same service that builds .well-known/smart-configuration.
    const annotated = await annotateSecurity(replaced)
    const contentType = resp.headers.get('content-type') || 'application/fhir+json'
    const entry: MetadataCacheEntry = { body: annotated, contentType, status: resp.status, expiresAt: now + METADATA_TTL_MS }
    // Only cache successes; let transient upstream errors retry on the next hit.
    if (resp.status === 200) metadataCache.set(key, entry)
    return entry
  })()

  metadataInflight.set(key, promise)
  try { return await promise } finally { metadataInflight.delete(key) }
}

/**
 * Add this proxy's OAuth endpoints to a CapabilityStatement. Discovery being unavailable must not
 * make /metadata unavailable, so a failure here serves the upstream document unchanged.
 */
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

const PAGING_PARAMS = new Set(['_getpages', '_getpagesoffset', '_count', '_format', '_pretty', '_bundletype'])

/** A continuation of a search the pipeline already authorised: the page id is the server's cursor. */
function isPagingRequest(query: URLSearchParams): boolean {
  return query.has('_getpages') && [...query.keys()].every((k) => PAGING_PARAMS.has(k))
}

/** The path params this proxy is mounted on, plus what the handler uses. */
interface FhirProxyContext {
  params: { server_name: string; fhir_version: string }
  request: Request
  set: Context['set']
}

async function proxyFHIR({ params, request, set }: FhirProxyContext) {
  // 1) early version sanity check
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

    const serverUrl = serverInfo.url
    const authHeader = request.headers.get('authorization') || ''
    const auth = authHeader.replace(/^Bearer\s+/, '')
    let tokenPayload = null

    // skip auth on metadata
    if (request.method !== 'GET' || !request.url.endsWith('/metadata')) {
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }
      // SMART App Launch 2.2.0: the access-token format is implementation-defined
      // and does NOT require a JWT `aud` claim, so browser SMART app tokens never
      // carry the FHIR base as `aud` (Keycloak defaults aud="account"). Per issue
      // #355 JWT `aud`-claim validation is intentionally NOT enforced here. FHIR
      // access is gated instead by: issuer/signature/expiry (validateToken), the
      // `aud`/`resource` REQUEST parameter validated at /authorize (#355 Phase 2),
      // and SMART scope enforcement (enforceScopeAccess, defaults to "enforce").
      tokenPayload = await validateToken(auth, { enforceAudience: false })
    }

    // 1.5) CapabilityStatement fast-path: serve /metadata from the short-lived,
    // single-flight cache so a concurrent discovery burst does not exhaust the
    // upstream FHIR DB connection pool. Unauthenticated and resource-agnostic, so
    // it short-circuits before consent/scope/capability processing.
    if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/metadata')) {
      const mtlsConfig = await getMtlsConfig(serverInfo.identifier)
      const entry = await getCachedMetadata(
        params.server_name, params.fhir_version, serverUrl, serverInfo.identifier, mtlsConfig,
      )
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
    const mtlsConfig = await getMtlsConfig(serverInfo.identifier)
    const target: FhirTarget = {
      serverInfo,
      serverName: params.server_name,
      fhirVersion: params.fhir_version,
      upstreamFetch: (url, init) => mtlsConfig?.enabled === true && url.startsWith('https://')
        ? fetchWithMtls(url, { ...init, serverId: serverInfo.identifier })
        : fetch(url, init),
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

// Reusable schema for proxy endpoint
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
/**
 * FHIR proxy routes with authentication and CORS support
 * 
 * Route Structure: /:server_name/:fhir_version/*
 * - Client specifies server name and version (e.g., /hapi-fhir-server/R4/Patient/123)
 * - We map server names to configured FHIR server URLs
 * - Proxy requests to the appropriate FHIR server
 * - Response URLs maintain client's requested server name and version for consistency
 * 
 * SMART on FHIR Configuration:
 * - Each FHIR server has its own SMART configuration endpoint
 * - /:server_name/:fhir_version/.well-known/smart-configuration
 * - Configuration is dynamically generated from Keycloak and cached for performance
 * - This follows SMART on FHIR specification where configuration is server-specific
 * 
 * Performance Features:
 * - FHIR server info is cached for 5 minutes to avoid repeated metadata calls
 * - Cache is pre-warmed on server startup for faster first requests
 * - Version normalization: "4.0.1" → "R4", "5.0.0" → "R5"
 * - Fallback handling: continues working even if FHIR server is temporarily unavailable
 * - Admin cache refresh endpoint available at /admin/smart-config/refresh
 */

export const fhirRoutes = new Elysia({ prefix: `/${config.name}/:server_name/:fhir_version`, tags: ['fhir'] })
  // SMART on FHIR Configuration endpoint - server-specific configuration
  .get('/.well-known/smart-configuration', async (): Promise<SmartConfigurationResponseType> => {
    // CORS is handled by the global @elysiajs/cors plugin
    return await smartConfigService.getSmartConfiguration()
  }, {
    params: t.Object({
      server_name: t.String({ description: 'FHIR server name or identifier' }),
      fhir_version: t.String({ description: 'FHIR version (e.g., R4, R5)' })
    }),
    response: {
      200: SmartConfigurationResponse
    },
    detail: {
      summary: 'SMART on FHIR Configuration for Specific Server',
      description: 'Get SMART on FHIR well-known configuration for this specific FHIR server and version',
      tags: ['smart-apps']
    }
  })
  // CORS preflight is handled by the global @elysiajs/cors plugin

  // Root FHIR path - serve the FHIR server base URL content
  .get('/', async ({ params, set, request, headers: requestHeaders }) => {
    // early version sanity check
    if (!config.fhir.supportedVersions.includes(params.fhir_version)) {
      set.status = 400
      return { error: `Unsupported FHIR version: ${params.fhir_version}` }
    }

    const query = new URL(request.url).searchParams
    if (query.size > 0 && !isPagingRequest(query)) return proxyFHIR({ params, request, set })

    try {
      if (query.size > 0) {
        const token = extractBearerToken(requestHeaders)
        const valid = token ? await validateToken(token, { enforceAudience: false }).then(() => true, () => false) : false
        if (!valid) {
          set.status = 401
          return { error: 'Authentication required' }
        }
      }

      // Use the store to get server URL - this will initialize the store if needed
      const serverUrl = await getServerByName(params.server_name)
      if (!serverUrl) {
        set.status = 404
        return { error: `FHIR server '${params.server_name}' not found` }
      }

      // Forward query params (e.g. _getpages pagination) to upstream
      const queryString = new URL(request.url).search

      const headers = new Headers()
      headers.set('accept', 'application/fhir+json')

      const resp = await fetch(`${serverUrl}${queryString}`, {
        method: 'GET',
        headers
      })

      set.status = resp.status
      resp.headers.forEach((v: string, k: string) => {
        if (k.match(/content-type|etag/)) {
          set.headers = { ...set.headers, [k]: v }
        }
      })

      // CORS is handled by the global @elysiajs/cors plugin

      const text = await resp.text()
      // Rewrite URLs to use our proxy base URL
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

  // Admin endpoint to refresh FHIR server cache
  .post('/cache/refresh', async ({ set, headers, params }) => {
    // Require authentication for cache management
    const auth = extractBearerToken(headers)
    if (!auth) {
      set.status = 401
      return { error: 'Authentication required' }
    }

    try {
      // SMART App Launch 2.2.0: token format is implementation-defined and does
      // not require a JWT `aud` claim; per #355 JWT `aud` is not enforced for the
      // FHIR call sites (issuer/signature/expiry + authorize-time aud param +
      // SMART scope are the gates). Keep this aligned with the proxy call site.
      await validateToken(auth, { enforceAudience: false })

      // Get server info by name (automatically initializes if needed)
      const serverInfo = await getServerInfoByName(params.server_name)
      if (!serverInfo) {
        set.status = 404
        return { error: `FHIR server '${params.server_name}' not found` }
      }

      // Refresh specific server in the store
      await fhirServerStore.refreshServer(params.server_name)

      // Get the updated server info
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

  // all other FHIR requests - proxy to the FHIR server
  .get('/*', proxyFHIR, proxySchema)
  .post('/', proxyFHIR, proxySchema)
  .post('/*', proxyFHIR, proxySchema)
  .put('/*', proxyFHIR, proxySchema)
  .patch('/*', proxyFHIR, proxySchema)
  .delete('/*', proxyFHIR, proxySchema)
