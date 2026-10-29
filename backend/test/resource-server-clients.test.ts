// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Keycloak matches the token request's `resource` against resource_url exactly; a mismatch is invalid_target.
import { describe, it, expect } from 'bun:test'
import { DEV_REALM_EXPORT_PATH, readRealmExport } from './helpers/realm-exports'
import { RESOURCE_SERVER_CLIENT_IDS, resourceServerUrlFor } from '@/lib/kc-system-provisioning'
import { fhirResourceUrlFor } from '@/lib/fhir-server-store'

const devRealm = readRealmExport(DEV_REALM_EXPORT_PATH)

/** resource_url values the dev realm export declares, keyed by client id. */
const exported = new Map(
  (devRealm.clients ?? [])
    .filter((c) => c.attributes?.resource_url)
    .map((c) => [c.clientId!, c.attributes!.resource_url!]),
)

describe('resource-server client reconciliation', () => {
  it('only manages clients whose resource_url is fully derivable from config', () => {
    // fhir-resource-server's identifier embeds a runtime server id and FHIR version.
    expect([...RESOURCE_SERVER_CLIENT_IDS]).toEqual(['mcp-resource-server'])
  })

  it('derives the same resource_url the realm export declares', () => {
    for (const clientId of RESOURCE_SERVER_CLIENT_IDS) {
      const fromExport = exported.get(clientId)
      expect(fromExport, `${clientId} should declare resource_url in the dev export`).toBeDefined()
      expect(resourceServerUrlFor(clientId)).toBe(fromExport)
    }
  })

  it('leaves the FHIR resource client to the export, which still declares it', () => {
    expect(exported.get('fhir-resource-server')).toBeDefined()
  })

  it('fhirResourceUrlFor rebuilds exactly the FHIR resource the export declares', () => {
    // Used by the create-only reconcile where the import is IGNORE_EXISTING (production).
    const exportedFhir = exported.get('fhir-resource-server')!
    const [identifier, fhirVersion] = exportedFhir.split('/').slice(-2)
    expect(fhirResourceUrlFor({ identifier, metadata: { fhirVersion } })).toBe(exportedFhir)
  })
})
