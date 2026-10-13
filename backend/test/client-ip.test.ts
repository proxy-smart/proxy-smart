// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { clientIp, forwardedClientIp } from '../src/lib/client-ip'

const request = (headers: Record<string, string> = {}) => new Request('http://proxy.test/auth/token', { headers })

describe('forwardedClientIp', () => {
  it('uses the socket peer and ignores X-Forwarded-For when no proxy is trusted', () => {
    expect(forwardedClientIp('6.6.6.6, 10.0.0.1', '203.0.113.9', 0)).toBe('203.0.113.9')
  })

  it('takes the rightmost entry behind one trusted proxy, so a client-supplied prefix is ignored', () => {
    expect(forwardedClientIp('6.6.6.6, 198.51.100.7', '10.0.0.1', 1)).toBe('198.51.100.7')
  })

  it('counts trusted hops from the right', () => {
    expect(forwardedClientIp('6.6.6.6, 198.51.100.7, 10.0.0.2', '10.0.0.1', 2)).toBe('198.51.100.7')
  })

  it('falls back to the leftmost entry when the chain is shorter than the trusted hops', () => {
    expect(forwardedClientIp('198.51.100.7', '10.0.0.1', 3)).toBe('198.51.100.7')
  })

  it('falls back to the socket peer when a trusted proxy sent no X-Forwarded-For', () => {
    expect(forwardedClientIp(null, '10.0.0.1', 1)).toBe('10.0.0.1')
  })

  it('skips empty list entries', () => {
    expect(forwardedClientIp('198.51.100.7, , ', '10.0.0.1', 1)).toBe('198.51.100.7')
  })

  it('returns undefined when nothing identifies the client', () => {
    expect(forwardedClientIp(null, undefined, 0)).toBeUndefined()
  })
})

describe('clientIp', () => {
  it('reads X-Forwarded-For from a Request', () => {
    const req = request({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' })
    expect(clientIp(req, { trustedHops: 1 })).toBe('198.51.100.7')
  })

  it('reads X-Forwarded-For from a plain header record', () => {
    expect(clientIp({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }, { trustedHops: 1 })).toBe('198.51.100.7')
  })

  it('does not trust X-Real-IP, which a client can set as easily as anything else', () => {
    expect(clientIp(request({ 'x-real-ip': '6.6.6.6' }), { trustedHops: 0, peer: '203.0.113.9' })).toBe('203.0.113.9')
  })

  it('reads the socket peer from the server that accepted the request', () => {
    const server = { requestIP: () => ({ address: '203.0.113.9' }) }
    expect(clientIp(request(), { trustedHops: 0, server })).toBe('203.0.113.9')
  })

  it('defaults the trusted hops to TRUSTED_PROXY_HOPS', () => {
    const saved = process.env.TRUSTED_PROXY_HOPS
    process.env.TRUSTED_PROXY_HOPS = '1'
    try {
      expect(clientIp(request({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }))).toBe('198.51.100.7')
    } finally {
      if (saved === undefined) delete process.env.TRUSTED_PROXY_HOPS
      else process.env.TRUSTED_PROXY_HOPS = saved
    }
  })

  it('treats an invalid TRUSTED_PROXY_HOPS as no trusted proxy', () => {
    const saved = process.env.TRUSTED_PROXY_HOPS
    process.env.TRUSTED_PROXY_HOPS = 'two'
    try {
      expect(clientIp(request({ 'x-forwarded-for': '6.6.6.6' }), { peer: '203.0.113.9' })).toBe('203.0.113.9')
    } finally {
      if (saved === undefined) delete process.env.TRUSTED_PROXY_HOPS
      else process.env.TRUSTED_PROXY_HOPS = saved
    }
  })
})
