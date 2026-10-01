// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'

mockLoggerModule()

const { brandToAttributes, hasBrandAttributes, parseBrandAttributes } = await import('../src/lib/brand-attributes')
const { getAttr } = await import('../src/lib/keycloak-component-config')

describe('brand attribute codec', () => {
  it('round-trips the theming colours and app store URL through flat attributes', () => {
    const attrs = brandToAttributes({ name: 'Clinic', primaryColor: '#00d294', accentColor: null, appStoreUrl: 'https://apps.example.com' })

    expect(attrs).toEqual({
      'brand_settings.name': 'Clinic',
      'brand_settings.primary_color': '#00d294',
      'brand_settings.accent_color': '',
      'brand_settings.app_store_url': 'https://apps.example.com',
    })
    expect(parseBrandAttributes((key) => attrs[key])).toEqual({
      name: 'Clinic',
      primaryColor: '#00d294',
      accentColor: null,
      appStoreUrl: 'https://apps.example.com',
    })
  })

  it('drops an unknown category instead of storing it', () => {
    const parsed = parseBrandAttributes((key) => ({ 'brand_settings.category': 'nonsense' })[key])
    expect(parsed.category).toBeUndefined()
  })

  it('reads organization attributes stored as Keycloak string arrays', () => {
    const attrs = { 'brand_settings.aliases': ['a, b'], 'brand_settings.category': ['laboratory'] }
    expect(parseBrandAttributes((key) => getAttr(attrs, key))).toEqual({ aliases: ['a', 'b'], category: 'laboratory' })
  })

  it('detects whether any brand setting is stored', () => {
    expect(hasBrandAttributes(['consent.enabled'])).toBe(false)
    expect(hasBrandAttributes(['consent.enabled', 'brand_settings.name'])).toBe(true)
  })
})
