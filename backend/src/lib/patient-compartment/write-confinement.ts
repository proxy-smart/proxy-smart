// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Create, update, patch and delete under a patient-confined grant stay inside that patient's compartment.

import { parseFhirPath } from '../fhir-capabilities'
import { logger } from '../logger'
import { resolveScopeOperation } from '../smart-scope-grants'
import { isRecord, parseJson } from '../type-guards'
import { refusal, refusedResult, upstreamUnverifiable, type AccessDecision } from '../access-decision'
import type { AccessControlContext, AccessControlResult } from '../smart-access-control'
import { compartmentRootElements, patientCompartmentVerdict } from './definition'
import { patchRefusal } from './patch-guard'
import { lookupStored } from './stored-resource'

export interface WriteRequest {
  body?: string
  headers?: Headers
}

type Decision = AccessDecision

const ALLOW: Decision = { allowed: true }
const PASSIVE_PARAMS: ReadonlySet<string> = new Set(['_format', '_pretty'])

/** A create, update, patch or delete; searches by POST and operations are not. */
export function isCompartmentWrite(method: string, resourcePath: string): boolean {
  if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') return true
  return method === 'POST' && !resolveScopeOperation(method, resourcePath).isSearch && !parseFhirPath(resourcePath, method).isOperation
}

function checkBody(body: string | undefined, resourceType: string, patientId: string, serverUrl: string): Decision {
  const resource = parseJson(body)
  if (!isRecord(resource) || resource.resourceType !== resourceType) {
    return refusal(`A write under a patient-confined grant needs a JSON ${resourceType} body to check against the patient compartment.`)
  }
  const verdict = patientCompartmentVerdict(resource, patientId, serverUrl)
  return verdict.member ? ALLOW : refusal(verdict.reason)
}

async function checkStored(ctx: AccessControlContext, resourceType: string, id: string, patientId: string): Promise<Decision> {
  if (resourceType === 'Patient') {
    return id === patientId ? ALLOW : refusal(`Patient/${id} is not the patient this grant is confined to.`)
  }
  const label = `${resourceType}/${id}`
  const lookup = await lookupStored(ctx, resourceType, id, 'patient compartment write check')
  if (lookup.status === 'unverifiable') return upstreamUnverifiable(`Could not check ${label} against the patient compartment upstream.`)
  if (lookup.status === 'absent') return ALLOW
  const verdict = patientCompartmentVerdict(lookup.resource, patientId, ctx.serverUrl)
  return verdict.member ? ALLOW : refusal(`${label} is outside the patient compartment. ${verdict.reason}`)
}

async function decide(ctx: AccessControlContext, queryString: string, write: WriteRequest, patientId: string): Promise<Decision> {
  const path = parseFhirPath(ctx.resourcePath, ctx.method)
  const resourceType = path.resourceType
  if (!resourceType || path.compartmentType || path.isHistory || path.isOperation) {
    return refusal(`${ctx.method} ${ctx.resourcePath || '(server base)'} cannot be confined to the patient compartment.`)
  }
  const query = new URLSearchParams(queryString.startsWith('?') ? queryString.slice(1) : queryString)
  if ([...query.keys()].some((name) => !PASSIVE_PARAMS.has(name)) || write.headers?.has('x-cascade')) {
    return refusal('Conditional and cascading writes cannot be confined to the patient compartment.')
  }

  if (ctx.method === 'POST') {
    if (path.isInstance) return refusal(`POST ${ctx.resourcePath} is not a create.`)
    if (write.headers?.has('if-none-exist')) return refusal('A conditional create cannot be confined to the patient compartment.')
    return checkBody(write.body, resourceType, patientId, ctx.serverUrl)
  }
  const id = path.resourceId
  if (!path.isInstance || !id) return refusal('Conditional writes cannot be confined to the patient compartment.')

  if (ctx.method === 'PUT') {
    const body = checkBody(write.body, resourceType, patientId, ctx.serverUrl)
    if (!body.allowed) return body
  }
  if (ctx.method === 'PATCH') {
    const reason = patchRefusal(parseJson(write.body), resourceType, compartmentRootElements(resourceType))
    if (reason) return refusal(reason)
  }
  return checkStored(ctx, resourceType, id, patientId)
}

/** Runs for a write once the patient the grant is confined to is known. */
export async function confinePatientWrite(
  ctx: AccessControlContext,
  queryString: string,
  write: WriteRequest,
  compartment: string,
  isEnforce: boolean,
): Promise<AccessControlResult> {
  const patientId = compartment.split('/')[1] ?? ''
  const decision = await decide(ctx, queryString, write, patientId)
  if (decision.allowed) return { allowed: true, modifiedQueryString: queryString }

  logger.fhir.warn('Write outside the patient compartment', {
    compartment,
    method: ctx.method,
    resourcePath: ctx.resourcePath,
    reason: decision.message,
    server: ctx.serverName,
    wouldDeny: !isEnforce,
  })
  if (!isEnforce) return { allowed: true, modifiedQueryString: queryString }
  return refusedResult(decision)
}
