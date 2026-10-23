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
const { reconcileClientHomeUrls } = await import('@/lib/kc-system-provisioning')
const { fakeKcAdmin } = await import('./helpers/keycloak-admin')

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

describe('Home URL reconcile', () => {
  const seeded = {
    id: 'portal-id',
    clientId: 'patient-portal',
    baseUrl: 'https://proxy.example.com',
    redirectUris: ['https://patient.example.com/*'],
    attributes: { client_type: 'standalone-app', launch_url: 'https://patient.example.com/' },
  }

  it('replaces the proxy site root on an export-seeded app, which carries no smart_app marker', async () => {
    const fake = fakeKcAdmin({ clients: [seeded] })
    expect(await reconcileClientHomeUrls(fake.admin)).toEqual([{ clientId: 'patient-portal', baseUrl: 'https://patient.example.com/' }])
    expect(fake.updated).toEqual([{ id: 'portal-id', payload: { baseUrl: 'https://patient.example.com/' } }])
  })

  it('leaves a Home URL an operator set, and clients that are not SMART apps', async () => {
    const fake = fakeKcAdmin({ clients: [
      { ...seeded, baseUrl: 'https://custom.example.com' },
      { id: 'account-id', clientId: 'account', baseUrl: 'https://proxy.example.com', redirectUris: ['https://patient.example.com/*'] },
    ] })
    expect(await reconcileClientHomeUrls(fake.admin)).toEqual([])
    expect(fake.updated).toEqual([])
  })
})
