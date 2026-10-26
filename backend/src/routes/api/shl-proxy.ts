// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Context } from 'elysia'
import { config } from '@/config'
import { extractBearerToken } from '@/lib/admin-utils'
import { logger } from '@/lib/logger'
import { upstreamAuthHeader } from '@/lib/http-auth'
import { getServiceAccountToken } from '@/lib/shl/service-account'
import { isShareConsentRevoked } from '@/lib/consent/shl-consent'
import { getDefaultDicomServer } from '@/lib/dicom-server-config'
import { shlSessionStore, type ShareScope, type ShlSession } from '@/lib/shl/session-store'
import {
  isDicomPathAllowed,
  dicomWriteRefusal,
  fhirWriteRefusal,
  scopeFhirRequest,
  isSelectiveScopeActive,
  preScreenSelectiveRequest,
  applySelectiveFilter,
  emptySearchBundle,
  type SelectiveScope,
} from '@/lib/shl/scope'

/** True for FHIR/JSON responses we can safely parse and filter. */
function isJsonContentType(contentType: string | null): boolean {
  return !!contentType && /json/i.test(contentType)
}

/** Build the pure SelectiveScope from a session's persisted shareScope (all-empty when absent). */
export function sessionSelectiveScope(session: { shareScope?: ShareScope }): SelectiveScope {
  return {
    excludedTypes: session.shareScope?.excludedTypes ?? [],
    excludedIds: session.shareScope?.excludedIds ?? [],
    excludedObservationCategories: session.shareScope?.excludedObservationCategories ?? [],
  }
}

/**
 * Resolve + authorize an SHL bearer token for the proxy handlers: validates the
 * session token, checks expiry, and confirms the backing consent has not been
 * revoked in the consent portal. On failure sets the response status and returns
 * `{ error }`; on success returns the session. Shared by the FHIR + DICOMweb
 * proxy handlers so the checks (esp. revocation) live in exactly one place.
 */
export async function authorizeShlBearer(
  headers: Record<string, string | undefined>,
  set: Context['set'],
): Promise<{ shlId: string; session: ShlSession } | { error: string }> {
  const bearerToken = extractBearerToken(headers)
  if (!bearerToken) {
    set.status = 401
    return { error: 'Bearer token required' }
  }
  const lookup = await shlSessionStore.getByToken(bearerToken)
  if (!lookup) {
    set.status = 401
    return { error: 'Invalid or expired session token' }
  }
  const { id: shlId, session } = lookup
  if (Date.now() > session.expiresAt) {
    await shlSessionStore.delete(shlId)
    set.status = 410
    return { error: 'Share link has expired' }
  }
  if (await isShareConsentRevoked(shlId, session.fhirServerUrl)) {
    await shlSessionStore.delete(shlId) // revoked in the consent portal: purge the now-inert session
    set.status = 410
    return { error: 'Share link has been revoked' }
  }
  return { shlId, session }
}

/**
 * What the SHL proxy handlers read off Elysia's context.
 *
 * Both routes are wildcards, so the tail arrives as `params['*']`. Typing this
 * removed an inner `params as Record<string, string>` in each handler that only
 * existed because the parameter itself was `any`.
 */
interface ShlProxyContext {
  request: Request
  params: Record<string, string>
  headers: Record<string, string | undefined>
  set: Context['set']
}

