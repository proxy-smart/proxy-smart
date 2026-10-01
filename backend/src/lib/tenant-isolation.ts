// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Multi-Tenant Isolation for FHIR Proxy
 *
 * Three independent, opt-in features for SaaS-grade data isolation:
 *
 * 1. **Org-Enforced Routing** — verifies that the user's Keycloak organization
 *    is allowed to access the target FHIR server (via server.organizationIds).
 *    Servers without organizationIds are accessible by all authenticated users.
 *
 * 2. **Query-Level Isolation** — when enabled and a FHIR server is shared by
 *    multiple orgs, injects a `_tag` search parameter scoped to the user's org
 *    so Org A cannot see Org B's data.
 *
 * 3. **Tenant Audit Context** — resolves the user's org and attaches it to the
 *    request context for downstream audit logging.
 *
 * Org resolution order:
 *   1. `organization` claim in the JWT (Keycloak org mapper)
 *   2. `tenant` from SMART launch context (TokenContextStore)
 *   3. `organization` user attribute (Keycloak user profile)
 *
 * All features default to `disabled` for backward compatibility.
 * Set TENANT_ISOLATION_MODE=enforce|audit-only to activate.
 */

import { logger } from '@/lib/logger'
import { ENFORCEMENT_DEFAULTS, parseEnforcementMode, type EnforcementMode } from '@/lib/enforcement-mode'
import type { FHIRServerInfo } from '@/lib/fhir-server-store'
import { isRecord, stringArray } from '@/lib/type-guards'

// ── Types ────────────────────────────────────────────────────────────────────

export type TenantIsolationMode = EnforcementMode

export interface TenantContext {
  /** Resolved organization ID (Keycloak org UUID or alias) */
  organizationId: string | null
  /** How the org was resolved */
  source: 'jwt-claim' | 'launch-context' | 'user-attribute' | 'none'
}

export interface TenantCheckResult {
  /** Whether the request should proceed */
  allowed: boolean
  /** HTTP status if denied */
  status?: number
  /** Error body if denied */
  body?: Record<string, unknown>
  /** Resolved tenant context (always populated even if not enforcing) */
  tenant: TenantContext
  /** Modified query string (for tag-based isolation) */
  modifiedQueryString?: string
}

// ── Configuration ────────────────────────────────────────────────────────────

/** System tag used for org-scoped data partitioning */
const ORG_TAG_SYSTEM = 'https://proxy-smart.com/tenant'

function getTenantIsolationMode(): TenantIsolationMode {
  return parseEnforcementMode(process.env.TENANT_ISOLATION_MODE, ENFORCEMENT_DEFAULTS.tenantIsolation)
}

function isQueryIsolationEnabled(): boolean {
  return process.env.TENANT_QUERY_ISOLATION === 'true'
}

// ── Org Resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the user's organization from the token payload.
 *
 * Keycloak 26+ with Organizations enabled adds an `organization` claim to
 * tokens via the built-in organization mapper: a list of org aliases
 * `["org-alias"]`, or `{ "org-alias": { ... } }` when the mapper adds
 * attributes. A simple string value is supported for backward compatibility.
 */
export function resolveOrganization(
  tokenPayload: Record<string, unknown>,
): TenantContext {
  // 1. Keycloak org claim (KC 26+ Organizations feature)
  const orgClaim = tokenPayload.organization
  const claimedOrg = typeof orgClaim === 'string'
    ? orgClaim
    : stringArray(orgClaim)?.[0] ?? (isRecord(orgClaim) ? Object.keys(orgClaim)[0] : undefined)
  if (claimedOrg) {
    return { organizationId: claimedOrg, source: 'jwt-claim' }
  }

  // 2. Tenant from SMART launch context (enriched during token exchange)
  const tenant = tokenPayload.tenant
  if (typeof tenant === 'string' && tenant.length > 0) {
    return { organizationId: tenant, source: 'launch-context' }
  }

  // 3. Organization user attribute (set via admin UI)
  const userOrg = tokenPayload.organization_attribute
  if (typeof userOrg === 'string' && userOrg.length > 0) {
    return { organizationId: userOrg, source: 'user-attribute' }
  }

  return { organizationId: null, source: 'none' }
}

// ── Org-Enforced Routing ─────────────────────────────────────────────────────

/**
 * Verify that the user's organization is authorized to access the target
 * FHIR server. If the server has no organizationIds configured, access is
 * allowed to all authenticated users (backward compatible).
 */
export function enforceOrgServerAccess(
  serverInfo: FHIRServerInfo,
  tenant: TenantContext,
): TenantCheckResult {
  const mode = getTenantIsolationMode()

  // Feature disabled — always allow
  if (mode === 'disabled') {
    return { allowed: true, tenant }
  }

  // Server has no org restrictions — accessible by all
  if (!serverInfo.organizationIds || serverInfo.organizationIds.length === 0) {
    return { allowed: true, tenant }
  }

  // User has no org — deny if server requires one
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
    // audit-only: log but allow
    return { allowed: true, tenant }
  }

  // Check if user's org is in the server's allowed list
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

// ── Query-Level Isolation ────────────────────────────────────────────────────

/**
 * Inject org-scoped `_tag` filter into FHIR search queries.
 * Only applies when:
 *   - TENANT_QUERY_ISOLATION=true
 *   - The user has a resolved org
 *   - The request is a search (GET on resource type, no specific ID)
 *
 * This ensures Org A's searches never return Org B's resources,
 * even when both orgs share a single HAPI FHIR instance.
 *
 * Prerequisite: resources must be tagged on write with the org tag
 * (e.g., `meta.tag = [{ system: ORG_TAG_SYSTEM, code: "org-id" }]`).
 */
export function applyQueryIsolation(
  tenant: TenantContext,
  resourcePath: string,
  method: string,
  queryString: string,
): string {
  if (!isQueryIsolationEnabled()) return queryString
  if (!tenant.organizationId) return queryString

  // Only apply to search requests (GET on resource type without specific ID)
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

// ── Combined Middleware ──────────────────────────────────────────────────────

/**
 * Full tenant isolation check — combines org routing enforcement
 * and query-level isolation into a single call for the FHIR proxy.
 */
export function enforceTenantIsolation(
  serverInfo: FHIRServerInfo,
  tokenPayload: Record<string, unknown>,
  resourcePath: string,
  method: string,
  queryString: string,
): TenantCheckResult {
  const tenant = resolveOrganization(tokenPayload)

  // 1. Verify the user's org is allowed to access this server
  const routingResult = enforceOrgServerAccess(serverInfo, tenant)
  if (!routingResult.allowed) {
    return routingResult
  }

  // 2. Inject org-scoped query filter if enabled
  const modifiedQueryString = applyQueryIsolation(tenant, resourcePath, method, queryString)

  return {
    allowed: true,
    tenant,
    modifiedQueryString,
  }
}
