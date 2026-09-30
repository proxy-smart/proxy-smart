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
import { checkConsentWithIal, getConsentConfig } from '../lib/consent'
import { enforceScopeAccess, enforceRoleBasedFiltering, type AccessControlContext } from '../lib/smart-access-control'
import { enforceTenantIsolation } from '../lib/tenant-isolation'
import { fhirProxyMetricsLogger } from '../lib/fhir-proxy-metrics-logger'
import { tokenActorChain } from '../lib/token-context-store'
import { getServerCapabilities, normalizeSearchParams, isInteractionSupported, isHistorySupported, isOperationSupported, isPatchFormatSupported, parseFhirPath } from '../lib/fhir-capabilities'

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

    // 2) Consent + IAL enforcement check
    if (tokenPayload) {
      const parts = new URL(request.url).pathname.split('/').filter(Boolean)
      const resourcePath = parts.slice(3).join('/')
      
      const consentResult = await checkConsentWithIal(
        tokenPayload,
        params.server_name,
        serverUrl,
        resourcePath,
        request.method,
        authHeader
      )

      // If consent or IAL denied and mode is 'enforce', block the request
      if (consentResult.decision === 'deny' && getConsentConfig().mode === 'enforce') {
        set.status = 403
        const consentAppUrl = getConsentConfig().appUrl
        return {
          error: consentResult.ialCheck && !consentResult.ialCheck.allowed ? 'ial_verification_failed' : 'consent_denied',
          message: consentResult.reason,
          consentId: consentResult.consentId,
          patientId: consentResult.context.patientId,
          clientId: consentResult.context.clientId,
          resourceType: consentResult.context.resourceType,
          ...(consentAppUrl && {
            consentRequestUrl: consentAppUrl,
            hint: 'The patient has not granted consent for this access. You may request consent via the consent management app.',
          }),
        }
      }
    }

    // build target path (preserve query string for FHIR searches)
    const requestUrl = new URL(request.url)
    const parts = requestUrl.pathname.split('/').filter(Boolean)
    const resourcePath = parts.slice(3).join('/')
    let queryString = requestUrl.search

    // 2.5) Multi-tenant isolation — verify org access and inject query filters
    let tenantOrgId: string | null = null
    if (tokenPayload) {
      const tenantResult = enforceTenantIsolation(
        serverInfo, tokenPayload, resourcePath, request.method, queryString,
      )
      if (!tenantResult.allowed) {
        set.status = tenantResult.status
        return tenantResult.body
      }
      tenantOrgId = tenantResult.tenant.organizationId
      if (tenantResult.modifiedQueryString !== undefined) {
        queryString = tenantResult.modifiedQueryString
      }
    }

    // Resolve mTLS config once per request (used by both access control and proxy fetch)
    const mtlsConfig = await getMtlsConfig(serverInfo.identifier)
    const serverFetch = async (url: string, init?: RequestInit) => {
      const useMtls = mtlsConfig?.enabled === true && url.startsWith('https://')
      return useMtls
        ? fetchWithMtls(url, { ...init, serverId: serverInfo.identifier })
        : fetch(url, init)
    }

    // 3–4) SMART access control (scope enforcement, role-based filtering)
    if (tokenPayload) {
      const acCtx: AccessControlContext = {
        tokenPayload,
        resourcePath,
        method: request.method,
        serverUrl,
        serverId: serverInfo.identifier,
        serverName: params.server_name,
        authHeader,
        upstreamFetch: serverFetch,
      }

      // 3) SMART scope enforcement
      const scopeResult = enforceScopeAccess(acCtx)
      if (!scopeResult.allowed) {
        set.status = scopeResult.status
        return scopeResult.body
      }

      // 4) Role-based filtering
      const roleResult = await enforceRoleBasedFiltering(acCtx, queryString)
      if (!roleResult.allowed) {
        set.status = roleResult.status
        // Check for early return (e.g. empty bundle for practitioner with no patients)
        return roleResult.body
      }
      queryString = roleResult.modifiedQueryString ?? queryString
    }

    // 5) Capability-aware request normalization
    // Parse the FHIR path to understand what kind of request this is
    const fhirCtx = parseFhirPath(resourcePath, request.method)
    const resourceType = fhirCtx.resourceType || 'unknown'

    const capabilities = await getServerCapabilities(serverUrl, serverInfo.identifier)
    const strictMode = serverInfo.strictCapabilities === true

    if (capabilities && fhirCtx.resourceType) {
      // 5a–d) Strict enforcement: reject requests the CapabilityStatement doesn't declare
      if (strictMode) {
        // 5a) Interaction support check
        if (!fhirCtx.isOperation && !fhirCtx.isHistory) {
          if (!isInteractionSupported(capabilities, fhirCtx.resourceType, request.method, fhirCtx.hasSearchSemantics)) {
            set.status = 405
            return {
              resourceType: 'OperationOutcome',
              issue: [{
                severity: 'error',
                code: 'not-supported',
                diagnostics: `${request.method} on ${fhirCtx.resourceType} is not supported by this FHIR server`,
              }],
            }
          }
        }

        // 5b) _history support check
        if (fhirCtx.isHistory && !isHistorySupported(capabilities, fhirCtx.resourceType, fhirCtx.isInstance)) {
          set.status = 405
          return {
            resourceType: 'OperationOutcome',
            issue: [{
              severity: 'error',
              code: 'not-supported',
              diagnostics: `_history on ${fhirCtx.resourceType} is not supported by this FHIR server`,
            }],
          }
        }

        // 5c) $operation support check
        if (fhirCtx.isOperation && fhirCtx.operationName) {
          if (!isOperationSupported(capabilities, fhirCtx.resourceType, fhirCtx.operationName)) {
            set.status = 405
            return {
              resourceType: 'OperationOutcome',
              issue: [{
                severity: 'error',
                code: 'not-supported',
                diagnostics: `$${fhirCtx.operationName} on ${fhirCtx.resourceType} is not supported by this FHIR server`,
              }],
            }
          }
        }

        // 5d) PATCH content-type check
        if (request.method === 'PATCH') {
          const contentType = request.headers.get('content-type') || ''
          if (contentType && !isPatchFormatSupported(capabilities, contentType)) {
            set.status = 415
            return {
              resourceType: 'OperationOutcome',
              issue: [{
                severity: 'error',
                code: 'not-supported',
                diagnostics: `PATCH content-type '${contentType}' is not supported. Supported: ${[...capabilities.patchFormat].join(', ') || 'none declared'}`,
              }],
            }
          }
        }
      }

      // 5e) Normalize query params (strip unsupported search params + _include/_revinclude values)
      // This runs regardless of strict mode as it's a non-breaking optimization
      if (queryString.length > 1) {
        const normResult = normalizeSearchParams(capabilities, fhirCtx.resourceType, queryString)
        const allStripped = [...normResult.strippedParams, ...normResult.strippedIncludes]
        if (allStripped.length > 0) {
          const normalized = normResult.normalizedParams.toString()
          queryString = normalized ? `?${normalized}` : ''
          logger.fhir.debug('Stripped unsupported search params', {
            server: params.server_name,
            resourceType: fhirCtx.resourceType,
            path: resourcePath,
            strippedParams: normResult.strippedParams,
            strippedIncludes: normResult.strippedIncludes,
          })
          set.headers['x-proxy-stripped-params'] = allStripped.join(',')
        }
      }
    }

    const target = `${serverUrl}${resourcePath ? `/${resourcePath}` : ''}${queryString}`

    const headers = new Headers()
    request.headers.forEach((v: string, k: string) => {
      // Strip hop-by-hop headers and CORS headers — CORS is handled at the proxy layer,
      // forwarding Origin to upstream FHIR servers triggers their own CORS rejection (e.g. HAPI/Spring 403)
      if (k === 'host' || k === 'connection' || k === 'origin' || k.startsWith('access-control-')) return
      headers.set(k, v!)
    })
    headers.set('accept', 'application/fhir+json')

    const fetchOptions = {
      method: request.method,
      headers,
      body: ['POST', 'PUT', 'PATCH'].includes(request.method)
        ? await request.text()
        : undefined
    }

    // Check if mTLS is configured for this server
    const useMtls = mtlsConfig?.enabled === true && target.startsWith('https://')

    // Use appropriate fetch method based on mTLS configuration
    const fetchStart = performance.now()
    const resp = useMtls
      ? await fetchWithMtls(target, { ...fetchOptions, serverId: serverInfo.identifier })
      : await fetch(target, fetchOptions)
    const fetchMs = Math.round(performance.now() - fetchStart)

    // Track proxied request metrics (fire-and-forget)
    fhirProxyMetricsLogger.logRequest({
      serverName: params.server_name,
      method: request.method,
      resourcePath,
      resourceType,
      statusCode: resp.status,
      responseTimeMs: fetchMs,
      clientId: tokenPayload?.azp || tokenPayload?.client_id,
      ...(tokenPayload && { actorChain: tokenActorChain(tokenPayload) }),
      userId: tokenPayload?.sub,
      username: tokenPayload?.preferred_username,
      organizationId: tenantOrgId ?? undefined,
      error: resp.status >= 400 ? `HTTP ${resp.status}` : undefined,
    })

    // copy status & CORS headers
    set.status = resp.status
    resp.headers.forEach((v: string, k: string) => {
      if (k.match(/content-type|etag|location/)) {
        set.headers = { ...set.headers, [k]: v }
      }
    })
    const text = await resp.text()
    const replaced = text.replaceAll(
      serverUrl,
      `${config.baseUrl}/${config.name}/${params.server_name}/${params.fhir_version}`
    )
    // Parse JSON so Elysia's response schema validation preserves all properties.
    // Returning a raw string with a t.Object() response schema causes Elysia to
    // encode/strip the response, breaking FHIR resource fields like resourceType.
    const contentType = resp.headers.get('content-type') || ''
    if (contentType.includes('json')) {
      try { return JSON.parse(replaced) } catch { /* fall through to string */ }
    }
    return replaced
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
  .get('/', async ({ params, set, request }) => {
    // early version sanity check
    if (!config.fhir.supportedVersions.includes(params.fhir_version)) {
      set.status = 400
      return { error: `Unsupported FHIR version: ${params.fhir_version}` }
    }

    try {
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
  .post('/*', proxyFHIR, proxySchema)
  .put('/*', proxyFHIR, proxySchema)
  .patch('/*', proxyFHIR, proxySchema)
  .delete('/*', proxyFHIR, proxySchema)
