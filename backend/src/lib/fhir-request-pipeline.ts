// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '../config'
import type { FHIRServerInfo } from './fhir-server-store'
import { logger } from './logger'
import { checkConsentWithIal, getConsentConfig } from './consent'
import { enforceScopeAccess, enforceRoleBasedFiltering, type AccessControlContext } from './smart-access-control'
import { enforceScopeConstraints } from './smart-scope-constraints'
import { enforceTenantIsolation } from './tenant-isolation'
import { enforceOperationPolicy } from './fhir-operation-policy'
import { enforceClientServerAccess } from './client-server-access'
import { enforceIncludeAccess } from './smart-include-access'
import { ERASE_OPERATION, eraseRecord } from './fhir-erasure'
import { resolveFhirUserForClient } from './consent/person-resolver'
import { fhirProxyMetricsLogger } from './fhir-proxy-metrics-logger'
import { tokenActorChain } from './token-context-store'
import { operationOutcome } from './fhir-operation-outcome'
import { optionalString } from './type-guards'
import { fetchWithMtls, getMtlsConfig } from './mtls'
import {
  getServerCapabilities, normalizeSearchParams, isInteractionSupported, isHistorySupported,
  isOperationSupported, isPatchFormatSupported, parseFhirPath, type FhirRequestContext, type ServerCapabilities,
} from './fhir-capabilities'

/** One upstream FHIR server as the proxy reaches it. */
export interface FhirTarget {
  serverInfo: FHIRServerInfo
  serverName: string
  fhirVersion: string
  upstreamFetch: (url: string, init?: RequestInit) => Promise<Response>
}

/** The upstream reached over mTLS when the server is configured for it. */
export async function createFhirTarget(serverInfo: FHIRServerInfo, serverName: string, fhirVersion: string): Promise<FhirTarget> {
  const mtlsConfig = await getMtlsConfig(serverInfo.identifier)
  return {
    serverInfo,
    serverName,
    fhirVersion,
    upstreamFetch: (url, init) => mtlsConfig?.enabled === true && url.startsWith('https://')
      ? fetchWithMtls(url, { ...init, serverId: serverInfo.identifier })
      : fetch(url, init),
  }
}

export interface FhirCaller {
  tokenPayload: Record<string, unknown>
  authHeader: string
}

/** A FHIR interaction relative to the server base; `queryString` is '' or starts with '?'. */
export interface FhirRequestInput {
  method: string
  resourcePath: string
  queryString: string
  headers: Headers
  body?: string
}

export type FhirAuthorization =
  | { allowed: true; queryString: string; tenantOrgId: string | null }
  | { allowed: false; status: number; body: Record<string, unknown> }

export interface FhirProxyResult {
  status: number
  headers: Record<string, string>
  body: unknown
}

const FORWARDED_RESPONSE_HEADER_RE = /content-type|etag|location|last-modified/

export function proxyBaseUrl(target: Pick<FhirTarget, 'serverName' | 'fhirVersion'>): string {
  return `${config.baseUrl}/${config.name}/${target.serverName}/${target.fhirVersion}`
}

/** Request headers worth forwarding upstream: CORS and hop-by-hop headers belong to the proxy. */
export function forwardableHeaders(source: Headers): Headers {
  const headers = new Headers()
  source.forEach((v, k) => {
    if (k === 'host' || k === 'connection' || k === 'origin' || k === 'content-length' || k.startsWith('access-control-')) return
    headers.set(k, v)
  })
  headers.set('accept', 'application/fhir+json')
  return headers
}

function denied(status: number | undefined, body: Record<string, unknown> | undefined): FhirAuthorization {
  return { allowed: false, status: status ?? 403, body: body ?? { error: 'access_denied' } }
}

async function checkConsent(target: FhirTarget, caller: FhirCaller, req: FhirRequestInput): Promise<FhirAuthorization | null> {
  const consentResult = await checkConsentWithIal(
    caller.tokenPayload, target.serverName, target.serverInfo.url, req.resourcePath, req.method, caller.authHeader,
  )
  if (consentResult.decision !== 'deny' || getConsentConfig().mode !== 'enforce') return null
  const consentAppUrl = getConsentConfig().appUrl
  return denied(403, {
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
  })
}

