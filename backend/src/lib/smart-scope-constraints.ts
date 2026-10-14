// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// SMART 2.0 search-parameter constraints on scopes; whatever cannot be evaluated is refused.

import { normalizeSearchParams, parseFhirPath, type ServerCapabilities } from './fhir-capabilities'
import { bundleEntryCount, upstreamFhirQuery } from './fhir-upstream-query'
import { resourceMatchesToken } from './fhir-token-match'
import { logger } from './logger'
import { getRuntimeAccessControlConfig } from './runtime-config'
import { isRecord, parseJson } from './type-guards'
import { resolveScopeOperation, type ConstraintParam, type ScopeConstraint } from './smart-scope-grants'
import { INSUFFICIENT_SCOPE, refusal, refusedResult, upstreamUnverifiable, type AccessDecision } from './access-decision'
import type { AccessControlContext, AccessControlResult } from './smart-access-control'

export interface ConstraintRequest {
  queryString: string
  body?: string
  capabilities?: ServerCapabilities | null
}

type Decision = AccessDecision<{ queryString: string }>

const UNCONFINABLE_PARAM_RE = /^_(rev)?include(:|$)|^_contained(Type)?$/

export function describeConstraints(constraints: ScopeConstraint[]): string {
  return constraints.map((c) => c.params.map(([name, value]) => `${name}=${value}`).join('&')).join(' or ')
}

function queryParams(queryString: string): URLSearchParams {
  return new URLSearchParams(queryString.startsWith('?') ? queryString.slice(1) : queryString)
}

/** Some occurrence of the param asks for nothing outside the constraint's alternatives. */
function isSatisfied(query: URLSearchParams, params: ConstraintParam[]): boolean {
  return params.every(([name, value]) => {
    const allowed = new Set(value.split(','))
    return query.getAll(name).some((occurrence) => occurrence.split(',').every((v) => allowed.has(v)))
  })
}

/** The union of several constraints as one search, when FHIR's `,` (OR) can express it. */
function unionAsSearch(constraints: ScopeConstraint[]): ConstraintParam[] | null {
  if (constraints.length === 1) return constraints[0].params
  const names = new Set(constraints.map((c) => (c.params.length === 1 ? c.params[0][0] : '')))
  const [name] = [...names]
  if (names.size !== 1 || !name) return null
  const values = new Set(constraints.flatMap((c) => c.params[0][1].split(',')))
  return [[name, [...values].join(',')]]
}

/** Adds the constraint unless the query already asks for no more; FHIR ANDs repeated params. */
export function constrainSearchQuery(
  queryString: string,
  constraints: ScopeConstraint[],
): { ok: true; queryString: string } | { ok: false; reason: string } {
  const query = queryParams(queryString)
  const unconfinable = [...query.keys()].find((key) => UNCONFINABLE_PARAM_RE.test(key))
  if (unconfinable) {
    return { ok: false, reason: `${unconfinable} can return resources outside the scope's constraint (${describeConstraints(constraints)}), so it is not accepted under a constrained scope.` }
  }
  if (constraints.some((c) => isSatisfied(query, c.params))) return { ok: true, queryString }

  const union = unionAsSearch(constraints)
  if (!union) {
    return { ok: false, reason: `Access is limited to ${describeConstraints(constraints)}. Add one of these to the search.` }
  }
  let constrained = queryString
  for (const [name, value] of union) {
    if (isSatisfied(query, [[name, value]])) continue
    constrained += `${constrained.length > 1 ? '&' : constrained ? '' : '?'}${encodeURIComponent(name)}=${encodeURIComponent(value)}`
  }
  return { ok: true, queryString: constrained }
}

/** Whether the resource body satisfies one of the constraints; params it cannot evaluate never match. */
export function resourceSatisfiesConstraints(resource: Record<string, unknown>, constraints: ScopeConstraint[]): boolean {
  return constraints.some((c) => c.params.every(([name, value]) => resourceMatchesToken(resource, name, value) === true))
}

function upstreamDeclares(capabilities: ServerCapabilities | null | undefined, resourceType: string, params: ConstraintParam[]): boolean {
  if (!capabilities) return true
  const qs = params.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')
  const normalized = normalizeSearchParams(capabilities, resourceType, qs)
  return normalized.supported && normalized.strippedParams.length === 0
}

