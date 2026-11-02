// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterEach, describe, expect, it } from 'bun:test'
import type { Consent, ConsentProvision } from 'fhir/r4'
import { migrateConsentProvisions } from '../src/lib/consent/r4-migration'
import { fakeFetch, jsonResponse } from './helpers/fake-fetch'

const BASE = 'http://fhir.test/fhir'
const custodian = { role: { coding: [{ code: 'CST' }] }, reference: { reference: 'Organization/max-health' } }
const originalFetch = globalThis.fetch

const stored = (id: string, provision: ConsentProvision, versionId = '3'): Consent => ({
  resourceType: 'Consent',
  id,
  meta: { versionId },
  status: 'active',
  scope: { coding: [{ code: 'patient-privacy' }] },
  category: [{ coding: [{ code: '59284-0' }] }],
  provision,
})

interface Write {
  url: string
  ifMatch: string | null
  body: unknown
}

function serve(consents: Consent[], putStatus = 200): Write[] {
  const writes: Write[] = []
  globalThis.fetch = fakeFetch((url, init) => {
    if (init?.method === 'PUT') {
      writes.push({ url, ifMatch: new Headers(init.headers).get('If-Match'), body: JSON.parse(String(init.body)) })
      return jsonResponse({}, putStatus)
    }
    if (url.startsWith(`${BASE}/Consent?`)) return jsonResponse({ resourceType: 'Bundle', entry: consents.map((resource) => ({ resource })) })
    return jsonResponse({}, 404)
  })
  return writes
}

const consents = [
  stored('typed', { type: 'permit', actor: [custodian] }),
  stored('r4', { actor: [custodian], provision: [{ type: 'permit' }] }),
]
const token = async () => 't'

describe('migrateConsentProvisions', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it.serial('reports the Consents with a typed root and writes nothing on a dry run', async () => {
    const writes = serve(consents)
    const result = await migrateConsentProvisions({ serverUrl: BASE, apply: false, token })
    expect(result).toEqual({ consentsRead: 2, pending: [{ id: 'typed', status: 'active', rootType: 'permit' }], written: 0, failed: [], applied: false })
    expect(writes).toEqual([])
  })

  it.serial('rewrites them against the version it read', async () => {
    const writes = serve(consents)
    const result = await migrateConsentProvisions({ serverUrl: BASE, apply: true, token })
    expect(result.written).toBe(1)
    expect(writes).toEqual([{
      url: `${BASE}/Consent/typed`,
      ifMatch: 'W/"3"',
      body: { ...consents[0], provision: { actor: [custodian], provision: [{ type: 'permit' }] } },
    }])
  })

  it.serial('reports a Consent that changed since it was read', async () => {
    serve(consents, 412)
    const result = await migrateConsentProvisions({ serverUrl: BASE, apply: true, token })
    expect(result.written).toBe(0)
    expect(result.failed.map(({ id, status }) => ({ id, status }))).toEqual([{ id: 'typed', status: 412 }])
  })
})
