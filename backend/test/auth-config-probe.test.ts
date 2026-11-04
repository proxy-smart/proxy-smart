// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterAll, spyOn } from 'bun:test'
import { authRoutes } from '../src/routes/auth'

const previousBaseUrl = process.env.KEYCLOAK_BASE_URL
const previousRealm = process.env.KEYCLOAK_REALM
afterAll(() => {
  if (previousBaseUrl === undefined) delete process.env.KEYCLOAK_BASE_URL
  else process.env.KEYCLOAK_BASE_URL = previousBaseUrl
  if (previousRealm === undefined) delete process.env.KEYCLOAK_REALM
  else process.env.KEYCLOAK_REALM = previousRealm
})

describe('GET /auth/config', () => {
  it('answers from configuration without calling Keycloak', async () => {
    process.env.KEYCLOAK_BASE_URL = 'http://127.0.0.1:9'
    process.env.KEYCLOAK_REALM = 'probe-realm'
    const fetchSpy = spyOn(globalThis, 'fetch')
    try {
      const res = await authRoutes.handle(new Request('http://localhost/auth/config'))
      const data = await res.json()
      expect(data.keycloak.isConfigured).toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
