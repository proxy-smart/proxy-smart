// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it, beforeEach } from 'bun:test'
import { addedByProvenance } from '../src/lib/fhir-authorship'
import { executeFhirRequest, type FhirTarget } from '../src/lib/fhir-request-pipeline'
import { applyEnv, useTestEnv } from './helpers/test-env'

const UPSTREAM = 'http://127.0.0.1:1/fhir'
const ORG_TAG = 'https://proxy-smart.com/tenant'
const calls: string[] = []

type Res = Record<string, unknown>

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/fhir+json' } })
}

function observation(id: string, org: string): Res {
  return {
    resourceType: 'Observation', id, meta: { versionId: '1', tag: [{ system: ORG_TAG, code: org }] },
    status: 'final', code: { text: id }, subject: { reference: 'Patient/p1' },
  }
}

const RECORDS: Record<string, Res> = { o1: observation('o1', 'org-a'), o2: observation('o2', 'org-b') }

async function upstreamFetch(url: string, init?: RequestInit): Promise<Response> {
  calls.push(url)
  if (init?.method === 'POST') {
    const batch: unknown = JSON.parse(String(init.body))
    const urls: string[] = typeof batch === 'object' && batch !== null && 'entry' in batch && Array.isArray(batch.entry)
      ? batch.entry.map((e: { request: { url: string } }) => e.request.url) : []
    return json({
      resourceType: 'Bundle', type: 'batch-response',
      entry: urls.map((u) => ({ resource: RECORDS[u.split('/')[1] ?? ''], response: { status: '200 OK' } })),
    })
  }
  const provenance = await Promise.all(Object.keys(RECORDS).map(async (id) => ({
    ...await addedByProvenance({ type: 'Observation', id, version: '1', chart: 'Patient/p1' }, 'Practitioner/dr'),
    id: `prov-${id}`,
  })))
  return json({ resourceType: 'Bundle', entry: provenance.map((resource) => ({ resource })) })
}

function server(organizationIds?: string[]): FhirTarget {
  return {
    serverInfo: {
      name: 'hapi', url: UPSTREAM, identifier: 'author-tenant-test', lastUpdated: 0,
      metadata: { fhirVersion: '4.0.1', supported: true }, organizationIds,
    },
    serverName: 'hapi',
    fhirVersion: 'R4',
    upstreamFetch,
  }
}

function clinician(organization: string) {
  return {
    tokenPayload: { sub: 'dr', fhirUser: 'Practitioner/dr', scope: 'openid user/*.rs', aud: UPSTREAM, organization: [organization] },
    authHeader: 'Bearer t',
  }
}

const exportAuthored = (target: FhirTarget, org: string) =>
  executeFhirRequest(target, clinician(org), { method: 'GET', resourcePath: '$authored', queryString: '', headers: new Headers() })

function exportedIds(body: unknown): string[] {
  const entries = typeof body === 'object' && body !== null && 'entry' in body && Array.isArray(body.entry) ? body.entry : []
  return entries.flatMap((e: { resource?: Res }) => e.resource?.resourceType === 'Observation' ? [String(e.resource.id)] : [])
}

describe('$authored export and tenant isolation', () => {
  useTestEnv({ TENANT_ISOLATION_MODE: undefined, TENANT_QUERY_ISOLATION: undefined, CONSENT_ENABLED: 'false' })
  beforeEach(() => { calls.length = 0 })

  it.serial('refuses the export on a server the caller\'s organization is not assigned to', async () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce' })
    const result = await exportAuthored(server(['org-a']), 'org-b')
    expect(result.status).toBe(403)
    expect(calls).toEqual([])
  })

  it.serial('leaves out records tagged for another organization when queries are isolated', async () => {
    applyEnv({ TENANT_ISOLATION_MODE: 'enforce', TENANT_QUERY_ISOLATION: 'true' })
    const result = await exportAuthored(server(['org-a', 'org-b']), 'org-b')
    expect(result.status).toBe(200)
    expect(exportedIds(result.body)).toEqual(['o2'])
  })

  it.serial('exports every record the clinician added when isolation is off', async () => {
    const result = await exportAuthored(server(['org-a']), 'org-b')
    expect(result.status).toBe(200)
    expect(exportedIds(result.body).sort()).toEqual(['o1', 'o2'])
  })
})
