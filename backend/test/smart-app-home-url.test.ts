// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The Home URL an admin update stores, which Keycloak and /auth/return offer as "Back to
 * application". dicom-viewer kept a baseUrl of the proxy's public site, so every way back led
 * to proxy-smart.com and no admin update could change it.
 */

import { describe, it, expect } from 'bun:test'

process.env.BASE_URL = 'https://api.proxy.example.com'
process.env.SITE_URL = 'https://proxy.example.com'

const { buildUpdateRepresentation } = await import('@/routes/admin/smart-apps/update-representation')

const existing = {
  id: 'internal-id',
  clientId: 'dicom-viewer',
  publicClient: true,
  baseUrl: 'https://proxy.example.com',
  redirectUris: ['https://app.example.com/*', 'https://proxy.example.com/auth/smart-callback'],
  attributes: { launch_url: 'https://app.example.com' },
}

describe('Home URL on update', () => {
  it('replaces a stored Home URL that is the proxy site root', () => {
    expect(buildUpdateRepresentation({}, existing).baseUrl).toBe('https://app.example.com/')
  })

  it('takes an explicit homeUrl over anything stored or derived', () => {
    expect(buildUpdateRepresentation({ homeUrl: 'https://app.example.com/studies' }, existing).baseUrl)
      .toBe('https://app.example.com/studies')
  })

  it('derives again when the homeUrl is cleared', () => {
    const custom = { ...existing, baseUrl: 'https://custom.example.com' }
    expect(buildUpdateRepresentation({ homeUrl: '' }, custom).baseUrl).toBe('https://app.example.com/')
  })

  it('keeps a Home URL an operator set on another host', () => {
    const custom = { ...existing, baseUrl: 'https://custom.example.com' }
    expect(buildUpdateRepresentation({}, custom).baseUrl).toBe('https://custom.example.com')
  })

  it('keeps an app served under a proxy path', () => {
    const portal = { ...existing, baseUrl: 'https://proxy.example.com/apps/patient-portal' }
    expect(buildUpdateRepresentation({}, portal).baseUrl).toBe('https://proxy.example.com/apps/patient-portal')
  })
})
