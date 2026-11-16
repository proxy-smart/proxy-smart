// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The login theme's proxy-context.js, the browser half of /auth/login-brand.css and /auth/return.
 *
 * It ships as a Keycloak theme asset, so nothing else compiles or type-checks it. These tests run
 * the actual file against a minimal DOM.
 */
import { describe, it, expect } from 'bun:test'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL.pathname: on Windows the latter yields a leading-slash "/C:/…".
const SCRIPT_PATH = fileURLToPath(
  new URL('../../keycloak/themes/proxy-smart/login/resources/js/proxy-context.js', import.meta.url),
)

const source = await Bun.file(SCRIPT_PATH).text()

interface FakeLink { rel?: string; href?: string; tagName: string }

class FakeAnchor {
  constructor(private href: string) {}
  getAttribute(name: string) { return name === 'href' ? this.href : null }
  setAttribute(name: string, value: string) { if (name === 'href') this.href = value }
}

const KC_PAGE = 'https://auth.example.com/realms/proxy-smart/protocol/openid-connect/auth'
const BASE_SRC = 'https://auth.example.com/resources/abc/login/proxy-smart/js/proxy-context.js'

function run(options: { search: string; scriptSrc?: string; storage?: Map<string, string>; backLink?: FakeAnchor; page?: string }) {
  const appended: FakeLink[] = []
  const storage = options.storage ?? new Map<string, string>()
  const document = {
    currentScript: options.scriptSrc ? { src: options.scriptSrc } : null,
    readyState: 'complete',
    createElement: (tagName: string): FakeLink => ({ tagName }),
    getElementById: (id: string) => (id === 'backToApplication' ? options.backLink ?? null : null),
    addEventListener: () => {},
    head: { appendChild: (node: FakeLink) => appended.push(node) },
  }
  const window = {
    location: { search: options.search, href: (options.page ?? KC_PAGE) + options.search },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    },
  }
  new Function('window', 'document', 'URL', 'URLSearchParams', source)(window, document, URL, URLSearchParams)
  return { appended, storage }
}

describe('proxy-context.js: brand accent', () => {
  it('links the accent stylesheet for the launching client', () => {
    const { appended: [link] } = run({ search: '?client_id=org-app&response_type=code', scriptSrc: BASE_SRC })
    expect(link?.rel).toBe('stylesheet')
    expect(link?.href).toBe('/auth/login-brand.css?client_id=org-app')
  })

  it('carries the client_id of a secondary page such as a failed password', () => {
    const { appended: [link] } = run({ search: '?session_code=abc&client_id=brand-test&tab_id=xyz', scriptSrc: BASE_SRC })
    expect(link?.href).toContain('client_id=brand-test')
  })

  it('does nothing on a page with no client_id', () => {
    expect(run({ search: '', scriptSrc: BASE_SRC }).appended).toHaveLength(0)
  })

  it('escapes a client_id so it cannot break out of the query string', () => {
    const { appended: [link] } = run({ search: '?client_id=' + encodeURIComponent('a&b=c'), scriptSrc: BASE_SRC })
    expect(link?.href).toBe('/auth/login-brand.css?client_id=a%26b%3Dc')
  })

  it('honours a cross-origin base passed through the script src', () => {
    const { appended: [link] } = run({ search: '?client_id=x', scriptSrc: BASE_SRC + '?base=https://api.example.com' })
    expect(link?.href).toBe('https://api.example.com/auth/login-brand.css?client_id=x')
  })

  it('ignores an unsubstituted base placeholder', () => {
    const { appended: [link] } = run({ search: '?client_id=x', scriptSrc: BASE_SRC + '?base=${env.PROXY_PUBLIC_URL}' })
    expect(link?.href).toBe('/auth/login-brand.css?client_id=x')
  })
})

describe('proxy-context.js: back to application', () => {
  const PROXY = 'https://proxy.example.com'
  const src = BASE_SRC + '?base=' + PROXY

  it('remembers the client while the login page is open', () => {
    const { storage } = run({ search: '?client_id=dicom-viewer', scriptSrc: src })
    expect([...storage.values()]).toEqual(['dicom-viewer'])
  })

  it('sends the error page fallback to the client the login started from', () => {
    const storage = new Map<string, string>()
    run({ search: '?client_id=dicom-viewer', scriptSrc: src, storage })
    const backLink = new FakeAnchor(`${PROXY}/auth/return`)
    run({ search: '?state=x&code=y', scriptSrc: src, storage, backLink, page: 'https://auth.example.com/realms/proxy-smart/broker/maxhealth/endpoint' })
    expect(backLink.getAttribute('href')).toBe(`${PROXY}/auth/return?client_id=dicom-viewer`)
  })

  it('works when the proxy shares the Keycloak origin', () => {
    const storage = new Map([['proxy-smart.login-client', 'app']])
    const backLink = new FakeAnchor('https://auth.example.com/auth/return')
    run({ search: '', scriptSrc: BASE_SRC, storage, backLink })
    expect(backLink.getAttribute('href')).toBe('https://auth.example.com/auth/return?client_id=app')
  })

  it("leaves a link to the client's own home alone", () => {
    const storage = new Map([['proxy-smart.login-client', 'app']])
    const backLink = new FakeAnchor('https://app.example.com/')
    run({ search: '', scriptSrc: src, storage, backLink })
    expect(backLink.getAttribute('href')).toBe('https://app.example.com/')
  })

  it('leaves the fallback alone when no login was remembered', () => {
    const backLink = new FakeAnchor(`${PROXY}/auth/return`)
    run({ search: '', scriptSrc: src, backLink })
    expect(backLink.getAttribute('href')).toBe(`${PROXY}/auth/return`)
  })
})