export async function shlFhirProxyHandler({ request, params, headers, set }: ShlProxyContext) {
  try {
    const auth = await authorizeShlBearer(headers, set)
    if ('error' in auth) return auth
    const { shlId, session } = auth

    // Extract the FHIR path after /fhir/ (empty string for base /fhir route)
    const fhirPath = params['*'] || ''

    const url = new URL(request.url)
    // Query string sent upstream. Study-scoped requests may rewrite this to force the scope filter.
    let queryString = url.search

    if (session.studyInstanceUID) {
      // Study-scoped share: default-deny whitelist (Patient self, ImagingStudy search, metadata).
      const decision = scopeFhirRequest(fhirPath, url.search, {
        patientId: session.patientId,
        studyInstanceUID: session.studyInstanceUID,
      })
      if (!decision.allowed) {
        set.status = 403
        return { error: 'Access denied: outside shared study scope' }
      }
      if (decision.rewrittenSearch !== undefined) queryString = decision.rewrittenSearch
    } else {
      // Whole-patient share: unchanged legacy patient-scope enforcement.
      const patientParam = url.searchParams.get('patient')
      const pathSegments = fhirPath.split('/')

      if (pathSegments[0] === 'Patient') {
        if (pathSegments[1] && pathSegments[1] !== session.patientId) {
          set.status = 403
          return { error: 'Access denied: patient scope mismatch' }
        }
      } else if (patientParam && patientParam !== `Patient/${session.patientId}` && patientParam !== session.patientId) {
        set.status = 403
        return { error: 'Access denied: patient scope mismatch' }
      }
    }

    const fhirRefusal = fhirWriteRefusal({
      method: request.method,
      fhirPath,
      search: url.search,
      dicomWriteGranted: session.writeScope?.dicom === true,
      attested: session.attestation !== undefined,
    })
    if (fhirRefusal) {
      set.status = fhirRefusal.status
      return { error: fhirRefusal.error }
    }

    // Selective sharing (record/category de-selection) — whole-patient shares only.
    // Study-scoped shares have their own stricter whitelist above.
    const selective = sessionSelectiveScope(session)
    const selectiveActive = !session.studyInstanceUID && isSelectiveScopeActive(selective)
    if (selectiveActive) {
      const pre = preScreenSelectiveRequest(fhirPath, url.search, selective)
      if (pre.action === 'deny') {
        set.status = 404
        set.headers['access-control-allow-origin'] = '*'
        return { error: 'Resource not found or not shared' }
      }
      if (pre.action === 'empty-bundle') {
        set.status = 200
        set.headers['content-type'] = 'application/fhir+json'
        set.headers['access-control-allow-origin'] = '*'
        set.headers['access-control-allow-headers'] = 'Authorization, Content-Type'
        return JSON.stringify(emptySearchBundle())
      }
    }

    let serviceToken: string
    try {
      serviceToken = await getServiceAccountToken()
    } catch (tokenError) {
      const msg = tokenError instanceof Error ? tokenError.message : 'Unknown auth error'
      logger.auth.error('SHL service account token failed', { shlId, error: msg })
      set.status = 503
      return { error: `Service account auth unavailable: ${msg}` }
    }

    const targetUrl = `${session.fhirServerUrl}/${fhirPath}${queryString}`

    let resp: Response
    try {
      resp = await fetch(targetUrl, {
        method: request.method,
        headers: {
          'Accept': 'application/fhir+json',
          'Authorization': `Bearer ${serviceToken}`,
        },
      })
    } catch (fetchError) {
      const msg = fetchError instanceof Error ? fetchError.message : 'Unknown network error'
      logger.auth.error('SHL FHIR upstream unreachable', { shlId, targetUrl, error: msg })
      set.status = 502
      return { error: `Upstream FHIR server unreachable: ${msg}` }
    }

    set.status = resp.status
    const contentType = resp.headers.get('content-type')
    if (contentType) set.headers['content-type'] = contentType
    set.headers['access-control-allow-origin'] = '*'
    set.headers['access-control-allow-headers'] = 'Authorization, Content-Type'

    logger.auth.debug('SHL FHIR proxy request', {
      shlId,
      method: request.method,
      fhirPath,
      targetUrl,
      status: resp.status,
    })

    // Rewrite upstream FHIR URLs to point through the SHL proxy
    const text = await resp.text()
    const proxyBase = `${config.baseUrl}/api/shl/fhir`

    // Post-filter for selective shares: drop de-selected entries from search
    // Bundles, and 404 a single de-selected read. Defense-in-depth on top of the
    // pre-screen, and the only line of defense for searches that mix kept + hidden
    // items (e.g. an Observation search spanning several categories).
    if (selectiveActive && resp.ok && isJsonContentType(contentType)) {
      try {
        const parsed: unknown = JSON.parse(text)
        const filtered = applySelectiveFilter(parsed, selective)
        if (filtered.denied) {
          set.status = 404
          return { error: 'Resource not found or not shared' }
        }
        return JSON.stringify(filtered.body).replaceAll(session.fhirServerUrl, proxyBase)
      } catch {
        // Not JSON (or malformed) — fall through to the raw passthrough below.
      }
    }

    return text.replaceAll(session.fhirServerUrl, proxyBase)
  } catch (error) {
    logger.auth.error('SHL FHIR proxy error', { error })
    set.status = 500
    return { error: 'Internal SHL proxy error' }
  }
}

