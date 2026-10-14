// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterEach } from 'bun:test'
import { PROXY_OAUTH_SUPPORT } from '../src/lib/oidc-discovery'

describe('client assertion algorithms in discovery', () => {
  afterEach(() => { delete process.env.CLIENT_ASSERTION_ALGORITHMS })

  it.serial('advertises only the configured algorithms the proxy can verify', () => {
    process.env.CLIENT_ASSERTION_ALGORITHMS = 'RS384,HS256,ES256,none'
    expect(PROXY_OAUTH_SUPPORT.clientAssertionSigningAlgs).toEqual(['RS384', 'ES256'])
  })

  it.serial('defaults to RS384 and ES384', () => {
    expect(PROXY_OAUTH_SUPPORT.clientAssertionSigningAlgs).toEqual(['RS384', 'ES384'])
  })
})