/** Policy, client server access, consent, tenant, scopes (with includes and constraints) and compartment; the query carries their narrowing. */
export async function authorizeFhirRequest(target: FhirTarget, caller: FhirCaller, req: FhirRequestInput): Promise<FhirAuthorization> {
  const policy = enforceOperationPolicy({
    resourcePath: req.resourcePath, method: req.method, queryString: req.queryString, tokenPayload: caller.tokenPayload,
  })
  if (!policy.allowed) return denied(policy.status, policy.body)

  const serverAccess = await enforceClientServerAccess(caller.tokenPayload, { identifier: target.serverInfo.identifier, name: target.serverName })
  if (!serverAccess.allowed) return denied(serverAccess.status, serverAccess.body)

  const consentDenial = await checkConsent(target, caller, req)
  if (consentDenial) return consentDenial

  const tenant = enforceTenantIsolation(target.serverInfo, caller.tokenPayload, req.resourcePath, req.method, req.queryString)
  if (!tenant.allowed) return denied(tenant.status, tenant.body)
  let queryString = tenant.modifiedQueryString ?? req.queryString

  const acCtx: AccessControlContext = {
    tokenPayload: caller.tokenPayload,
    resourcePath: req.resourcePath,
    method: req.method,
    serverUrl: target.serverInfo.url,
    serverId: target.serverInfo.identifier,
    serverName: target.serverName,
    authHeader: caller.authHeader,
    upstreamFetch: target.upstreamFetch,
  }
  const scope = enforceScopeAccess(acCtx)
  if (!scope.allowed) return denied(scope.status, scope.body)
  const includes = enforceIncludeAccess(caller.tokenPayload, req, target.serverName)
  if (!includes.allowed) return denied(includes.status, includes.body)
  if (scope.scopeConstraints) {
    const capabilities = await getServerCapabilities(target.serverInfo.url, target.serverInfo.identifier)
    const constrained = await enforceScopeConstraints(acCtx, { queryString, body: req.body, capabilities }, scope.scopeConstraints)
    if (!constrained.allowed) return denied(constrained.status, constrained.body)
    queryString = constrained.modifiedQueryString ?? queryString
  }

  const role = await enforceRoleBasedFiltering(acCtx, queryString, { body: req.body, headers: req.headers })
  if (!role.allowed) return denied(role.status, role.body)
  return { allowed: true, queryString: role.modifiedQueryString ?? queryString, tenantOrgId: tenant.tenant.organizationId }
}

function notSupported(status: number, diagnostics: string): FhirProxyResult {
  return { status, headers: {}, body: operationOutcome('not-supported', diagnostics) }
}

function strictCapabilityRefusal(capabilities: ServerCapabilities, fhirCtx: FhirRequestContext, req: FhirRequestInput): FhirProxyResult | null {
  const resourceType = fhirCtx.resourceType
  if (!resourceType) return null
  if (!fhirCtx.isOperation && !fhirCtx.isHistory && !isInteractionSupported(capabilities, resourceType, req.method, fhirCtx.hasSearchSemantics)) {
    return notSupported(405, `${req.method} on ${resourceType} is not supported by this FHIR server`)
  }
  if (fhirCtx.isHistory && !isHistorySupported(capabilities, resourceType, fhirCtx.isInstance)) {
    return notSupported(405, `_history on ${resourceType} is not supported by this FHIR server`)
  }
  if (fhirCtx.isOperation && fhirCtx.operationName && !isOperationSupported(capabilities, resourceType, fhirCtx.operationName)) {
    return notSupported(405, `$${fhirCtx.operationName} on ${resourceType} is not supported by this FHIR server`)
  }
  const contentType = req.headers.get('content-type') || ''
  if (req.method === 'PATCH' && contentType && !isPatchFormatSupported(capabilities, contentType)) {
    return notSupported(415, `PATCH content-type '${contentType}' is not supported. Supported: ${[...capabilities.patchFormat].join(', ') || 'none declared'}`)
  }
  return null
}

/** Search parameters access control added to the client's query, which normalisation must not strip. */
function accessControlParams(original: string, authorized: string): Set<string> {
  const before = new URLSearchParams(original.startsWith('?') ? original.slice(1) : original)
  const added = new Set<string>()
  for (const [name, value] of new URLSearchParams(authorized.startsWith('?') ? authorized.slice(1) : authorized)) {
    if (!before.getAll(name).includes(value)) added.add(name)
  }
  return added
}

