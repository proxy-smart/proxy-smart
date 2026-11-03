// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { handleAuthorize, UPSTREAM_APP_PARAM } from './authorize-interceptor'
import { MemoryStore } from './stores/memory'
import { TEST_CLIENT_ID, TEST_REDIRECT_URI, makeAuthorizeDeps, makeAuthorizeParams, testProxyConfig } from './test-fixtures'

const AUTHORIZE = {
  config: testProxyConfig({ callbackPath: '/auth/smart-callback' }),
  redirectUris: [TEST_REDIRECT_URI],
  validateAudience: async () => null,
}

const FHIR_BASE = 'https://proxy.example.com/proxy-smart-backend/hapi-fhir-server/R4'

async function idpRedirect(extra: Record<string, string> = {}): Promise<URL> {
  const { result } = await handleAuthorize(makeAuthorizeParams({ aud: FHIR_BASE, ...extra }), makeAuthorizeDeps(new MemoryStore(), AUTHORIZE))
  if (result.type !== 'redirect') throw new Error(`expected a redirect, got ${result.type}`)
  return new URL(result.url)
}

describe('the app named to a brokered identity provider', () => {
  test('is the client signing in', async () => {
    expect((await idpRedirect()).searchParams.get(UPSTREAM_APP_PARAM)).toBe(TEST_CLIENT_ID)
  })

  test('cannot be claimed by an app sending the parameter itself', async () => {
    const url = await idpRedirect({ [UPSTREAM_APP_PARAM]: 'someone-else' })
    expect(url.searchParams.getAll(UPSTREAM_APP_PARAM)).toEqual([TEST_CLIENT_ID])
  })
})