/** True if the stored resource matches a constraint, false if it does not, null if that cannot be told. */
async function storedResourceMatches(
  ctx: AccessControlContext,
  req: ConstraintRequest,
  resourceType: string,
  id: string,
  constraints: ScopeConstraint[],
): Promise<boolean | null> {
  let undecided = false
  for (const constraint of constraints) {
    if (!upstreamDeclares(req.capabilities, resourceType, constraint.params)) {
      undecided = true
      continue
    }
    const params = constraint.params.map(([n, v]) => `&${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('')
    const url = `${ctx.serverUrl}/${resourceType}?_id=${encodeURIComponent(id)}${params}&_format=json`
    const bundle = await upstreamFhirQuery(ctx, url, 'scope constraint check')
    if (bundle === null) undecided = true
    else if (bundleEntryCount(bundle) > 0) return true
  }
  return undecided ? null : false
}

async function storedResourceExists(ctx: AccessControlContext, resourceType: string, id: string): Promise<boolean | null> {
  const url = `${ctx.serverUrl}/${resourceType}?_id=${encodeURIComponent(id)}&_format=json`
  const bundle = await upstreamFhirQuery(ctx, url, 'scope constraint existence check')
  return bundle === null ? null : bundleEntryCount(bundle) > 0
}

function parseBody(body: string | undefined): Record<string, unknown> | null {
  const parsed = parseJson(body)
  return isRecord(parsed) ? parsed : null
}

function checkBody(req: ConstraintRequest, resourceType: string, constraints: ScopeConstraint[]): Decision | null {
  const resource = parseBody(req.body)
  if (!resource || resource.resourceType !== resourceType) {
    return refusal(`A write under a constrained scope needs a JSON ${resourceType} body to check against ${describeConstraints(constraints)}.`, INSUFFICIENT_SCOPE)
  }
  if (!resourceSatisfiesConstraints(resource, constraints)) {
    return refusal(`The ${resourceType} does not satisfy the scope's constraint (${describeConstraints(constraints)}), or the constraint cannot be evaluated on a resource body.`, INSUFFICIENT_SCOPE)
  }
  return null
}

function unverifiable(stored: boolean | null, label: string, constraints: ScopeConstraint[]): Decision | null {
  if (stored === true) return null
  if (stored === null) return upstreamUnverifiable(`Could not verify ${label} against the scope's constraint upstream.`)
  return refusal(`${label} is outside the scope's constraint (${describeConstraints(constraints)}).`, INSUFFICIENT_SCOPE)
}

async function decide(ctx: AccessControlContext, req: ConstraintRequest, constraints: ScopeConstraint[]): Promise<Decision> {
  const path = parseFhirPath(ctx.resourcePath, ctx.method)
  const resourceType = path.resourceType
  if (!resourceType) return refusal('This request cannot be checked against a constrained scope.', INSUFFICIENT_SCOPE)

  if (resolveScopeOperation(ctx.method, ctx.resourcePath).isSearch && !path.isOperation && !path.isHistory) {
    const constrained = constrainSearchQuery(req.queryString, constraints)
    return constrained.ok ? { allowed: true, queryString: constrained.queryString } : refusal(constrained.reason, INSUFFICIENT_SCOPE)
  }
  if (path.isOperation || path.isHistory || path.compartmentType) {
    return refusal('Operations and history cannot be checked against a constrained scope; an unconstrained scope is needed.', INSUFFICIENT_SCOPE)
  }

  const id = path.isInstance ? path.resourceId : null
  const label = `${resourceType}/${id ?? ''}`
  if (ctx.method === 'POST' && !id) {
    return checkBody(req, resourceType, constraints) ?? { allowed: true, queryString: req.queryString }
  }
  if (!id || req.queryString.length > 1) {
    return refusal('Conditional writes cannot be checked against a constrained scope.', INSUFFICIENT_SCOPE)
  }
  if (ctx.method === 'GET' || ctx.method === 'DELETE') {
    const stored = await storedResourceMatches(ctx, req, resourceType, id, constraints)
    return unverifiable(stored, label, constraints) ?? { allowed: true, queryString: req.queryString }
  }
  if (ctx.method === 'PUT') {
    const bodyRefusal = checkBody(req, resourceType, constraints)
    if (bodyRefusal) return bodyRefusal
    const stored = await storedResourceMatches(ctx, req, resourceType, id, constraints)
    const allow: Decision = { allowed: true, queryString: req.queryString }
    if (stored !== false) return unverifiable(stored, label, constraints) ?? allow
    const exists = await storedResourceExists(ctx, resourceType, id)
    if (exists === false) return allow
    return unverifiable(exists === null ? null : false, label, constraints) ?? allow
  }
  return refusal(`${ctx.method} cannot be checked against a constrained scope; an unconstrained scope is needed.`, INSUFFICIENT_SCOPE)
}

/** Runs after enforceScopeAccess granted the request through constrained scopes only. */
export async function enforceScopeConstraints(
  ctx: AccessControlContext,
  req: ConstraintRequest,
  constraints: ScopeConstraint[],
): Promise<AccessControlResult> {
  const mode = getRuntimeAccessControlConfig().scopeEnforcement
  const decision = await decide(ctx, req, constraints)
  const changed = decision.allowed && decision.queryString !== req.queryString
  if (!decision.allowed || (changed && mode !== 'enforce')) {
    logger.fhir.warn(decision.allowed ? 'Scope constraint would narrow the search' : 'Scope constraint not satisfied', {
      method: ctx.method,
      resourcePath: ctx.resourcePath,
      constraints: describeConstraints(constraints),
      server: ctx.serverName,
      mode,
      ...(!decision.allowed && { reason: decision.message }),
    })
  }
  if (mode !== 'enforce') return { allowed: true, modifiedQueryString: req.queryString }
  if (!decision.allowed) return refusedResult(decision)
  return { allowed: true, modifiedQueryString: decision.queryString }
}
