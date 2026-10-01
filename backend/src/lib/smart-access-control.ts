// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART on FHIR Access Control
 *
 * Three independent, opt-in access control features for the FHIR proxy:
 *
 * 1. **SMART Scope Enforcement** — validates token scopes against requested resources
 *    (supports SMART v1 `read`/`write` and v2 `cruds` character formats)
 *
 * 2. **Role-Based Data Isolation** — two compartment rules, both governed by
 *    ROLE_BASED_FILTERING_MODE:
 *      a) a `patient/`-scoped grant is confined to one patient, whoever the user
 *         is (SMART: "If the app has any patient-level scopes, they will be
 *         scoped to Patient 123"), resolved by `resolveTokenPatient`
 *      b) a user who IS a patient (`fhirUser: Patient/…`) sees only their own data
 *
 * SCOPE_ENFORCEMENT_MODE defaults to `enforce`; ROLE_BASED_FILTERING_MODE defaults
 * to `audit-only`, where rule (a) logs what enforcement would change instead of
 * changing it. Set either to `disabled`, `audit-only` or `enforce`.
 */

import { hasPatientCompartmentScope, parseScopes } from '@proxy-smart/auth'
import { logger } from './logger'
import { getRuntimeAccessControlConfig } from './runtime-config'
import { normalizeFhirUser, resolveTokenPatient } from './patient-context'
import { ERASE_OPERATION } from './fhir-erasure'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AccessControlContext {
  /** Raw token payload from JWT validation */
  tokenPayload: Record<string, unknown>
  /** The FHIR resource path (e.g. "Patient/123", "Observation") */
  resourcePath: string
  /** HTTP method */
  method: string
  /** Upstream FHIR server base URL */
  serverUrl: string
  /** Server identifier (for mTLS config lookup) */
  serverId: string
  /** Server name (for logging) */
  serverName: string
  /** Original Authorization header value */
  authHeader: string
  /** Function to perform upstream FHIR fetch (mTLS-aware) */
  upstreamFetch: (url: string, init?: RequestInit) => Promise<Response>
}

export interface AccessControlResult {
  /** Whether to allow the request to proceed */
  allowed: boolean
  /** HTTP status code if denied */
  status?: number
  /** Error response body if denied */
  body?: Record<string, unknown>
  /** Modified query string (role-based filtering may inject search params) */
  modifiedQueryString?: string
}

// ── SMART Scope Enforcement ──────────────────────────────────────────────────

/** Map HTTP methods to SMART v2 permission characters */
const METHOD_TO_V2_CHAR: Record<string, string> = {
  GET: 'r',
  POST: 'c',
  PUT: 'u',
  PATCH: 'u',
  DELETE: 'd',
}

/**
 * Determine the effective operation kind from HTTP method and resource path.
 * POST to `_search` is a search operation, not a create.
 */
function resolveOperation(method: string, resourcePath: string): { effectiveMethod: string; isSearch: boolean } {
  // POST _search (e.g. "Patient/_search") is a search, not a create
  if (method === 'POST' && /_search(\?|$)/.test(resourcePath)) {
    return { effectiveMethod: 'GET', isSearch: true }
  }
  if (method === 'POST' && resourcePath.split('?')[0].endsWith(`/$${ERASE_OPERATION}`)) {
    return { effectiveMethod: 'DELETE', isSearch: false }
  }
  // GET with query params or bare resource type (no id) is a search
  const pathParts = resourcePath.split(/[?]/)[0].split('/')
  if (method === 'GET' && (resourcePath.includes('?') || pathParts.length === 1)) {
    return { effectiveMethod: 'GET', isSearch: true }
  }
  // GET with a resource id is a read
  return { effectiveMethod: method, isSearch: false }
}

/**
 * Check whether token scopes grant the requested access.
 * Supports SMART v1 (`read`/`write`/`*`) and v2 (`cruds` character) formats.
 */
function checkSmartScopes(
  tokenScopes: string[],
  resourceType: string,
  method: string,
  resourcePath: string,
): boolean {
  const { effectiveMethod, isSearch } = resolveOperation(method, resourcePath)
  const requiredChar = isSearch ? 's' : METHOD_TO_V2_CHAR[effectiveMethod]
  const isRead = effectiveMethod === 'GET'
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(effectiveMethod)

  return tokenScopes.some((scope) => {
    // Match SMART scope pattern: context/resource.permissions
    const match = scope.match(/^(patient|user|system|agent)\/([\w*]+)\.([\w*]+)$/)
    if (!match) return false
    const [, , scopeResource, scopePermission] = match

    // Check resource type match
    if (scopeResource !== '*' && scopeResource !== resourceType) return false

    // Check permission match
    if (scopePermission === '*') return true

    // SMART v1 format
    if (isRead && scopePermission === 'read') return true
    if (isWrite && scopePermission === 'write') return true

    // SMART v2 format — exact character matching
    // v2 permissions are a strict subset of "cruds" characters; r and s are distinct.
    if (scopePermission.length <= 5 && /^[cruds]+$/.test(scopePermission)) {
      if (requiredChar && scopePermission.includes(requiredChar)) return true
    }

    return false
  })
}

