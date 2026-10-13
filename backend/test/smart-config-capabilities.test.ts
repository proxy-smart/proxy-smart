// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'

mockLoggerModule()

import { smartConfigService } from '../src/lib/smart-config'

const realFetch = globalThis.fetch

describe('smart-configuration default capabilities', () => {
  beforeEach(() => {
    delete process.env.SMART_CAPABILITIES
    smartConfigService.clearCache()
    globalThis.fetch = Object.assign(
      async () => Response.json({
        issuer: 'http://kc.test/realms/smart',
        authorization_endpoint: 'http://kc.test/auth',
        token_endpoint: 'http://kc.test/token',
        grant_types_supported: ['authorization_code'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      }),
      { preconnect: realFetch.preconnect },
    )
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    smartConfigService.clearCache()
  })

  it('advertises standalone encounter selection next to standalone patient selection', async () => {
    const { capabilities } = await smartConfigService.getSmartConfiguration()
    expect(capabilities).toContain('context-standalone-patient')
    expect(capabilities).toContain('context-standalone-encounter')
  })
})
