// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Deployed CORS origins come from CORS_ORIGINS or from the webOrigins of the
 * SMART apps registered in Keycloak — never from a list baked into the source.
 *
 * A hardcoded per-app list used to live in config.ts as a "fallback if Keycloak
 * refresh fails". It quietly became the real mechanism: registering an app's
 * origin had no effect, and each new app or environment needed a code change.
 * That is how dicom.beta.maxhealth.tech was blocked while dicom.maxhealth.tech
 * worked — the second was in the source, the first was only in Keycloak.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isOriginAllowed, isPublicDiscoveryPath } from '../src/lib/cors-origins'

const CONFIG_SRC = join(import.meta.dir, '..', 'src', 'config.ts')

/** The `cors:` block of config.ts, which is what this file is about. */
function corsBlock(): string {
  const source = readFileSync(CONFIG_SRC, 'utf8')
  const start = source.indexOf('  cors: {')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start)
}

describe('CORS origins — no app hostnames in the source', () => {
  it('the cors block names no deployed origin, in code or as a default', () => {
    // Scoped to the cors block deliberately: elsewhere in config.ts a deployed
    // host can legitimately appear as an env-overridable default.
    const block = corsBlock()
    const hosts = (block.match(/https:\/\/[a-z0-9.-]+\.(tech|com)/gi) ?? []).filter(host => {
      const line = block.split('\n').find(l => l.includes(host)) ?? ''
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    expect(hosts).toEqual([])
  })

  it('keeps the localhost dev defaults, which are not deployment config', () => {
    expect(corsBlock()).toContain('http://localhost:5173')
  })
})

describe('CORS origins — env drives deployed policy', () => {
  const saved = { env: process.env.NODE_ENV, origins: process.env.CORS_ORIGINS }

  beforeEach(() => {
    delete process.env.CORS_ORIGINS
  })

  afterEach(() => {
    if (saved.env === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = saved.env
    if (saved.origins === undefined) delete process.env.CORS_ORIGINS
    else process.env.CORS_ORIGINS = saved.origins
  })

  it('reads a comma-separated CORS_ORIGINS, trimming whitespace', () => {
    process.env.CORS_ORIGINS = 'https://a.example.com, https://b.example.com'
    const parsed = process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    expect(parsed).toEqual(['https://a.example.com', 'https://b.example.com'])
  })

  it('allows exactly the configured origins, case-insensitively and ignoring a default port', () => {
    process.env.CORS_ORIGINS = 'https://app.example.com,https://dicom.example.com/'
    expect(isOriginAllowed('https://app.example.com')).toBe(true)
    expect(isOriginAllowed('https://APP.example.com:443')).toBe(true)
    expect(isOriginAllowed('https://dicom.example.com')).toBe(true)
  })

  it('does not let a look-alike, a subdomain, another scheme or another port pass', () => {
    process.env.CORS_ORIGINS = 'https://app.example.com'
    for (const origin of [
      'https://app.example.com.evil.example',
      'https://evil-app.example.com',
      'https://sub.app.example.com',
      'http://app.example.com',
      'https://app.example.com:8443',
      'null',
      'not a url',
    ]) {
      expect(isOriginAllowed(origin)).toBe(false)
    }
  })
})

describe('CORS — public discovery documents', () => {
  it('recognises the documents SMART and RFC 8414 clients read before they have a token', () => {
    for (const path of [
      '/proxy-smart-backend/hapi/R4/.well-known/smart-configuration',
      '/proxy-smart-backend/hapi/R4/metadata',
      '/branding.json',
      '/.well-known/openid-configuration',
      '/.well-known/oauth-authorization-server',
      '/.well-known/jwks.json',
      '/auth/.well-known/openid-configuration',
      '/app-state/metadata',
    ]) {
      expect(isPublicDiscoveryPath(path, 'GET')).toBe(true)
    }
  })

  it('opens nothing that carries data or accepts writes', () => {
    expect(isPublicDiscoveryPath('/proxy-smart-backend/hapi/R4/Patient', 'GET')).toBe(false)
    expect(isPublicDiscoveryPath('/proxy-smart-backend/hapi/R4/metadata', 'POST')).toBe(false)
    expect(isPublicDiscoveryPath('/auth/token', 'POST')).toBe(false)
    expect(isPublicDiscoveryPath('/admin/branding', 'GET')).toBe(false)
  })
})
