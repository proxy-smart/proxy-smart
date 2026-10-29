// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { checkExternalUrl, checkExternalUrlSyntax, isPublicAddress, readTextCapped } from './external-url'

const resolvesTo = (...addresses: string[]) => async () => addresses

describe('isPublicAddress', () => {
  test.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', 'fd12::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe', '2001:db8::1',
  ])('%s is not public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false)
  })

  test.each(['93.184.216.34', '8.8.8.8', '100.128.0.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    '%s is public',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true)
    },
  )
})

describe('checkExternalUrlSyntax', () => {
  test.each([
    'http://[::ffff:127.0.0.1]/x',
    'http://[::ffff:a9fe:a9fe]/latest',
    'http://[fd12::1]/',
    'http://100.64.0.1/',
    'http://[::]/',
    'http://0177.0.0.1/',
    'http://2130706433/',
    'http://localhost/',
    'http://foo.localhost/',
    'http://keycloak:8080/realms/x',
    'http://postgres:5432/',
    'http://metadata.google.internal/',
    'http://printer.local/',
    'ftp://example.com/',
    'not a url',
  ])('refuses %s', (url) => {
    expect(checkExternalUrlSyntax(url).valid).toBe(false)
  })

  test('accepts a public hostname', () => {
    expect(checkExternalUrlSyntax('https://issuer.example.com/jwks').valid).toBe(true)
  })

  test('accepts a single-label host only when the policy allows it', () => {
    expect(checkExternalUrlSyntax('http://hapi-fhir:8080/fhir', { allowSingleLabelHosts: true }).valid).toBe(true)
  })

  test('allowInternal skips every check', () => {
    expect(checkExternalUrlSyntax('http://localhost:3000/', { allowInternal: true }).valid).toBe(true)
  })

  test('an allowed host is exempt', () => {
    expect(checkExternalUrlSyntax('http://keycloak:8080/x', { allowedHosts: ['keycloak'] }).valid).toBe(true)
  })
})

describe('checkExternalUrl', () => {
  test('refuses a hostname that resolves to a private address', async () => {
    const result = await checkExternalUrl('https://rebind.example.com/jwks', { resolve: resolvesTo('10.0.0.5') })
    expect(result.valid).toBe(false)
  })

  test('refuses when any resolved address is private', async () => {
    const result = await checkExternalUrl('https://mixed.example.com/', { resolve: resolvesTo('93.184.216.34', '::1') })
    expect(result.valid).toBe(false)
  })

  test('refuses a hostname that does not resolve', async () => {
    const result = await checkExternalUrl('https://nowhere.example.com/', { resolve: resolvesTo() })
    expect(result.valid).toBe(false)
  })

  test('refuses when resolution fails', async () => {
    const result = await checkExternalUrl('https://broken.example.com/', {
      resolve: async () => { throw new Error('ENOTFOUND') },
    })
    expect(result.valid).toBe(false)
  })

  test('accepts a hostname that resolves only to public addresses', async () => {
    const result = await checkExternalUrl('https://issuer.example.com/jwks', { resolve: resolvesTo('93.184.216.34') })
    expect(result.valid).toBe(true)
  })

  test('does not resolve an IP literal', async () => {
    let asked = false
    const result = await checkExternalUrl('https://93.184.216.34/', { resolve: async () => { asked = true; return [] } })
    expect(result.valid).toBe(true)
    expect(asked).toBe(false)
  })
})

describe('readTextCapped', () => {
  test('reads a body within the cap', async () => {
    expect(await readTextCapped(new Response('{"a":1}'), 100)).toBe('{"a":1}')
  })

  test('refuses a declared length over the cap', async () => {
    const response = new Response('x'.repeat(10), { headers: { 'content-length': '5000' } })
    await expect(readTextCapped(response, 100)).rejects.toThrow(/exceeds/)
  })

  test('stops reading a streamed body once it passes the cap', async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(64))
      },
    })
    await expect(readTextCapped(new Response(stream), 256)).rejects.toThrow(/exceeds/)
    expect(pulled).toBeLessThan(10)
  })
})
