// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { ERASE_OPERATION } from './fhir-erasure'
import { parseFhirPath } from './fhir-capabilities'

export type ConstraintParam = readonly [name: string, value: string]

/** One SMART 2.0 scope's search-parameter suffix: every param must hold (AND). */
export interface ScopeConstraint {
  scope: string
  params: ConstraintParam[]
}

/** Constraints of several scopes are a union: satisfying any one is enough. */
export type ScopeGrant =
  | { kind: 'none' }
  | { kind: 'full' }
  | { kind: 'constrained'; constraints: ScopeConstraint[] }

export interface ParsedResourceScope {
  context: 'patient' | 'user' | 'system' | 'agent'
  resourceType: string
  permissions: string
  constraint: ConstraintParam[] | null
}

const RESOURCE_SCOPE_RE = /^(patient|user|system|agent)\/([\w*]+)\.([\w*]+)(?:\?(.*))?$/
const CONSTRAINT_PARAM_NAME_RE = /^[A-Za-z_][\w.:-]*$/
const SCOPE_CONTEXTS = ['patient', 'user', 'system', 'agent'] as const

const METHOD_TO_V2_CHAR: Record<string, string> = {
  GET: 'r',
  POST: 'c',
  PUT: 'u',
  PATCH: 'u',
  DELETE: 'd',
}

function scopeContext(value: string): ParsedResourceScope['context'] | null {
  return SCOPE_CONTEXTS.find((c) => c === value) ?? null
}

function parseConstraint(query: string): ConstraintParam[] | null {
  if (!query) return null
  const params: ConstraintParam[] = []
  for (const part of query.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) return null
    let name: string
    let value: string
    try {
      name = decodeURIComponent(part.slice(0, eq))
      value = decodeURIComponent(part.slice(eq + 1))
    } catch {
      return null
    }
    if (!CONSTRAINT_PARAM_NAME_RE.test(name) || !value) return null
    params.push([name, value])
  }
  return params
}

/** An unparseable constraint suffix makes the whole scope unusable rather than unconstrained. */
export function parseResourceScope(scope: string): ParsedResourceScope | null {
  const match = RESOURCE_SCOPE_RE.exec(scope)
  if (!match) return null
  const context = scopeContext(match[1])
  if (!context) return null
  const query = match[4]
  if (query === undefined) {
    return { context, resourceType: match[2], permissions: match[3], constraint: null }
  }
  const constraint = parseConstraint(query)
  return constraint ? { context, resourceType: match[2], permissions: match[3], constraint } : null
}

/** POST `_search` is a search and `$erase` a delete; GET without an id is a search. */
export function resolveScopeOperation(method: string, resourcePath: string): { effectiveMethod: string; isSearch: boolean } {
  const path = resourcePath.split('?')[0]
  if (method === 'POST' && /(^|\/)_search$/.test(path)) {
    return { effectiveMethod: 'GET', isSearch: true }
  }
  if (method === 'POST' && path.endsWith(`/$${ERASE_OPERATION}`)) {
    return { effectiveMethod: 'DELETE', isSearch: false }
  }
  if (method === 'GET' && (resourcePath.includes('?') || parseFhirPath(path, method).hasSearchSemantics)) {
    return { effectiveMethod: 'GET', isSearch: true }
  }
  return { effectiveMethod: method, isSearch: false }
}

/** The resource type whose scope governs the request: the target of a compartment search. */
export function scopedResourceType(resourcePath: string, method: string): string {
  const path = resourcePath.split('?')[0]
  const ctx = parseFhirPath(path, method)
  return ctx.compartmentType && ctx.resourceType ? ctx.resourceType : path.split('/')[0]
}

function permits(permissions: string, method: string, resourcePath: string): boolean {
  const { effectiveMethod, isSearch } = resolveScopeOperation(method, resourcePath)
  if (permissions === '*') return true
  const isRead = effectiveMethod === 'GET'
  if (isRead && permissions === 'read') return true
  if (!isRead && permissions === 'write' && effectiveMethod in METHOD_TO_V2_CHAR) return true
  const requiredChar = isSearch ? 's' : METHOD_TO_V2_CHAR[effectiveMethod]
  return permissions.length <= 5 && /^[cruds]+$/.test(permissions) && !!requiredChar && permissions.includes(requiredChar)
}

/** Supports SMART v1 (`read`/`write`/`*`) and v2 (`cruds`) permissions, with or without constraints. */
export function resolveScopeGrant(
  tokenScopes: Iterable<string>,
  resourceType: string,
  method: string,
  resourcePath: string,
): ScopeGrant {
  const constraints: ScopeConstraint[] = []
  for (const scope of tokenScopes) {
    const parsed = parseResourceScope(scope)
    if (!parsed) continue
    if (parsed.resourceType !== '*' && parsed.resourceType !== resourceType) continue
    if (!permits(parsed.permissions, method, resourcePath)) continue
    if (!parsed.constraint) return { kind: 'full' }
    constraints.push({ scope, params: parsed.constraint })
  }
  return constraints.length > 0 ? { kind: 'constrained', constraints } : { kind: 'none' }
}
