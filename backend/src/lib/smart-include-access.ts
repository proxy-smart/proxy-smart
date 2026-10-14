// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// `_include` and `_revinclude` return resources of other types, which the token must be able to read too.

import { parseTokenScopes } from '@proxy-smart/auth'
import { logger } from './logger'
import { getRuntimeAccessControlConfig } from './runtime-config'
import { resolveScopeGrant, resolveScopeOperation } from './smart-scope-grants'
import type { AccessControlResult } from './smart-access-control'

export interface IncludeRequest {
  method: string
  resourcePath: string
  queryString: string
  body?: string
  headers?: Headers
}

const INCLUDE_PARAM_RE = /^_(rev)?include(:(iterate|recurse))?$/
const ANY_TYPE = '*'

/** R4 reference search parameters whose only target type is fixed by their name. */
const SINGLE_TARGET_PARAMS: ReadonlyMap<string, string> = new Map([
  ['patient', 'Patient'],
  ['medication', 'Medication'],
])

function requestParams(req: IncludeRequest): URLSearchParams {
  const params = new URLSearchParams(req.queryString.startsWith('?') ? req.queryString.slice(1) : req.queryString)
  const contentType = req.headers?.get('content-type') ?? 'application/x-www-form-urlencoded'
  const isFormSearch = req.method === 'POST' && resolveScopeOperation(req.method, req.resourcePath).isSearch
  if (isFormSearch && req.body && contentType.startsWith('application/x-www-form-urlencoded')) {
    for (const [name, value] of new URLSearchParams(req.body)) params.append(name, value)
  }
  return params
}

/** The type an include returns, or null when its value does not name one. */
function returnedType(param: string, value: string): string | null {
  const [source, searchParam, target] = value.split(':')
  if (value === ANY_TYPE || !source || source === ANY_TYPE || !searchParam) return null
  if (param.startsWith('_revinclude')) return source
  if (target) return target === ANY_TYPE ? null : target
  return SINGLE_TARGET_PARAMS.get(searchParam) ?? null
}

function canRead(tokenScopes: string[], resourceType: string): boolean {
  return resolveScopeGrant(tokenScopes, resourceType, 'GET', `${resourceType}/id`).kind === 'full'
    || resolveScopeGrant(tokenScopes, resourceType, 'GET', resourceType).kind === 'full'
}

/** Why each include in the request reaches past the token's scopes; empty when none does. */
export function includeRefusals(tokenScopes: Iterable<string>, req: IncludeRequest): string[] {
  const scopes = [...tokenScopes]
  const refusals: string[] = []
  for (const [param, value] of requestParams(req)) {
    if (!INCLUDE_PARAM_RE.test(param)) continue
    const type = returnedType(param, value)
    if (type === null) {
      if (!canRead(scopes, ANY_TYPE)) {
        refusals.push(`${param}=${value} does not name the type it returns; name it (e.g. Observation:subject:Patient) or hold an unconstrained wildcard read scope.`)
      }
    } else if (!canRead(scopes, type)) {
      refusals.push(`${param}=${value} returns ${type}, which the token has no unconstrained scope to read.`)
    }
  }
  return refusals
}

/** Governed by SCOPE_ENFORCEMENT_MODE: an include is a read of the types it returns. */
export function enforceIncludeAccess(tokenPayload: Record<string, unknown>, req: IncludeRequest, serverName: string): AccessControlResult {
  const mode = getRuntimeAccessControlConfig().scopeEnforcement
  if (mode === 'disabled') return { allowed: true }
  const refusals = includeRefusals(parseTokenScopes(tokenPayload), req)
  if (refusals.length === 0) return { allowed: true }

  logger.fhir.warn('Include reaches past the token scopes', {
    resourcePath: req.resourcePath,
    method: req.method,
    refusals,
    server: serverName,
    mode,
    wouldDeny: mode !== 'enforce',
  })
  if (mode !== 'enforce') return { allowed: true }
  return { allowed: false, status: 403, body: { error: 'insufficient_scope', message: refusals.join(' ') } }
}
