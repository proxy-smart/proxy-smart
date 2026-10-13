// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART on FHIR Access Control
 *
 * Three independent, opt-in access control features for the FHIR proxy:
 *
 * 1. **SMART Scope Enforcement** — validates token scopes against requested resources
 *    (SMART v1 `read`/`write`, v2 `cruds`, and v2 search-parameter constraints)
 *
 * 2. **Role-Based Data Isolation** — two compartment rules, both governed by
 *    ROLE_BASED_FILTERING_MODE:
 *      a) a `patient/`-scoped grant is confined to one patient, whoever the user
 *         is (SMART: "If the app has any patient-level scopes, they will be
 *         scoped to Patient 123"), resolved by `resolveTokenPatientViaPerson`
 *      b) a user who IS a patient (`fhirUser: Patient/…`) sees only their own data
 *
 * SCOPE_ENFORCEMENT_MODE defaults to `enforce`; ROLE_BASED_FILTERING_MODE defaults
 * to `audit-only`, where rule (a) logs what enforcement would change instead of
 * changing it. Set either to `disabled`, `audit-only` or `enforce`.
 */

import { hasPatientCompartmentScope, hasUserLevelScope, parseTokenScopes } from '@proxy-smart/auth'
import { logger } from './logger'
import { getRuntimeAccessControlConfig } from './runtime-config'
import { normalizeFhirUser, resolveTokenPatientViaPerson } from './patient-context'
import { resolveFhirUserForClient } from './consent/person-resolver'
import { bundleEntryCount, upstreamFhirQuery } from './fhir-upstream-query'
import { resolveScopeGrant, scopedResourceType, type ScopeConstraint } from './smart-scope-grants'

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
  /** Set when only SMART 2.0 constrained scopes grant the request; see enforceScopeConstraints */
  scopeConstraints?: ScopeConstraint[]
}

// ── SMART Scope Enforcement ──────────────────────────────────────────────────

export function enforceScopeAccess(ctx: AccessControlContext): AccessControlResult {
  const ac = getRuntimeAccessControlConfig()
  if (ac.scopeEnforcement === 'disabled') {
    return { allowed: true }
  }

  const tokenScopes = [...parseTokenScopes(ctx.tokenPayload)]
  const resourceType = scopedResourceType(ctx.resourcePath, ctx.method)

  if (resourceType === 'metadata') {
    return { allowed: true }
  }

  const deny = (error: string, message: string): AccessControlResult => {
    logger.fhir.warn('SMART scope check failed', {
      resourceType: resourceType || '(server base)',
      method: ctx.method,
      scopes: tokenScopes.join(' '),
      fhirUser: ctx.tokenPayload.fhirUser,
      server: ctx.serverName,
      mode: ac.scopeEnforcement,
    })
    return ac.scopeEnforcement === 'enforce'
      ? { allowed: false, status: 403, body: { error, message } }
      : { allowed: true }
  }

  // A Bundle at the base is authorised entry by entry (fhir-bundle-access), never as a whole.
  if (!resourceType) {
    if (ctx.method !== 'GET') {
      return deny('batch_not_permitted', 'A request at the server base other than a search is only accepted as a batch or transaction Bundle, which is authorised per entry.')
    }
    return resolveScopeGrant(tokenScopes, '*', ctx.method, ctx.resourcePath).kind === 'full'
      ? { allowed: true }
      : deny('insufficient_scope', 'A search across all resource types requires an unconstrained wildcard resource scope, e.g. system/*.rs.')
  }

  const grant = resolveScopeGrant(tokenScopes, resourceType, ctx.method, ctx.resourcePath)
  if (grant.kind === 'full') return { allowed: true }
  if (grant.kind === 'constrained') return { allowed: true, scopeConstraints: grant.constraints }
  return deny(
    'insufficient_scope',
    `Token does not grant ${ctx.method} access to ${resourceType}. Required scope: patient/${resourceType}.rs, user/${resourceType}.rs, system/${resourceType}.rs, or agent/${resourceType}.rs (or equivalent).`,
  )
}

// ── Role-Based Filtering ─────────────────────────────────────────────────────

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
  const grantedScopes = parseTokenScopes(ctx.tokenPayload)
  if (hasPatientCompartmentScope(grantedScopes)) {
    const resolved = await resolveTokenPatientViaPerson(
      ctx.tokenPayload, { url: ctx.serverUrl, identifier: ctx.serverId }, ctx.authHeader,
    )

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

  // ── 2. User-level grants: the user's own record, unless they are a practitioner ─
  const rawFhirUser = typeof ctx.tokenPayload.fhirUser === 'string' ? ctx.tokenPayload.fhirUser : undefined
  const userLevel = hasUserLevelScope(grantedScopes)

  if (!rawFhirUser) {
    if (!userLevel) {
      logger.fhir.debug('No fhirUser claim — no compartment filtering applied', {
        resourceType,
        method: ctx.method,
        server: ctx.serverName,
      })
      return { allowed: true, modifiedQueryString: queryString }
    }
    return refuseUnconfined(ctx, resourceType, isEnforce, queryString, 'user-level grant without fhirUser')
  }

  const fhirUser = normalizeFhirUser(rawFhirUser)

  if (fhirUser.startsWith('Patient/')) {
    return enforcePatientFiltering(ctx, queryString, fhirUser, resourceType, patientScopedResources, isEnforce)
  }

  if (fhirUser.startsWith('Practitioner/') || fhirUser.startsWith('PractitionerRole/') || !userLevel) {
    return { allowed: true, modifiedQueryString: queryString }
  }

  if (fhirUser.startsWith('Person/')) {
    const linkedPatient = await resolveFhirUserForClient(rawFhirUser, true, ctx.serverUrl, ctx.serverId, ctx.authHeader)
    if (linkedPatient) {
      return enforcePatientFiltering(ctx, queryString, normalizeFhirUser(linkedPatient), resourceType, patientScopedResources, isEnforce)
    }
    const linkedPractitioner = await resolveFhirUserForClient(rawFhirUser, false, ctx.serverUrl, ctx.serverId, ctx.authHeader)
    if (linkedPractitioner) return { allowed: true, modifiedQueryString: queryString }
    if (ctx.method === 'GET' && ctx.resourcePath.replace(/[?#].*$/, '') === fhirUser) {
      return { allowed: true, modifiedQueryString: queryString }
    }
  }

  return refuseUnconfined(ctx, resourceType, isEnforce, queryString, `user-level grant for ${fhirUser.split('/')[0]} with no linked Patient`)
}

/** A user-level grant with no patient to confine it to and no practitioner role reaches no data. */
function refuseUnconfined(
  ctx: AccessControlContext,
  resourceType: string,
  isEnforce: boolean,
  queryString: string,
  reason: string,
): AccessControlResult {
  logger.fhir.warn('User-level grant has nothing to confine it to', {
    reason,
    resourceType,
    method: ctx.method,
    server: ctx.serverName,
    wouldDeny: !isEnforce,
  })
  if (!isEnforce) return { allowed: true, modifiedQueryString: queryString }
  return {
    allowed: false,
    status: 403,
    body: {
      error: 'access_denied',
      message: 'This account is not linked to a patient record, so there is no data it may access.',
    },
  }
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
