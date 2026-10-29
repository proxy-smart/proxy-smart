// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock } from 'bun:test'
import { useSuiteEnv } from './helpers/test-env'
import { signTestToken } from './helpers/jwt-test-keys'

const refreshed: string[] = []

mock.module('../src/lib/fhir-server-store', () => ({
  fhirServerStore: {
    getIsInitialized: () => true,
    refreshServer: async (name: string) => { refreshed.push(name) },
    getServerByName: () => ({ metadata: { fhirVersion: '4.0.1', supported: true } }),
  },
  getServerByName: async () => 'http://upstream.test/fhir',
  getServerInfoByName: async () => ({ name: 'hapi', url: 'http://upstream.test/fhir', identifier: 'hapi', lastUpdated: 0, metadata: { fhirVersion: '4.0.1', supported: true } }),
  fhirResourceUrlFor: () => 'http://localhost/proxy-smart-backend/hapi/R4',
}))

const KC_BASE = 'http://localhost:8080'
const ISSUER = `${KC_BASE}/realms/proxy-smart`
const ENV: Record<string, string> = {
  KEYCLOAK_BASE_URL: KC_BASE,
  KEYCLOAK_PUBLIC_URL: KC_BASE,
  KEYCLOAK_REALM: 'proxy-smart',
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-ui',
  BASE_URL: 'http://localhost:8445',
}
const { config } = await import('../src/config')
const { fhirRoutes } = await import('../src/routes/fhir')

function refresh(token?: string) {
  return fhirRoutes.handle(new Request(`http://localhost/${config.name}/hapi/R4/cache/refresh`, {
    method: 'POST',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  }))
}

useSuiteEnv(ENV)

describe('POST .../cache/refresh', () => {
  it('refuses a caller with no token', async () => {
    expect((await refresh()).status).toBe(401)
  })

  it('refuses an end user, whose SMART token used to be enough', async () => {
    const patient = signTestToken({
      iss: ISSUER,
      aud: 'http://localhost:8445/proxy-smart-backend/hapi/R4',
      azp: 'patient-portal',
      realmRoles: ['offline_access'],
    })
    expect([401, 403]).toContain((await refresh(patient)).status)
    expect(refreshed).toEqual([])
  })

  it('lets an admin refresh the server', async () => {
    const admin = signTestToken({ iss: ISSUER, aud: 'admin-ui', azp: 'admin-ui', realmRoles: ['admin'] })
    expect((await refresh(admin)).status).toBe(200)
    expect(refreshed).toEqual(['hapi'])
  })
})
