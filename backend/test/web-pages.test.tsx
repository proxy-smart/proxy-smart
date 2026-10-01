// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import type { FC } from 'hono/jsx'
import { renderToString } from '../src/web/render'
import { authErrorPage, kcUnavailablePage } from '../src/web/status-pages'
import { InstancePage, instanceView, type InstanceView } from '../src/web/instance-page'
import { parseEnforcementMode } from '../src/lib/enforcement-mode'
import { discoveredApp as app } from './helpers/discovered-app'

function instance(overrides: Partial<InstanceView> = {}): string {
  return renderToString(<InstancePage view={{ ...instanceView([app()]), ...overrides }} />)
}

describe('instance page', () => {
  it('escapes the brand and server names it renders', () => {
    const html = instance({
      brand: { name: '<script>alert(1)</script>', logoUrl: null },
      servers: [{ name: '<img src=x onerror=alert(1)>', fhirVersion: 'R4', baseUrl: 'https://api.example/proxy/hapi/R4' }],
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('https://api.example/proxy/hapi/R4/.well-known/smart-configuration')
  })

  it('links the admin console only when the deployment opts in', () => {
    expect(instance({ showAdmin: false })).not.toContain('href="/webapp/"')
    expect(instance({ showAdmin: true })).toContain('href="/webapp/"')
  })

  it('names the product once when the deployment runs under the product brand', () => {
    expect(instance({ brand: { name: 'Proxy Smart', logoUrl: null } })).toContain('<title>Proxy Smart</title>')
    expect(instance({ brand: { name: 'Acme Health', logoUrl: null } })).toContain('<title>Acme Health · Proxy Smart</title>')
  })

  it('says so when no FHIR server is registered', () => {
    expect(instance({ servers: [] })).toContain('instance-empty')
  })

  it('carries no marketing copy', () => {
    const html = instance()
    expect(html).not.toContain('Healthcare Auth')
    expect(html).not.toContain('faq-item')
  })
})

describe('renderToString', () => {
  it('rejects an async component instead of emitting [object Promise]', () => {
    const Async: FC = async () => <p>late</p>
    expect(() => renderToString(<div><Async /></div>)).toThrow()
  })
})

describe('status pages', () => {
  it('keeps the status code and escapes the error text', async () => {
    const res = authErrorPage({ status: 400, error: 'invalid_request', errorDescription: '<img src=x onerror=alert(1)>' })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(body).not.toContain('<img src=x')
  })

  it('tells clients when to retry while Keycloak is down', () => {
    const res = kcUnavailablePage()
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
  })
})

describe('parseEnforcementMode', () => {
  it('accepts the three modes and falls back on anything else', () => {
    expect(parseEnforcementMode('enforce', 'disabled')).toBe('enforce')
    expect(parseEnforcementMode('audit-only', 'enforce')).toBe('audit-only')
    expect(parseEnforcementMode('ENFORCE', 'audit-only')).toBe('audit-only')
    expect(parseEnforcementMode(undefined, 'disabled')).toBe('disabled')
  })
})
