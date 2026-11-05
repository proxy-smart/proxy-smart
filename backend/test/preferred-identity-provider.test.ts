// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { buildCreatePlan } from '../src/routes/admin/smart-apps/create-representation'
import { buildUpdateRepresentation } from '../src/routes/admin/smart-apps/update-representation'
import { preferredIdentityProviderRejection } from '../src/routes/admin/smart-apps/preferred-identity-provider'
import { createClientConfigCache } from '../src/lib/smart-client-config-cache'

const providers = {
  maxhealth: { alias: 'maxhealth', enabled: true },
  retired: { alias: 'retired', enabled: false },
  linking: { alias: 'linking', enabled: true, linkOnly: true },
}
const find = async (alias: string) => Object.values(providers).find((p) => p.alias === alias)

describe('the preferred identity provider of a SMART app', () => {
  it('is stored as a client attribute on create, and cleared by an empty update', () => {
    const { representation } = buildCreatePlan({ clientId: 'aihr', name: 'AIHR', preferredIdentityProvider: 'maxhealth' })
    expect(representation.attributes).toMatchObject({ preferred_identity_provider: 'maxhealth' })
    const cleared = buildUpdateRepresentation({ preferredIdentityProvider: '' }, { id: 'id', clientId: 'aihr', attributes: { preferred_identity_provider: 'maxhealth' } })
    expect(cleared.attributes?.preferred_identity_provider).toBe('')
  })

  it('must name an enabled provider that signs people in', async () => {
    expect(await preferredIdentityProviderRejection(find, 'maxhealth')).toBeNull()
    expect(await preferredIdentityProviderRejection(find, '')).toBeNull()
    expect(await preferredIdentityProviderRejection(find, 'nobody')).toContain('No identity provider')
    expect(await preferredIdentityProviderRejection(find, 'retired')).toContain('disabled')
    expect(await preferredIdentityProviderRejection(find, 'linking')).toContain('only links accounts')
  })

  it('is read from the client registration, and an outage only leaves the choice to the user', async () => {
    const cache = createClientConfigCache(async (clientId) => clientId === 'aihr'
      ? { status: 'found', config: { redirectUris: [], preferredIdentityProvider: 'maxhealth' } }
      : { status: 'unavailable', reason: 'Keycloak down' })
    expect(await cache.getPreferredIdentityProvider('aihr')).toBe('maxhealth')
    expect(await cache.getPreferredIdentityProvider('other')).toBeUndefined()
  })
})
