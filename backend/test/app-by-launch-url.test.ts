// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'

process.env.BASE_URL = 'https://api.proxy-smart.com'
const { matchAppByLaunchUrl } = await import('../src/lib/client-launch-url')

const client = (clientId: string, launchUrl: string | undefined, enabled = true) => ({
  clientId,
  enabled,
  attributes: launchUrl === undefined ? {} : { launch_url: launchUrl },
})

describe('which registered app a launch URL belongs to', () => {
  it('finds the client registered with that launch URL', () => {
    const clients = [client('a', 'https://a.example.org/launch'), client('b', 'https://b.example.org/launch')]
    expect(matchAppByLaunchUrl(clients, 'https://b.example.org/launch')).toEqual({
      status: 'found',
      app: { clientId: 'b', launchUrl: 'https://b.example.org/launch' },
    })
  })

  it('ignores a trailing slash, a fragment and the case of the host', () => {
    const clients = [client('a', 'https://A.example.org/launch/')]
    expect(matchAppByLaunchUrl(clients, 'https://a.example.org/launch#x').status).toBe('found')
  })

  it('tells apart launch URLs that differ in path or query', () => {
    const clients = [client('a', 'https://a.example.org/launch?tenant=1')]
    expect(matchAppByLaunchUrl(clients, 'https://a.example.org/launch?tenant=2').status).toBe('absent')
    expect(matchAppByLaunchUrl(clients, 'https://a.example.org/other?tenant=1').status).toBe('absent')
  })

  it('resolves a launch URL registered relative to the proxy', () => {
    const clients = [client('portal', '/apps/patient-portal/')]
    expect(matchAppByLaunchUrl(clients, 'https://api.proxy-smart.com/apps/patient-portal/')).toEqual({
      status: 'found',
      app: { clientId: 'portal', launchUrl: 'https://api.proxy-smart.com/apps/patient-portal/' },
    })
  })

  it('skips disabled clients and clients without a launch URL', () => {
    const clients = [client('off', 'https://a.example.org/launch', false), client('none', undefined)]
    expect(matchAppByLaunchUrl(clients, 'https://a.example.org/launch').status).toBe('absent')
  })

  it('refuses to guess between two clients registered with the same launch URL', () => {
    const clients = [client('a', 'https://a.example.org/launch'), client('b', 'https://a.example.org/launch')]
    expect(matchAppByLaunchUrl(clients, 'https://a.example.org/launch')).toEqual({ status: 'ambiguous', clientIds: ['a', 'b'] })
  })

  it('matches nothing for a URL that does not parse', () => {
    expect(matchAppByLaunchUrl([client('a', 'https://a.example.org/')], 'not a url').status).toBe('absent')
  })
})
