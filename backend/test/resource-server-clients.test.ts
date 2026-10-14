// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The reconciled resource_url must equal what the proxy actually requests.
 *
 * THE BUG THIS GUARDS. ensureResourceServerClients originally derived the FHIR
 * client's resource_url as `${config.baseUrl}/${config.name}/`, reasoning from
 * getFhirResourceAudiences(). Two things were wrong at once: `config.name` is the
 * package name (`proxy-smart`), not the URL segment (`proxy-smart-backend`), and
 * that helper returns a VALIDATION PREFIX matched at a path boundary rather than
 * a resource identifier. Keycloak compares the token request's `resource`
 * parameter against resource_url EXACTLY, so every startup overwrote the correct
 * value and every FHIR token exchange then failed:
 *
 *   POST /auth/token → 400 {"error":"invalid_target"}
 *
 * It typechecked, linted and synthesized cleanly — nothing compared the derived
 * value to the realm export, which already held the right one. That comparison is
 * what this file does.
 */
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
    // fhir-resource-server must NOT be here: its identifier embeds a runtime
    // server id and FHIR version. See the comment in kc-system-provisioning.ts.
    expect([...RESOURCE_SERVER_CLIENT_IDS]).toEqual(['mcp-resource-server'])
  })

  it('derives the same resource_url the realm export declares', () => {
    // config.baseUrl defaults to http://localhost:8445, matching the dev export.
    for (const clientId of RESOURCE_SERVER_CLIENT_IDS) {
      const fromExport = exported.get(clientId)
      expect(fromExport, `${clientId} should declare resource_url in the dev export`).toBeDefined()
      expect(resourceServerUrlFor(clientId)).toBe(fromExport)
    }
  })

  it('leaves the FHIR resource client to the export, which still declares it', () => {
    // Guards the other direction: excluding it from derive-and-overwrite must not
    // be read as "it does not matter" — the export owns its value where present.
    expect(exported.get('fhir-resource-server')).toBeDefined()
  })

  it('fhirResourceUrlFor rebuilds exactly the FHIR resource the export declares', () => {
    // The create-only reconcile fills the gap (e.g. production, which imports with
    // IGNORE_EXISTING) using this exact format. Pinning it to the export value is
    // the same cross-check that would have caught the invalid_target regression.
    const exportedFhir = exported.get('fhir-resource-server')!
    const [identifier, fhirVersion] = exportedFhir.split('/').slice(-2)
    expect(fhirResourceUrlFor({ identifier, metadata: { fhirVersion } })).toBe(exportedFhir)
  })
})
