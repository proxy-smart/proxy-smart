// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Helpers the OAuth endpoints share: audience validation, IdP reachability,
 * RFC 9396 authorization details, identity resolution, and the two things
 * every token-family endpoint repeats (form-body parsing and event logging).
 */

import fetch from 'cross-fetch'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { getAllServers, ensureServersInitialized, getServerInfoByName } from '@/lib/fhir-server-store'
import { fhirMcpPath } from '@/lib/mcp-resources'
import { getRuntimeAccessControlConfig } from '@/lib/runtime-config'
import { oauthMetricsLogger } from '@/lib/oauth-metrics-logger'
import { identitiesForPerson } from '@/lib/consent/person-resolver'
import {
  IDENTITY_TYPES,
  type IdentityCandidate,
  type IdentityType,
  type LaunchSession,
  type TokenPayload,
} from '@proxy-smart/auth'

export interface AuthorizationDetail {
  type: string
  locations: string[]
  fhirVersions: string[]
  scope?: string
}

export async function generateAuthorizationDetailsFromToken(
  tokenPayload: TokenPayload
): Promise<AuthorizationDetail[] | undefined> {
  try {
    await ensureServersInitialized()
    const serverInfos = await getAllServers()
    const authDetails: AuthorizationDetail[] = []

    for (const serverInfo of serverInfos) {
      const serverDetail: AuthorizationDetail = {
        type: 'smart_on_fhir',
        locations: [`${config.baseUrl}/${config.name}/${serverInfo.identifier}/${serverInfo.metadata.fhirVersion}`],
        fhirVersions: [serverInfo.metadata.fhirVersion]
      }
      if (tokenPayload.smart_scope) {
        serverDetail.scope = tokenPayload.smart_scope
      }
      authDetails.push(serverDetail)
    }

    return authDetails.length > 0 ? authDetails : undefined
  } catch (error) {
    logger.auth.warn('Failed to generate authorization details from token', { error })
    return undefined
  }
}

export async function isKeycloakReachable(): Promise<boolean> {
  if (!config.keycloak.baseUrl || !config.keycloak.realm) return true
  try {
    const url = `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}`
    const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) })
    return resp.ok
  } catch {
    return false
  }
}

/** Validate aud/resource against known FHIR servers, MCP endpoint, and external allowlist */
export async function validateAudience(aud: string): Promise<string | null> {
  const baseUrl = config.baseUrl
  const fhirBasePrefix = `${baseUrl}/${config.name}/`
  const mcpEndpoint = `${baseUrl}${config.mcp.path}`

  if (aud.startsWith(fhirBasePrefix)) return null
  if (aud === mcpEndpoint || aud.startsWith(mcpEndpoint + '/')) return null

  await ensureServersInitialized()
  const servers = await getAllServers()
  const matchesServer = servers.some(s =>
    config.fhir.supportedVersions.some(v => {
      const endpoint = `${fhirBasePrefix}${s.identifier}/${v}`
      return aud === endpoint || aud.startsWith(endpoint + '/')
    })
  )
  if (matchesServer) return null

  // Per-server MCP endpoints. Enabling one made it serve and publish metadata, but this check
  // had never heard of it, so authorize refused the resource and no token could name it.
  const matchesFhirMcp = servers.some(
    (s) => s.mcpEnabled === true && aud === `${baseUrl}${fhirMcpPath(s.identifier)}`,
  )
  if (matchesFhirMcp) return null

  // External resource servers that use this proxy as their authorization server
  // (e.g. third-party MCP servers). Configurable via admin UI or ALLOWED_EXTERNAL_AUDIENCES env var.
  // Entries starting with '.' match all subdomains (e.g. '.maxhealth.tech' matches
  // 'dicom.maxhealth.tech', 'api.maxhealth.tech', etc. as well as 'maxhealth.tech' itself).
  const { externalAudiences } = getRuntimeAccessControlConfig()
  const matchesExternal = externalAudiences.some(allowed => {
    if (allowed.startsWith('.')) {
      // Wildcard domain: match apex and all subdomains
      try {
        const audHost = new URL(aud).hostname
        const domain = allowed.slice(1) // remove leading dot
        return audHost === domain || audHost.endsWith('.' + domain)
      } catch {
        return false
      }
    }
    return aud === allowed || aud.startsWith(allowed + '/') || aud.startsWith(allowed + '?')
  })
  if (matchesExternal) return null

  logger.auth.warn('Authorize rejected — aud/resource does not match any known endpoint', {
    aud, expectedPrefix: fhirBasePrefix, mcpEndpoint, externalAudiences,
  })
  return 'aud parameter does not match a known endpoint on this server'
}

/**
 * The identities behind a `Person` fhirUser. Read upstream with no bearer — no token exists
 * yet, and the proxy is the one asking. Any failure answers [], which never fails a launch.
 */
export const resolveIdentities = async (session: LaunchSession): Promise<IdentityCandidate[]> => {
  if (!session.fhirUser || !session.aud) return []

  const segments = new URL(session.aud).pathname.split('/').filter(Boolean)
  const serverName = segments[segments.length - 2]
  if (!serverName) return []

  const serverInfo = await getServerInfoByName(serverName)
  if (!serverInfo) return []

  const identities = await identitiesForPerson(session.fhirUser, serverInfo.url, serverName)
  return identities
    .filter((identity): identity is typeof identity & { resourceType: IdentityType } =>
      IDENTITY_TYPES.includes(identity.resourceType))
    .map((identity) => ({ reference: identity.reference, resourceType: identity.resourceType }))
}

/** Elysia `parse` for the form-encoded token endpoints. */
export async function parseFormBody(
  { request, contentType }: { request: Request; contentType?: string },
): Promise<Record<string, string> | undefined> {
  const mediaType = contentType?.split(';')[0]?.trim()
  if (mediaType !== 'application/x-www-form-urlencoded') return undefined

  const text = await request.text()
  return Object.fromEntries(new URLSearchParams(text).entries())
}

type RequestHeaders = Record<string, string | undefined>

/**
 * Record a token-family OAuth event. Never throws: a metrics failure must not
 * turn a successful token response into an error.
 */
export async function logTokenEvent(input: {
  path: string
  clientId: string
  grantType: string
  scope?: string
  status: number
  responseTime: number
  headers: RequestHeaders
  data: Record<string, unknown>
  actorChain?: string[]
}): Promise<void> {
  const { path, clientId, grantType, scope, status, responseTime, headers, data, actorChain } = input

  try {
    await oauthMetricsLogger.logEvent({
      type: 'token',
      status: status === 200 ? 'success' : 'error',
      clientId,
      clientName: clientId,
      scopes: scope ? scope.split(' ') : [],
      grantType,
      ...(actorChain && { actorChain }),
      responseTime,
      ipAddress: headers['x-forwarded-for'] || headers['x-real-ip'] || 'unknown',
      userAgent: headers['user-agent'] || 'unknown',
      errorMessage: typeof data.error_description === 'string' ? data.error_description : undefined,
      errorCode: typeof data.error === 'string' ? data.error : undefined,
      tokenType: typeof data.token_type === 'string' ? data.token_type : undefined,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
      refreshToken: Boolean(data.refresh_token),
      requestDetails: {
        path,
        method: 'POST',
        headers: {
          'content-type': headers['content-type'] || '',
          'user-agent': headers['user-agent'] || '',
        },
      },
    })
  } catch (logError) {
    logger.auth.error('Failed to log OAuth event', { logError })
  }
}
