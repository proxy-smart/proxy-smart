// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { parseScopes } from '@proxy-smart/auth'
import { parseFhirPath } from './fhir-capabilities'
import { logger } from './logger'
import type { AccessControlResult } from './smart-access-control'

/** Server administration: no SMART grant covers these, whatever its scopes say. */
const ADMINISTRATIVE_OPERATIONS: ReadonlySet<string> = new Set([
  'expunge',
  'reindex',
  'reindex-terminology',
  'perform-reindexing-pass',
  'mark-all-resources-for-reindexing',
  'hapi.fhir.reindex-status',
  'hapi.fhir.merge',
  'hapi.fhir.undo-merge',
  'hapi.fhir.replace-references',
  'hapi.fhir.undo-replace-references',
  'get-resource-counts',
  'upload-external-code-system',
  'apply-codesystem-delta-add',
  'apply-codesystem-delta-remove',
  'trigger-subscription',
])

/** SMART Bulk Data reserves export for backend services, which hold system scopes. */
const SYSTEM_SCOPE_OPERATIONS: ReadonlySet<string> = new Set(['export', 'export-poll-status'])

const DESTRUCTIVE_DELETE_PARAMS = ['_expunge', '_cascade'] as const

export interface OperationPolicyRequest {
  resourcePath: string
  method: string
  queryString: string
  tokenPayload: Record<string, unknown>
}

function forbidden(diagnostics: string): AccessControlResult {
  return {
    allowed: false,
    status: 403,
    body: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics }] },
  }
}

function hasSystemScope(tokenPayload: Record<string, unknown>): boolean {
  const scope = typeof tokenPayload.scope === 'string' ? tokenPayload.scope : ''
  return [...parseScopes(scope)].some((s) => s.startsWith('system/'))
}

/** Runs before scope enforcement and ignores its mode: these refusals are not a scope question. */
export function enforceOperationPolicy(req: OperationPolicyRequest): AccessControlResult {
  const ctx = parseFhirPath(req.resourcePath.split('?')[0], req.method)
  const operation = ctx.isOperation ? ctx.operationName : null

  if (operation && ADMINISTRATIVE_OPERATIONS.has(operation)) {
    logger.fhir.warn('Refused an administrative FHIR operation', { operation, path: req.resourcePath, sub: req.tokenPayload.sub })
    return forbidden(`$${operation} is a server administration operation and is not available through this proxy`)
  }

  if (operation && SYSTEM_SCOPE_OPERATIONS.has(operation) && !hasSystemScope(req.tokenPayload)) {
    return forbidden(`$${operation} requires a system-level scope (SMART Backend Services)`)
  }

  if (req.method === 'DELETE' && req.queryString.length > 1) {
    const params = new URLSearchParams(req.queryString)
    const refused = DESTRUCTIVE_DELETE_PARAMS.find((p) => params.has(p))
    if (refused) return forbidden(`${refused} is not available through this proxy`)
  }

  return { allowed: true }
}
