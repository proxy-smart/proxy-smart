// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { expect, test } from 'bun:test'
import { isHttpUrl, sameOrigin, trimTrailingSlashes } from './url'

test('isHttpUrl accepts absolute http and https URLs only', () => {
  expect(isHttpUrl('https://example.org/logo.png')).toBe(true)
  expect(isHttpUrl('HTTP://example.org')).toBe(true)
  const rejected = ['', 'clipboard-list', '/logo.png', '//example.org/x', 'ftp://example.org', 'javascript:alert(1)', 'https://', 'data:image/png;base64,AA', 42, null, undefined]
  for (const value of rejected) expect(isHttpUrl(value)).toBe(false)
})

test('trimTrailingSlashes drops every trailing slash and nothing else', () => {
  expect(trimTrailingSlashes('https://example.org/fhir///')).toBe('https://example.org/fhir')
  expect(trimTrailingSlashes('https://example.org/fhir')).toBe('https://example.org/fhir')
  expect(trimTrailingSlashes('///')).toBe('')
  expect(trimTrailingSlashes('')).toBe('')
  expect(trimTrailingSlashes('/a//b/')).toBe('/a//b')
})

test('trimTrailingSlashes stays linear on slash runs that do not end the string', () => {
  const hostile = `${'/'.repeat(200_000)}x`
  const started = performance.now()
  expect(trimTrailingSlashes(hostile)).toBe(hostile)
  expect(performance.now() - started).toBeLessThan(50)
})

test('sameOrigin compares scheme, host and port, never the path', () => {
  expect(sameOrigin('https://example.org/auth/realms/main', 'https://example.org')).toBe(true)
  expect(sameOrigin('https://auth.example.org/realms/main', 'https://example.org')).toBe(false)
  expect(sameOrigin('http://example.org', 'https://example.org')).toBe(false)
  expect(sameOrigin('https://example.org:8443', 'https://example.org')).toBe(false)
  expect(sameOrigin('not a url', 'https://example.org')).toBe(false)
})
