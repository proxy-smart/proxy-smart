// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isSystemScope } from '@proxy-smart/auth'
import { parseFhirPath } from './fhir-capabilities'
import { SYSTEM_SCOPE_OPERATIONS } from './fhir-operation-policy'
import { resolveScopeGrant } from './smart-scope-grants'

const EVERY_TYPE_OPERATIONS: ReadonlySet<string> = new Set(['everything', 'summary', 'document', 'graphql', 'export'])

export function operationReadRefusal(tokenScopes: readonly string[], resourcePath: string, method: string): string | null {
  const ctx = parseFhirPath(resourcePath.split('?')[0], method)
  const operation = ctx.isOperation ? ctx.operationName : null
  if (!operation || !EVERY_TYPE_OPERATIONS.has(operation)) return null

  const systemOnly = SYSTEM_SCOPE_OPERATIONS.has(operation)
  const usable = systemOnly ? tokenScopes.filter(isSystemScope) : tokenScopes
  const readPath = ctx.isInstance ? '*/id' : '*?_id=id'
  if (resolveScopeGrant(usable, '*', 'GET', readPath).kind === 'full') return null

  const required = systemOnly ? 'system/*.rs' : 'patient/*.rs, user/*.rs or system/*.rs'
  return `$${operation} returns resources of every type, so it requires an unconstrained wildcard read scope (${required}).`
}
