// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { logger } from '@/lib/logger'
import { ENFORCEMENT_DEFAULTS, parseEnforcementMode, type EnforcementMode } from '@/lib/enforcement-mode'
import type { FHIRServerInfo } from '@/lib/fhir-server-store'
import { isRecord, stringArray } from '@/lib/type-guards'

export type TenantIsolationMode = EnforcementMode

export interface TenantContext {
  /** Keycloak org UUID or alias */
  organizationId: string | null
  source: 'jwt-claim' | 'launch-context' | 'user-attribute' | 'none'
}

export interface TenantCheckResult {
  allowed: boolean
  status?: number
  body?: Record<string, unknown>
  tenant: TenantContext
  modifiedQueryString?: string
}

const ORG_TAG_SYSTEM = 'https://proxy-smart.com/tenant'

function getTenantIsolationMode(): TenantIsolationMode {
  return parseEnforcementMode(process.env.TENANT_ISOLATION_MODE, ENFORCEMENT_DEFAULTS.tenantIsolation)
}

function isQueryIsolationEnabled(): boolean {
  return process.env.TENANT_QUERY_ISOLATION === 'true'
}

/** Keycloak 26+ `organization` claim is `["alias"]`, or `{ alias: {...} }` when the mapper adds attributes. */
export function resolveOrganization(
  tokenPayload: Record<string, unknown>,
): TenantContext {
  const orgClaim = tokenPayload.organization
  const claimedOrg = typeof orgClaim === 'string'
    ? orgClaim
    : stringArray(orgClaim)?.[0] ?? (isRecord(orgClaim) ? Object.keys(orgClaim)[0] : undefined)
  if (claimedOrg) {
    return { organizationId: claimedOrg, source: 'jwt-claim' }
  }

  const tenant = tokenPayload.tenant
  if (typeof tenant === 'string' && tenant.length > 0) {
    return { organizationId: tenant, source: 'launch-context' }
  }

  const userOrg = tokenPayload.organization_attribute
  if (typeof userOrg === 'string' && userOrg.length > 0) {
    return { organizationId: userOrg, source: 'user-attribute' }
  }

  return { organizationId: null, source: 'none' }
}

/** A server without organizationIds is open to every authenticated user. */
export function enforceOrgServerAccess(
  serverInfo: FHIRServerInfo,
  tenant: TenantContext,
): TenantCheckResult {
  const mode = getTenantIsolationMode()

  if (mode === 'disabled') {
    return { allowed: true, tenant }
  }

  if (!serverInfo.organizationIds || serverInfo.organizationIds.length === 0) {
    return { allowed: true, tenant }
  }

  if (!tenant.organizationId) {
    logger.fhir.warn('Tenant isolation: user has no organization but server requires one', {
      server: serverInfo.name,
      serverIdentifier: serverInfo.identifier,
      requiredOrgs: serverInfo.organizationIds,
      mode,
    })

    if (mode === 'enforce') {
      return {
        allowed: false,
        status: 403,
        body: {
          error: 'tenant_access_denied',
          message: `Access to FHIR server '${serverInfo.name}' requires organization membership`,
        },
        tenant,
      }
    }
    return { allowed: true, tenant }
  }

  const isAllowed = serverInfo.organizationIds.includes(tenant.organizationId)

  if (!isAllowed) {
    logger.fhir.warn('Tenant isolation: user org not authorized for server', {
      server: serverInfo.name,
      serverIdentifier: serverInfo.identifier,
      userOrg: tenant.organizationId,
      allowedOrgs: serverInfo.organizationIds,
      mode,
    })

    if (mode === 'enforce') {
      return {
        allowed: false,
        status: 403,
        body: {
          error: 'tenant_access_denied',
          message: `Your organization does not have access to FHIR server '${serverInfo.name}'`,
        },
        tenant,
      }
    }
  }

  return { allowed: true, tenant }
}

/** Requires resources to be tagged on write with `meta.tag = [{ system: ORG_TAG_SYSTEM, code: orgId }]`. */
export function applyQueryIsolation(
  tenant: TenantContext,
  resourcePath: string,
  method: string,
  queryString: string,
): string {
  if (!isQueryIsolationEnabled()) return queryString
  if (!tenant.organizationId) return queryString

  const pathSegments = resourcePath.split('/').filter(Boolean)
  const isSearch = method === 'GET' && pathSegments.length === 1 && /^[A-Z]/.test(pathSegments[0])
  const isPostSearch = method === 'POST' && resourcePath.endsWith('/_search')

  if (!isSearch && !isPostSearch) return queryString

  const tagFilter = `${ORG_TAG_SYSTEM}|${tenant.organizationId}`
  const sep = queryString ? '&' : '?'
  const modified = `${queryString}${sep}_tag=${encodeURIComponent(tagFilter)}`

  logger.fhir.debug('Tenant query isolation applied', {
    org: tenant.organizationId,
    resourceType: pathSegments[0],
    tagFilter,
  })

  return modified
}

export function enforceTenantIsolation(
  serverInfo: FHIRServerInfo,
  tokenPayload: Record<string, unknown>,
  resourcePath: string,
  method: string,
  queryString: string,
): TenantCheckResult {
  const tenant = resolveOrganization(tokenPayload)

  const routingResult = enforceOrgServerAccess(serverInfo, tenant)
  if (!routingResult.allowed) {
    return routingResult
  }

  const modifiedQueryString = applyQueryIsolation(tenant, resourcePath, method, queryString)

  return {
    allowed: true,
    tenant,
    modifiedQueryString,
  }
}
