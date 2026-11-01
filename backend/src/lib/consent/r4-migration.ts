// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { getServiceAccountToken, SHL_WRITE_SCOPE } from '../shl/service-account'
import { isRecord } from '../type-guards'
import type { UpstreamFetch } from '../upstream-fetch'
import { logger } from '../logger'
import { consentCache } from './consent-cache'
import { isR4Consent } from './provision-rules'
import { r4Provision } from './r4-provision'
import { invalidateRecordCustody } from './record-custody'
import { isFhirConsent, type ConsentR4 } from './types'

const MAX_PAGES = 1000

export interface R4MigrationOptions {
  serverUrl: string
  apply: boolean
  upstreamFetch?: UpstreamFetch
  token?: () => Promise<string>
}

export interface R4MigrationResult {
  consentsRead: number
  pending: { id: string; status: string; rootType: string }[]
  written: number
  failed: { id: string; status: number; detail: string }[]
  applied: boolean
}

async function storedConsents(upstreamFetch: UpstreamFetch, serverUrl: string, headers: Record<string, string>): Promise<ConsentR4[]> {
  const consents: ConsentR4[] = []
  let next: string | null = `${serverUrl}/Consent?_count=100`
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const res = await upstreamFetch(next, { headers })
    if (!res.ok) throw new Error(`Reading Consents failed: HTTP ${res.status}`)
    const bundle: unknown = await res.json()
    if (!isRecord(bundle)) break
    for (const entry of Array.isArray(bundle.entry) ? bundle.entry : []) {
      if (isRecord(entry) && isFhirConsent(entry.resource) && isR4Consent(entry.resource)) consents.push(entry.resource)
    }
    const link = (Array.isArray(bundle.link) ? bundle.link : []).find((l) => isRecord(l) && l.relation === 'next')
    next = isRecord(link) && typeof link.url === 'string' && link.url.startsWith(serverUrl) ? link.url : null
  }
  return consents
}

/** Rewrite stored Consents whose root rule carries a type into the R4 shape; reports only unless `apply`. */
export async function migrateConsentProvisions(options: R4MigrationOptions): Promise<R4MigrationResult> {
  const { serverUrl, apply, upstreamFetch = fetch, token = () => getServiceAccountToken(SHL_WRITE_SCOPE) } = options
  const headers = { Accept: 'application/fhir+json', Authorization: `Bearer ${await token()}` }
  const consents = await storedConsents(upstreamFetch, serverUrl, headers)
  const result: R4MigrationResult = { consentsRead: consents.length, pending: [], written: 0, failed: [], applied: apply }

  for (const consent of consents) {
    const provision = consent.provision && r4Provision(consent.provision)
    if (!provision || !consent.id) continue
    result.pending.push({ id: consent.id, status: consent.status, rootType: consent.provision?.type ?? '' })
    if (!apply) continue
    const versionId = consent.meta?.versionId
    const res = await upstreamFetch(`${serverUrl}/Consent/${consent.id}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/fhir+json', ...(versionId ? { 'If-Match': `W/"${versionId}"` } : {}) },
      body: JSON.stringify({ ...consent, provision }),
    })
    if (res.ok) result.written++
    else result.failed.push({ id: consent.id, status: res.status, detail: (await res.text().catch(() => '')).slice(0, 200) })
  }

  if (apply && result.written > 0) {
    consentCache.clear()
    invalidateRecordCustody()
  }
  logger.consent.info('Consent R4 migration', { serverUrl, apply, read: result.consentsRead, pending: result.pending.length, written: result.written, failed: result.failed.length })
  return result
}
