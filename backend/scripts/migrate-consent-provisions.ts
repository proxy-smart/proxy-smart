// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Usage: bun run scripts/migrate-consent-provisions.ts [--apply]   (dry run without --apply)
import { isR4Consent } from '../src/lib/consent/provision-rules'
import { r4Provision } from '../src/lib/consent/r4-provision'
import { isFhirConsent, type ConsentR4 } from '../src/lib/consent/types'
import { getDefaultFhirServerUrl, getServiceAccountToken, SHL_WRITE_SCOPE } from '../src/lib/shl/service-account'
import { isRecord } from '../src/lib/type-guards'

const apply = process.argv.includes('--apply')
const MAX_PAGES = 1000

async function storedConsents(serverUrl: string, headers: Record<string, string>): Promise<ConsentR4[]> {
  const consents: ConsentR4[] = []
  let next: string | null = `${serverUrl}/Consent?_count=100`
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const res = await fetch(next, { headers })
    if (!res.ok) throw new Error(`Reading ${next} failed: HTTP ${res.status}`)
    const bundle: unknown = await res.json()
    if (!isRecord(bundle)) break
    const entries = Array.isArray(bundle.entry) ? bundle.entry : []
    for (const entry of entries) {
      if (isRecord(entry) && isFhirConsent(entry.resource) && isR4Consent(entry.resource)) {
        consents.push(entry.resource)
      }
    }
    const links = Array.isArray(bundle.link) ? bundle.link : []
    const link = links.find((l) => isRecord(l) && l.relation === 'next')
    next = isRecord(link) && typeof link.url === 'string' && link.url.startsWith(serverUrl) ? link.url : null
  }
  return consents
}

async function main(): Promise<void> {
  const serverUrl = await getDefaultFhirServerUrl()
  const token = await getServiceAccountToken(SHL_WRITE_SCOPE)
  const headers = { Accept: 'application/fhir+json', Authorization: `Bearer ${token}` }
  const consents = await storedConsents(serverUrl, headers)
  let pending = 0
  let written = 0
  let failed = 0
  for (const consent of consents) {
    const provision = consent.provision && r4Provision(consent.provision)
    if (!provision || !consent.id) continue
    pending++
    console.log(`${apply ? 'rewrite' : 'would rewrite'} Consent/${consent.id} (${consent.status}, root ${consent.provision?.type})`)
    if (!apply) continue
    const res = await fetch(`${serverUrl}/Consent/${consent.id}`, {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': 'application/fhir+json',
        ...(consent.meta?.versionId ? { 'If-Match': `W/"${consent.meta.versionId}"` } : {}),
      },
      body: JSON.stringify({ ...consent, provision }),
    })
    if (res.ok) written++
    else {
      failed++
      console.error(`  Consent/${consent.id}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
    }
  }
  console.log(`${consents.length} Consents read, ${pending} with a typed root${apply ? `, ${written} rewritten, ${failed} failed` : ' (dry run)'}`)
  if (failed > 0) process.exitCode = 1
}

await main()
