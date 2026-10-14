// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { realmExportPaths, realmExportLabel } from './helpers/realm-exports'

interface RealmClient {
  clientId?: string
  publicClient?: boolean
  standardFlowEnabled?: boolean
  serviceAccountsEnabled?: boolean
  clientAuthenticatorType?: string
  attributes?: Record<string, string>
}

const BACKEND_SERVICE_MAX_LIFESPAN = 300

function clientsOf(path: string): RealmClient[] {
  const realm: { clients?: RealmClient[] } = JSON.parse(readFileSync(path, 'utf-8'))
  return realm.clients ?? []
}

for (const path of realmExportPaths()) {
  describe(`SMART client defaults in ${realmExportLabel(path)}`, () => {
    const clients = clientsOf(path)

    it('requires S256 PKCE on every public client that runs the authorization code flow', () => {
      const missing = clients
        .filter((client) => client.publicClient && client.standardFlowEnabled !== false)
        .filter((client) => client.attributes?.['pkce.code.challenge.method'] !== 'S256')
        .map((client) => client.clientId)
      expect(missing).toEqual([])
    })

    it('keeps asymmetric backend-service tokens within 300 seconds', () => {
      const tooLong = clients
        .filter((client) => client.serviceAccountsEnabled && client.clientAuthenticatorType === 'federated-jwt')
        .filter((client) => Number(client.attributes?.['access.token.lifespan'] ?? Infinity) > BACKEND_SERVICE_MAX_LIFESPAN)
        .map((client) => client.clientId)
      expect(tooLong).toEqual([])
    })
  })
}
