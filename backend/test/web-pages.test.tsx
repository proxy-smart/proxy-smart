// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import type { FC } from 'hono/jsx'
import { renderToString, safeUrl } from '../src/web/render'
import { authErrorPage, kcUnavailablePage } from '../src/web/status-pages'
import { LandingPage, loadLandingData } from '../src/web/landing'
import { faqJsonLd } from '../src/web/landing/faq'
import { parseEnforcementMode } from '../src/lib/enforcement-mode'
import type { DiscoveredApp } from '../src/lib/app-discovery'

function app(overrides: Partial<DiscoveredApp>): DiscoveredApp {
  return {
    id: 'probe', launch_url: '/apps/probe/', client_id: 'probe', client_name: 'Probe', description: '', scope: '',
    category: 'clinical', icon: 'user', grant_types: ['authorization_code'], token_endpoint_auth_method: 'none',
    hidden: false, source: 'filesystem', ...overrides,
  }
}

function landing(apps: DiscoveredApp[]): string {
  return renderToString(<LandingPage data={loadLandingData(apps)} />)
}

describe('landing page', () => {
  it('escapes app-supplied text and drops launch or logo URLs that could run script', () => {
    const html = landing([app({
      client_name: '<script>alert(1)</script>',
      launch_url: 'javascript:alert(1)',
      logoUri: '//evil.example/logo.svg',
    })])
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('javascript:alert')
    expect(html).not.toContain('evil.example')
  })

  it('omits the published-apps grid when the deployment has none', () => {
    expect(landing([])).not.toContain('app-grid')
  })

  it('publishes exactly the questions it shows, with no raw closing tag inside the JSON-LD', () => {
    const data = loadLandingData([])
    const html = landing([])
    const visible = html.match(/<details class="faq-item">/g)?.length ?? 0
    expect(faqJsonLd(data).mainEntity).toHaveLength(visible)
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const body of scripts) expect(body).not.toContain('<')
  })
})

describe('renderToString', () => {
  it('rejects an async component instead of emitting [object Promise]', () => {
    const Async: FC = async () => <p>late</p>
    expect(() => renderToString(<div><Async /></div>)).toThrow()
  })
})

describe('safeUrl', () => {
  it.each([
    ['/apps/consent/', '/apps/consent/'],
    ['https://cdn.example/logo.png', 'https://cdn.example/logo.png'],
    ['http://cdn.example/logo.png', null],
    ['javascript:alert(1)', null],
    ['//evil.example/x', null],
    ['/\\evil.example/x', null],
    ['', null],
  ])('%s -> %s', (input, expected) => {
    expect(safeUrl(input)).toBe(expected)
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