export function enforceScopeAccess(ctx: AccessControlContext): AccessControlResult {
  const ac = getRuntimeAccessControlConfig()
  if (ac.scopeEnforcement === 'disabled') {
    return { allowed: true }
  }

  const tokenScopes = ((ctx.tokenPayload.scope as string) || '').split(' ').filter(Boolean)
  const resourceType = ctx.resourcePath.split(/[/?]/)[0]

  // Skip scope checks for metadata endpoint and empty resource types
  if (!resourceType || resourceType === 'metadata') {
    return { allowed: true }
  }

  const hasAccess = checkSmartScopes(tokenScopes, resourceType, ctx.method, ctx.resourcePath)

  if (!hasAccess) {
    logger.fhir.warn('SMART scope check failed', {
      resourceType,
      method: ctx.method,
      scopes: tokenScopes.join(' '),
      fhirUser: ctx.tokenPayload.fhirUser,
      server: ctx.serverName,
      mode: ac.scopeEnforcement,
    })

    if (ac.scopeEnforcement === 'enforce') {
      return {
        allowed: false,
        status: 403,
        body: {
          error: 'insufficient_scope',
          message: `Token does not grant ${ctx.method} access to ${resourceType}. Required scope: patient/${resourceType}.rs, user/${resourceType}.rs, system/${resourceType}.rs, or agent/${resourceType}.rs (or equivalent).`,
        },
      }
    }
    // audit-only: log but allow
  }

  return { allowed: true }
}

// ── Role-Based Filtering ─────────────────────────────────────────────────────

/**
 * Perform an upstream FHIR fetch with proper auth/mTLS, checking response status.
 * Returns the parsed JSON bundle or null on failure.
 */
/**
 * Entry count of an upstream FHIR Bundle, 0 when absent or not a list.
 *
 * The read used to be `bundle.entry?.length` through a `Record<string, any>`, which
 * silently yielded undefined for a non-array `entry` and was then treated as empty —
 * i.e. as "not found". Same outcome, but stated rather than assumed.
 */
function bundleEntryCount(bundle: Record<string, unknown>): number {
  const entry = bundle.entry
  return Array.isArray(entry) ? entry.length : 0
}