/** Send an authorised request upstream and bring the answer back in the proxy's own URLs. */
export async function forwardToUpstream(
  target: FhirTarget,
  caller: FhirCaller,
  req: FhirRequestInput,
  extra: { resourceType?: string; tenantOrgId?: string | null } = {},
): Promise<FhirProxyResult> {
  const serverUrl = target.serverInfo.url
  const upstreamUrl = `${serverUrl}${req.resourcePath ? `/${req.resourcePath}` : ''}${req.queryString}`
  const fetchStart = performance.now()
  const resp = await target.upstreamFetch(upstreamUrl, {
    method: req.method,
    headers: req.headers,
    body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? req.body : undefined,
  })
  fhirProxyMetricsLogger.logRequest({
    serverName: target.serverName,
    method: req.method,
    resourcePath: req.resourcePath,
    resourceType: extra.resourceType ?? 'unknown',
    statusCode: resp.status,
    responseTimeMs: Math.round(performance.now() - fetchStart),
    clientId: optionalString(caller.tokenPayload.azp) ?? optionalString(caller.tokenPayload.client_id),
    actorChain: await tokenActorChain(caller.tokenPayload),
    userId: optionalString(caller.tokenPayload.sub),
    username: optionalString(caller.tokenPayload.preferred_username),
    organizationId: extra.tenantOrgId ?? undefined,
    error: resp.status >= 400 ? `HTTP ${resp.status}` : undefined,
  }).catch((error: unknown) => logger.fhir.error('Failed to record FHIR proxy metrics', undefined, error))

  const headers: Record<string, string> = {}
  resp.headers.forEach((v, k) => {
    if (FORWARDED_RESPONSE_HEADER_RE.test(k)) headers[k] = v
  })
  const text = (await resp.text()).replaceAll(serverUrl, proxyBaseUrl(target))
  if ((resp.headers.get('content-type') || '').includes('json')) {
    try {
      return { status: resp.status, headers, body: JSON.parse(text) }
    } catch {
      logger.fhir.debug('Upstream declared JSON but sent something else', { server: target.serverName, status: resp.status })
    }
  }
  return { status: resp.status, headers, body: text }
}

/** Authorise, normalise and proxy one FHIR interaction. */
export async function executeFhirRequest(target: FhirTarget, caller: FhirCaller, req: FhirRequestInput): Promise<FhirProxyResult> {
  const authorization = await authorizeFhirRequest(target, caller, req)
  if (!authorization.allowed) return { status: authorization.status, headers: {}, body: authorization.body }

  const fhirCtx = parseFhirPath(req.resourcePath, req.method)
  const serverInfo = target.serverInfo
  const capabilities = await getServerCapabilities(serverInfo.url, serverInfo.identifier)

  if (req.method === 'POST' && fhirCtx.operationName === ERASE_OPERATION && fhirCtx.resourceType && fhirCtx.resourceId) {
    const erased = await eraseRecord({
      resourceType: fhirCtx.resourceType,
      resourceId: fhirCtx.resourceId,
      tokenPayload: caller.tokenPayload,
      serverUrl: serverInfo.url,
      authHeader: caller.authHeader,
      upstreamFetch: target.upstreamFetch,
      expungeSupported: isOperationSupported(capabilities, fhirCtx.resourceType, 'expunge'),
      personPatient: (person) => resolveFhirUserForClient(person, true, serverInfo.url, serverInfo.identifier, caller.authHeader),
    })
    return { status: erased.status, headers: {}, body: erased.body }
  }

  let queryString = authorization.queryString
  const responseHeaders: Record<string, string> = {}
  if (capabilities && fhirCtx.resourceType) {
    if (serverInfo.strictCapabilities === true) {
      const refusal = strictCapabilityRefusal(capabilities, fhirCtx, req)
      if (refusal) return refusal
    }
    if (queryString.length > 1) {
      const normResult = normalizeSearchParams(capabilities, fhirCtx.resourceType, queryString)
      const stripped = [...normResult.strippedParams, ...normResult.strippedIncludes]
      if (stripped.length > 0) {
        const needed = accessControlParams(req.queryString, queryString)
        const lost = normResult.strippedParams.filter((p) => needed.has(p))
        if (lost.length > 0) {
          return { status: 403, headers: {}, body: operationOutcome('forbidden', `The upstream server does not declare search parameter ${lost.join(', ')} on ${fhirCtx.resourceType}, which access control needs to confine this search.`) }
        }
        const normalized = normResult.normalizedParams.toString()
        queryString = normalized ? `?${normalized}` : ''
        logger.fhir.debug('Stripped unsupported search params', {
          server: target.serverName, resourceType: fhirCtx.resourceType, path: req.resourcePath,
          strippedParams: normResult.strippedParams, strippedIncludes: normResult.strippedIncludes,
        })
        responseHeaders['x-proxy-stripped-params'] = stripped.join(',')
      }
    }
  }

  const result = await forwardToUpstream(target, caller, { ...req, queryString }, {
    resourceType: fhirCtx.resourceType || 'unknown',
    tenantOrgId: authorization.tenantOrgId,
  })
  return { ...result, headers: { ...responseHeaders, ...result.headers } }
}
