// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { useSuiteEnv } from './helpers/test-env'
import { Elysia } from 'elysia'
import { signTestToken } from './helpers/jwt-test-keys'

const KC_BASE = 'http://localhost:8080'
const ISSUER = `${KC_BASE}/realms/proxy-smart`

const ENV: Record<string, string> = {
  KEYCLOAK_BASE_URL: KC_BASE,
  KEYCLOAK_PUBLIC_URL: KC_BASE,
  KEYCLOAK_REALM: 'proxy-smart',
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-ui',
  BASE_URL: 'http://localhost:8445',
}
const { consentNotifyRoutes } = await import('../src/routes/api/consent-notify')

function tokenFor(fhirUser: string): string {
  return signTestToken({ iss: ISSUER, aud: 'admin-ui', azp: 'admin-ui', extra: { fhirUser } })
}

function notify(token: string) {
  return new Elysia().use(consentNotifyRoutes).handle(new Request('http://localhost/consent/notify-access-request', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ patientReference: 'Patient/123', practitionerName: 'Dr. Smith' }),
  }))
}

useSuiteEnv(ENV)

describe('POST /consent/notify-access-request', () => {
  it.each(['Patient/123', 'Person/9', 'RelatedPerson/4'])('refuses a %s caller, who could otherwise email any patient', async (fhirUser) => {
    expect((await notify(tokenFor(fhirUser))).status).toBe(403)
  })

  it('refuses a token that names no fhirUser', async () => {
    const res = await notify(signTestToken({ iss: ISSUER, aud: 'admin-ui', azp: 'admin-ui' }))
    expect(res.status).toBe(403)
  })

  it.each(['Practitioner/7', 'https://fhir.example/R4/PractitionerRole/3'])('lets a %s caller past the gate', async (fhirUser) => {
    expect([401, 403]).not.toContain((await notify(tokenFor(fhirUser))).status)
  })
})
