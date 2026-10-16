// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { bundleEntryCount, upstreamFhirQuery } from '../fhir-upstream-query'
import { isRecord } from '../type-guards'
import type { AccessControlContext } from '../smart-access-control'

export type StoredLookup =
  | { status: 'found'; resource: Record<string, unknown> }
  | { status: 'absent' }
  | { status: 'unverifiable' }

/** The resource stored under `resourceType/id`, looked up by `_id` so every type, Binary included, answers in JSON. */
export async function lookupStored(ctx: AccessControlContext, resourceType: string, id: string, description: string): Promise<StoredLookup> {
  const url = `${ctx.serverUrl}/${resourceType}?_id=${encodeURIComponent(id)}&_format=json`
  const bundle = await upstreamFhirQuery(ctx, url, description)
  if (bundle === null) return { status: 'unverifiable' }
  const entries = Array.isArray(bundle.entry) ? bundle.entry : []
  for (const entry of entries) {
    if (isRecord(entry) && isRecord(entry.resource) && entry.resource.resourceType === resourceType && entry.resource.id === id) {
      return { status: 'found', resource: entry.resource }
    }
  }
  return bundleEntryCount(bundle) === 0 ? { status: 'absent' } : { status: 'unverifiable' }
}
