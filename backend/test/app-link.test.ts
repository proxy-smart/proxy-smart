// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock } from 'bun:test'
import * as realDiscovery from '../src/lib/app-discovery'
import type { DiscoveredApp } from '../src/lib/app-discovery'

process.env.BASE_URL = 'https://api.example.org'

interface FakeClient {
  clientId: string
  name?: string
  enabled?: boolean
  baseUrl?: string
  attributes?: Record<string, string>
}

const clients: FakeClient[] = [
  { clientId: 'consent-registered', name: 'Consent', baseUrl: 'https://consent.example.org/', attributes: { launch_url: 'https://consent.example.org/launch' } },
  { clientId: 'disabled-app', enabled: false, attributes: { launch_url: 'https://off.example.org/launch' } },
  { clientId: 'no-home', attributes: { launch_url: 'https://viewer.example.org/launch' } },
]

const admin = {
  clients: { find: async ({ clientId }: { clientId: string }) => clients.filter((c) => c.clientId === clientId) },
}

mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: async () => admin,
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

const filesystemApp: DiscoveredApp = {
  id: 'consent-app', launch_url: '/apps/consent-app/', client_id: 'consent-bundled', client_name: 'Bundled Consent',
  description: '', scope: '', category: 'other', icon: '', grant_types: ['authorization_code'],
  token_endpoint_auth_method: 'none', hidden: true, source: 'filesystem',
}

mock.module('@/lib/app-discovery', () => ({
  ...realDiscovery,
  discoverApps: () => [filesystemApp],
}))

const { resolveAppLink, resolveAppOrUrl } = await import('../src/lib/client-launch-url')

describe('a SMART app named by a setting', () => {
  it('opens a registered app at its Home URL and launches it at its launch URL', async () => {
    expect(await resolveAppLink('consent-registered')).toEqual({
      clientId: 'consent-registered',
      name: 'Consent',
      launchUrl: 'https://consent.example.org/launch',
      entryUrl: 'https://consent.example.org/',
    })
  })

  it('opens an app without a Home URL at its launch URL', async () => {
    expect((await resolveAppLink('no-home'))?.entryUrl).toBe('https://viewer.example.org/launch')
  })

  it('finds an app bundled with the proxy, hidden from the App Store or not', async () => {
    expect(await resolveAppLink('consent-bundled')).toEqual({
      clientId: 'consent-bundled',
      name: 'Bundled Consent',
      launchUrl: '/apps/consent-app/',
      entryUrl: 'https://api.example.org/apps/consent-app/',
    })
  })

  it('ignores a disabled client', async () => {
    expect(await resolveAppLink('disabled-app')).toBeNull()
  })
})

describe('an app-or-URL setting', () => {
  it('prefers the chosen app over the URL', async () => {
    expect(await resolveAppOrUrl('consent-registered', 'https://fallback.example.org/')).toBe('https://consent.example.org/')
  })

  it('falls back to the URL when the app cannot be resolved', async () => {
    expect(await resolveAppOrUrl('missing-app', 'https://fallback.example.org/')).toBe('https://fallback.example.org/')
    expect(await resolveAppOrUrl('disabled-app', null)).toBeNull()
  })

  it('uses the URL when no app is chosen', async () => {
    expect(await resolveAppOrUrl(null, 'https://fallback.example.org/')).toBe('https://fallback.example.org/')
  })
})
