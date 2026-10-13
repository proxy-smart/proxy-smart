// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterAll } from 'bun:test'
import { config } from '../src/config'
import { smartConfigService } from '../src/lib/smart-config'

const realFetch = globalThis.fetch

const openidConfiguration = {
  issuer: 'http://localhost:8080/realms/proxy-smart',
  authorization_endpoint: 'http://localhost:8080/auth',
  token_endpoint: 'http://localhost:8080/token',
  grant_types_supported: ['authorization_code'],
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['private_key_jwt'],
}

globalThis.fetch = Object.assign(
  async () => new Response(JSON.stringify(openidConfiguration), { headers: { 'content-type': 'application/json' } }),
  { preconnect: realFetch.preconnect },
)

afterAll(() => {
  globalThis.fetch = realFetch
})

describe('smart-configuration advertises SMART App State', () => {
  it('lists smart-app-state and the endpoint that serves it', async () => {
    smartConfigService.clearCache()
    const discovered = await smartConfigService.getSmartConfiguration()

    expect(discovered.capabilities).toContain('smart-app-state')
    expect(discovered.associated_endpoints).toEqual([
      { url: `${config.baseUrl}/app-state`, capabilities: ['smart-app-state'] },
    ])
  })
})