async function upstreamFhirQuery(
  ctx: AccessControlContext,
  url: string,
  description: string,
): Promise<Record<string, unknown> | null> {
  try {
    const headers: Record<string, string> = { Accept: 'application/fhir+json' }
    if (ctx.authHeader) {
      headers.Authorization = ctx.authHeader
    }

    const resp = await ctx.upstreamFetch(url, { method: 'GET', headers })

    if (!resp.ok) {
      logger.fhir.warn(`Upstream ${description} failed`, {
        server: ctx.serverName,
        status: resp.status,
        statusText: resp.statusText,
      })
      return null
    }

    return await resp.json()
  } catch (err) {
    logger.fhir.error(`Upstream ${description} error`, {
      server: ctx.serverName,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export async function enforceRoleBasedFiltering(
  ctx: AccessControlContext,
  queryString: string,
): Promise<AccessControlResult> {
  const ac = getRuntimeAccessControlConfig()
  if (ac.roleBasedFiltering === 'disabled') {
    return { allowed: true, modifiedQueryString: queryString }
  }

  const resourceType = ctx.resourcePath.split(/[/?]/)[0]
  const patientScopedResources = ac.patientScopedResources
  const isEnforce = ac.roleBasedFiltering === 'enforce'

  // ── 1. Patient-compartment grants ──────────────────────────────────────────
  // A `patient/` scope is restricted to a single patient, and SMART names the
  // `patient` launch context as the patient it is restricted to: "If the app has
  // any patient-level scopes, they will be scoped to Patient 123." So the
  // compartment comes from that claim — for every user type, not only when the
  // user happens to BE the patient.
  const grantedScopes = parseScopes(ctx.tokenPayload.scope as string | undefined)
  if (hasPatientCompartmentScope(grantedScopes)) {
    const resolved = resolveTokenPatient(ctx.tokenPayload)

    if (!resolved) {
      // The grant is confined to one patient but nothing says which, so the
      // confinement is undefined. Enforcing means refusing; audit-only records
      // what enforcement would have refused.
      logger.fhir.warn('Patient-scoped token carries no patient context', {
        resourceType,
        method: ctx.method,
        scopes: [...grantedScopes].join(' '),
        fhirUser: ctx.tokenPayload.fhirUser,
        server: ctx.serverName,
        mode: ac.roleBasedFiltering,
        wouldDeny: !isEnforce,
      })

      if (isEnforce) {
        return {
          allowed: false,
          status: 403,
          body: {
            error: 'access_denied',
            message: 'This token grants patient-scoped access but carries no patient context, so the patient it is scoped to cannot be determined.',
          },
        }
      }
      return { allowed: true, modifiedQueryString: queryString }
    }

    // Reuses the same compartment logic as patient users below; only the source
    // of the patient id differs.
    const compartment = normalizeFhirUser(
      resolved.patient.includes('/') ? resolved.patient : `Patient/${resolved.patient}`,
    )
    if (!isEnforce) {
      logger.fhir.info('Patient-compartment filtering skipped (audit-only)', {
        compartment,
        source: resolved.source,
        resourceType,
        method: ctx.method,
        server: ctx.serverName,
      })
      return { allowed: true, modifiedQueryString: queryString }
    }
    return enforcePatientFiltering(ctx, queryString, compartment, resourceType, patientScopedResources, isEnforce)
  }

  // ── 2. Patient users, regardless of which scopes they hold ─────────────────
  const rawFhirUser = ctx.tokenPayload.fhirUser as string | undefined
  if (!rawFhirUser) {
    // Nothing identifies a subject to filter on. Logged because this silently
    // disables the compartment restriction that would otherwise apply.
    logger.fhir.debug('No fhirUser claim — no compartment filtering applied', {
      resourceType,
      method: ctx.method,
      server: ctx.serverName,
    })
    return { allowed: true, modifiedQueryString: queryString }
  }

  const fhirUser = normalizeFhirUser(rawFhirUser)

  if (fhirUser.startsWith('Patient/')) {
    return enforcePatientFiltering(ctx, queryString, fhirUser, resourceType, patientScopedResources, isEnforce)
  }

  // Practitioners and other user types without a patient-scoped grant pass
  // through: `user/` scopes are not compartment-restricted.
  return { allowed: true, modifiedQueryString: queryString }
}

async function enforcePatientFiltering(
  ctx: AccessControlContext,
  queryString: string,
  fhirUser: string,
  resourceType: string,
  patientScopedResources: string[],
  isEnforce: boolean,
): Promise<AccessControlResult> {
  const ownPatientId = fhirUser.split('/')[1]

  // Patient search: restrict to own record
  if (ctx.method === 'GET' && /^Patient(\?|$)/.test(ctx.resourcePath)) {
    const sep = queryString ? '&' : '?'
    queryString += `${sep}_id=${encodeURIComponent(ownPatientId)}`
    return { allowed: true, modifiedQueryString: queryString }
  }

  // Direct Patient read by ID: deny if different patient
  const patientDirectMatch = ctx.resourcePath.match(/^Patient\/([^/]+)/)
  if (ctx.method === 'GET' && patientDirectMatch) {
    const patientId = patientDirectMatch[1]
    if (patientId !== '$' && !patientId.startsWith('$') && patientId !== ownPatientId) {
      logger.fhir.warn('Patient access denied to other patient', { fhirUser, requestedPatient: patientId, server: ctx.serverName })
      if (isEnforce) {
        return { allowed: false, status: 403, body: { error: 'access_denied', message: 'You can only access your own patient record' } }
      }
    }
    return { allowed: true, modifiedQueryString: queryString }
  }

  // Patient-scoped resource search: filter to own data
  if (ctx.method === 'GET' && patientScopedResources.includes(resourceType) && !ctx.resourcePath.includes('/')) {
    const sep = queryString ? '&' : '?'
    queryString += `${sep}patient=Patient/${encodeURIComponent(ownPatientId)}`
    return { allowed: true, modifiedQueryString: queryString }
  }

  // Patient-scoped resource direct read by ID: verify ownership
  if (ctx.method === 'GET' && patientScopedResources.includes(resourceType) && ctx.resourcePath.includes('/')) {
    const idMatch = ctx.resourcePath.match(/^[^/]+\/([^/?]+)/)
    const resourceId = idMatch?.[1]
    if (resourceId && resourceId !== '$' && !resourceId.startsWith('$')) {
      const checkUrl = `${ctx.serverUrl}/${resourceType}?_id=${encodeURIComponent(resourceId)}&patient=Patient/${encodeURIComponent(ownPatientId)}&_format=json`
      const checkBundle = await upstreamFhirQuery(ctx, checkUrl, 'patient resource ownership check')

      if (checkBundle === null) {
        if (isEnforce) {
          return {
            allowed: false,
            status: 502,
            body: { error: 'upstream_error', message: 'Failed to validate resource ownership on upstream FHIR server' },
          }
        }
      } else if (bundleEntryCount(checkBundle) === 0) {
        logger.fhir.warn('Patient access denied to unowned resource', {
          fhirUser, resourceType, resourceId, server: ctx.serverName,
        })
        if (isEnforce) {
          return {
            allowed: false,
            status: 403,
            body: { error: 'access_denied', message: `${resourceType}/${resourceId} does not belong to your patient record` },
          }
        }
      }
    }
  }

  return { allowed: true, modifiedQueryString: queryString }
}
