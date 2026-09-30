// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { AppStorePage, appStoreView } from '../src/web/app-store-page'
import { renderToString } from '../src/web/render'
import type { DiscoveredApp } from '../src/lib/app-discovery'
import { discoveredApp } from './helpers/discovered-app'

const ORIGINAL = process.env.APP_STORE_SHOW_ADMIN

function render(apps: DiscoveredApp[] = [discoveredApp()], query = {}): string {
  return renderToString(<AppStorePage view={appStoreView(apps, query)} />)
}

const hasAdminLink = (html: string) => html.includes('href="/webapp/"')

describe('app store admin link', () => {
  beforeEach(() => { delete process.env.APP_STORE_SHOW_ADMIN })
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.APP_STORE_SHOW_ADMIN
    else process.env.APP_STORE_SHOW_ADMIN = ORIGINAL
  })

  it('is left out of the markup when the deployment sets nothing', () => {
    expect(hasAdminLink(render())).toBe(false)
  })

  it('stays out for any value that is not exactly "true"', () => {
    for (const value of ['false', '1', 'yes', 'TRUE', '']) {
      process.env.APP_STORE_SHOW_ADMIN = value
      expect(hasAdminLink(render())).toBe(false)
    }
  })

  it('appears only when the deployment opts in', () => {
    process.env.APP_STORE_SHOW_ADMIN = 'true'
    expect(hasAdminLink(render())).toBe(true)
  })

  it('no longer honours the old opt-out name, which defaulted to showing', () => {
    process.env.APP_STORE_HIDE_ADMIN = 'false'
    try {
      expect(hasAdminLink(render())).toBe(false)
    } finally {
      delete process.env.APP_STORE_HIDE_ADMIN
    }
  })
})

describe('app store tiles', () => {
  it('escapes app names and drops launch and logo URLs that could run script', () => {
    const html = render([discoveredApp({
      client_name: '<img src=x onerror=alert(1)>',
      description: '" onmouseover="alert(1)',
      launch_url: 'javascript:alert(1)',
      logoUri: 'data:image/svg+xml,<svg onload=alert(1)>',
    })])
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('onmouseover="alert')
    expect(html).not.toContain('javascript:alert')
    expect(html).not.toContain('data:image/svg')
  })

  it('falls back to the generic glyph for an icon key outside the curated set', () => {
    const known = render([discoveredApp({ icon: 'app-window' })])
    const unknown = render([discoveredApp({ icon: '__proto__' })])
    expect(unknown).toBe(known)
  })
})

describe('app store pagination', () => {
  const many = Array.from({ length: 40 }, (_, i) => discoveredApp({ id: `a${i}`, client_id: `a${i}`, client_name: `App ${i}` }))

  it('clamps an out-of-range page to the last one', () => {
    const view = appStoreView(many, { page: '99' })
    expect(view.page).toBe(view.pages)
    expect(view.apps.length).toBeGreaterThan(0)
  })

  it('treats a missing or malformed page as the first', () => {
    expect(appStoreView(many, { page: 'abc' }).page).toBe(1)
    expect(appStoreView(many, {}).page).toBe(1)
  })

  it('falls back to medium tiles for an unknown size', () => {
    expect(appStoreView(many, { size: 'xl' }).size).toBe('md')
  })

  it('pages more densely with smaller tiles', () => {
    expect(appStoreView(many, { size: 'sm' }).pages).toBeLessThan(appStoreView(many, { size: 'lg' }).pages)
  })

  it('shows the empty state instead of a grid when nothing is published', () => {
    const html = render([])
    expect(html).toContain('store-empty')
    expect(html).not.toContain('class="tiles')
  })
})
