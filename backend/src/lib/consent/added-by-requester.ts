// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { recordAdder } from '../fhir-authorship'
import { logger } from '../logger'
import { normalizeFhirUser } from '../patient-context'
import { isRecord } from '../type-guards'
import type { ConsentCheckContext } from './types'

async function entriesOf(url: string, authHeader: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(url, { headers: { Accept: 'application/fhir+json', Authorization: authHeader } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const bundle: unknown = await res.json()
  const entries = isRecord(bundle) && Array.isArray(bundle.entry) ? bundle.entry : []
  return entries.flatMap((entry) => isRecord(entry) && isRecord(entry.resource) ? [entry.resource] : [])
}

/** Whether the proxy recorded the signed-in user as the one who added the record this request targets. */
export async function addedByRequester(context: Pick<ConsentCheckContext, 'resourceType' | 'resourceId' | 'fhirUser'>, serverUrl: string, authHeader: string): Promise<boolean> {
  const { resourceType, resourceId, fhirUser } = context
  if (!resourceType || !resourceId || !fhirUser) return false
  const reference = `${resourceType}/${resourceId}`
  try {
    const [versions, provenance] = await Promise.all([
      entriesOf(`${serverUrl}/${reference}/_history?_count=100`, authHeader),
      entriesOf(`${serverUrl}/Provenance?target=${encodeURIComponent(reference)}&_count=100`, authHeader),
    ])
    return (await recordAdder(resourceType, resourceId, versions, provenance)) === normalizeFhirUser(fhirUser)
  } catch (error) {
    logger.consent.warn('Could not tell who added a record', { reference, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
