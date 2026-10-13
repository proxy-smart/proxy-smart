// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Reads, searches and operations under a patient-confined grant stay inside that patient's compartment.

import { parseFhirPath } from '../fhir-capabilities'
import { bundleEntryCount, upstreamFhirQuery } from '../fhir-upstream-query'
import { logger } from '../logger'
import type { AccessControlContext, AccessControlResult } from '../smart-access-control'
import { PATIENT_COMPARTMENT, compartmentSearchParam } from './definition'

type Decision =
  | { allowed: true; queryString: string }
  | { allowed: false; status: number; error: string; message: string }

const OWN_RECORD_ONLY = 'You can only access your own patient record'

function refuse(message: string, status = 403, error = 'access_denied'): Decision {
  return { allowed: false, status, error, message }
}

function withParam(queryString: string, [name, value]: [string, string]): string {
  return `${queryString}${queryString ? '&' : '?'}${name}=${encodeURIComponent(value).replaceAll('%2F', '/')}`
}

/** Why the request reaches beyond any one patient's compartment; null when it can be confined. */
function unconfinableRead(resourcePath: string, method: string, patientId: string): string | null {
  const path = parseFhirPath(resourcePath, method)
  const resourceType = path.resourceType
  if (!resourceType) {
    return resourcePath === 'metadata' ? null : 'A request at the server base spans every resource type, so it cannot be confined to one patient.'
  }
  const [first, second] = resourcePath.split('/')
  if (first === 'Patient' && second && !/^[$_]/.test(second) && second !== patientId) return OWN_RECORD_ONLY
  if (!PATIENT_COMPARTMENT.has(resourceType) || path.hasSearchSemantics || path.isInstance) return null
  if (path.isHistory) return `The history of every ${resourceType} spans patients, so it cannot be confined to one patient.`
  if (path.isOperation) return `$${path.operationName} on ${resourceType} spans patients, so it cannot be confined to one patient.`
  return null
}

async function decide(ctx: AccessControlContext, queryString: string, patientId: string): Promise<Decision> {
  const unconfinable = unconfinableRead(ctx.resourcePath, ctx.method, patientId)
  if (unconfinable) return refuse(unconfinable)

  const path = parseFhirPath(ctx.resourcePath, ctx.method)
  const resourceType = path.resourceType
  const param = resourceType ? compartmentSearchParam(resourceType, patientId) : null
  if (!resourceType || !param) return { allowed: true, queryString }
  if (path.hasSearchSemantics) return { allowed: true, queryString: withParam(queryString, param) }

  const id = path.isInstance ? path.resourceId : null
  if (!id || resourceType === 'Patient') return { allowed: true, queryString }
  const url = `${ctx.serverUrl}/${resourceType}${withParam(`?_id=${encodeURIComponent(id)}`, param)}&_format=json`
  const bundle = await upstreamFhirQuery(ctx, url, 'patient resource ownership check')
  if (bundle === null) return refuse('Failed to validate resource ownership on upstream FHIR server', 502, 'upstream_error')
  if (bundleEntryCount(bundle) === 0) return refuse(`${resourceType}/${id} does not belong to your patient record`)
  return { allowed: true, queryString }
}

/** Runs for anything but a write once the patient is known; audit-only evaluates the same decision and changes nothing. */
export async function confinePatientRead(
  ctx: AccessControlContext,
  queryString: string,
  compartment: string,
  isEnforce: boolean,
): Promise<AccessControlResult> {
  const patientId = compartment.split('/')[1] ?? ''
  const decision = await decide(ctx, queryString, patientId)
  if (decision.allowed) {
    if (isEnforce || decision.queryString === queryString) return { allowed: true, modifiedQueryString: decision.queryString }
    logger.fhir.info('Patient-compartment narrowing not applied (audit-only)', {
      compartment,
      method: ctx.method,
      resourcePath: ctx.resourcePath,
      wouldNarrowTo: decision.queryString,
      server: ctx.serverName,
    })
    return { allowed: true, modifiedQueryString: queryString }
  }

  logger.fhir.warn('Read outside the patient compartment', {
    compartment,
    method: ctx.method,
    resourcePath: ctx.resourcePath,
    reason: decision.message,
    server: ctx.serverName,
    wouldDeny: !isEnforce,
  })
  if (!isEnforce) return { allowed: true, modifiedQueryString: queryString }
  return { allowed: false, status: decision.status, body: { error: decision.error, message: decision.message } }
}
