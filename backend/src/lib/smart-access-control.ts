// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART scope enforcement, and role-based data isolation (ROLE_BASED_FILTERING_MODE): a `patient/`
 * grant, or a user who is a patient, is confined to one patient's compartment for reads and writes.
 */

import { hasPatientCompartmentScope, hasUserLevelScope, parseTokenScopes } from '@proxy-smart/auth'
import { refusal, refusedResult } from './access-decision'
import { logger } from './logger'
import { getRuntimeAccessControlConfig } from './runtime-config'
import { normalizeFhirUser, resolveTokenPatientViaPerson } from './patient-context'
import { resolveFhirUserForClient } from './consent/person-resolver'
import { resolveScopeGrant, resolveScopeOperation, scopedResourceType, type ScopeConstraint } from './smart-scope-grants'
import { confinePatientWrite, isCompartmentWrite, type WriteRequest } from './patient-compartment/write-confinement'
import { confinePatientRead } from './patient-compartment/read-confinement'
import type { UpstreamFetch } from './upstream-fetch'

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
  upstreamFetch: UpstreamFetch
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
      ? refusedResult(refusal(message, error))
      : { allowed: true }
  }

  // A Bundle at the base is authorised entry by entry (fhir-bundle-access), never as a whole.
  if (!resourceType) {
    if (ctx.method !== 'GET' && !resolveScopeOperation(ctx.method, ctx.resourcePath).isSearch) {
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
  write: WriteRequest = {},
): Promise<AccessControlResult> {
  const ac = getRuntimeAccessControlConfig()
  if (ac.roleBasedFiltering === 'disabled') {
    return { allowed: true, modifiedQueryString: queryString }
  }

  const resourceType = ctx.resourcePath.split(/[/?]/)[0]
  const isEnforce = ac.roleBasedFiltering === 'enforce'
  const isWrite = isCompartmentWrite(ctx.method, ctx.resourcePath)
  const confine = (compartment: string) => isWrite
    ? confinePatientWrite(ctx, queryString, write, compartment, isEnforce)
    : confinePatientRead(ctx, queryString, compartment, { narrow: isEnforce, refuse: isEnforce })
  // A patient user's searches were narrowed before patient grants were confined; audit-only keeps that.
  const confineUser = (compartment: string) => isWrite
    ? confinePatientWrite(ctx, queryString, write, compartment, isEnforce)
    : confinePatientRead(ctx, queryString, compartment, { narrow: true, refuse: isEnforce })

  // ── 1. Patient-compartment grants: SMART scopes them to the launch patient, whoever the user is ─
  const grantedScopes = parseTokenScopes(ctx.tokenPayload)
  if (hasPatientCompartmentScope(grantedScopes)) {
    const resolved = await resolveTokenPatientViaPerson(
      ctx.tokenPayload, { url: ctx.serverUrl, identifier: ctx.serverId }, ctx.authHeader,
    )

    if (!resolved) {
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

    return confine(normalizeFhirUser(
      resolved.patient.includes('/') ? resolved.patient : `Patient/${resolved.patient}`,
    ))
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
    return confineUser(fhirUser)
  }

  if (fhirUser.startsWith('Practitioner/') || fhirUser.startsWith('PractitionerRole/') || !userLevel) {
    return { allowed: true, modifiedQueryString: queryString }
  }

  if (fhirUser.startsWith('Person/')) {
    const linkedPatient = await resolveFhirUserForClient(rawFhirUser, true, ctx.serverUrl, ctx.serverId, ctx.authHeader)
    if (linkedPatient) {
      return confineUser(normalizeFhirUser(linkedPatient))
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
  return refusedResult(refusal('This account is not linked to a patient record, so there is no data it may access.'))
}