// ── SHL DICOMweb proxy handler ──────────────────────────────────────────────

export async function shlDicomwebProxyHandler({ request, params, headers, set }: ShlProxyContext) {
  try {
    const auth = await authorizeShlBearer(headers, set)
    if ('error' in auth) return auth
    const { shlId, session } = auth

    const dicomPathForGuard = params['*'] || ''
    const refusal = dicomWriteRefusal({
      method: request.method,
      dicomPath: dicomPathForGuard,
      dicomWriteGranted: session.writeScope?.dicom === true,
      attested: session.attestation !== undefined,
    })
    if (refusal) {
      set.status = refusal.status
      return { error: refusal.error }
    }

    // Resolve the configured DICOM server
    const dicomServer = getDefaultDicomServer()
    if (!dicomServer) {
      set.status = 501
      return { error: 'DICOMweb proxy is not configured' }
    }

    const dicomPath = params['*'] || ''
    const url = new URL(request.url)

    // Study-scope enforcement: default-deny anything outside the shared study.
    const decision = isDicomPathAllowed(dicomPath, url.search, session.studyInstanceUID)
    if (!decision.allowed) {
      set.status = 403
      return { error: 'Access denied: outside shared study scope' }
    }
    const queryString = decision.rewrittenSearch !== undefined ? decision.rewrittenSearch : url.search
    const targetUrl = `${dicomServer.baseUrl.replace(/\/+$/, '')}/${dicomPath}${queryString}`

    // Build upstream headers
    const upstreamHeaders = new Headers()
    const accept = request.headers.get('accept')
    if (accept) upstreamHeaders.set('accept', accept)
    const upstreamAuth = upstreamAuthHeader(dicomServer)
    if (upstreamAuth) upstreamHeaders.set('authorization', upstreamAuth)
    // STOW-RS carries the instances in a multipart body, and the boundary lives in
    // the Content-Type. Forwarding the method without either produced an empty POST.
    const isWrite = request.method.toUpperCase() === 'POST'
    if (isWrite) {
      const contentType = request.headers.get('content-type')
      if (contentType) upstreamHeaders.set('content-type', contentType)
    }

    let resp: Response
    try {
      resp = await fetch(targetUrl, {
        method: request.method,
        headers: upstreamHeaders,
        ...(isWrite ? { body: request.body, duplex: 'half' } : {}),
      })
    } catch (fetchError) {
      const msg = fetchError instanceof Error ? fetchError.message : 'Unknown network error'
      logger.auth.error('SHL DICOMweb upstream unreachable', { shlId, targetUrl, error: msg })
      set.status = 502
      return { error: `Upstream DICOMweb server unreachable: ${msg}` }
    }

    set.status = resp.status
    // Forward content-type faithfully (DICOM uses multipart/related, application/dicom+json, etc.)
    const contentType = resp.headers.get('content-type')
    if (contentType) set.headers['content-type'] = contentType
    set.headers['access-control-allow-origin'] = '*'
    set.headers['access-control-allow-headers'] = 'Authorization, Content-Type, Accept'

    logger.auth.debug('SHL DICOMweb proxy request', {
      shlId,
      method: request.method,
      dicomPath,
      targetUrl,
      status: resp.status,
    })

    // Return raw binary/multipart body — no URL rewriting needed for DICOMweb
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Authorization, Content-Type, Accept',
      },
    })
  } catch (error) {
    logger.auth.error('SHL DICOMweb proxy error', { error })
    set.status = 500
    return { error: 'Internal SHL DICOMweb proxy error' }
  }
}
