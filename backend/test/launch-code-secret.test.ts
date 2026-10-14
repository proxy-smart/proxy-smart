// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterEach } from 'bun:test'
import { generateKeyPairSync } from 'crypto'
import { _resetKeyPair, launchCodeSecret } from '../src/lib/proxy-signing'

const pem = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey

describe('launch code secret', () => {
  afterEach(() => {
    delete process.env.SMART_LAUNCH_SECRET
    delete process.env.PROXY_SIGNING_KEY_PEM
    _resetKeyPair()
  })

  it.serial('is the same on every node that shares the signing key', () => {
    process.env.PROXY_SIGNING_KEY_PEM = pem
    const first = launchCodeSecret()
    _resetKeyPair()
    expect(launchCodeSecret()).toBe(first)
    expect(first).not.toContain('PRIVATE KEY')
  })

  it.serial('uses SMART_LAUNCH_SECRET when it is set', () => {
    process.env.PROXY_SIGNING_KEY_PEM = pem
    process.env.SMART_LAUNCH_SECRET = 'explicit-secret'
    expect(launchCodeSecret()).toBe('explicit-secret')
  })

  it.serial('stays per process without a configured signing key', () => {
    expect(launchCodeSecret()).toHaveLength(64)
  })
})
