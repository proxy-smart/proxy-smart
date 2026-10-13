// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'

mockLoggerModule()

import { ensureAdvertisedScopes } from '../src/lib/smart-scope-provisioning'
import { smartScopesSupported } from '../src/lib/smart-config'
import { config } from '../src/config'

interface CreatedScope { name?: string; attributes?: Record<string, string> }

function realm(existing: string[], options: { failing?: boolean } = {}) {
  const created: CreatedScope[] = []
  const admin = {
    clientScopes: {
      find: async () => {
        if (options.failing) throw new Error('Keycloak unreachable')
        return existing.map((name) => ({ id: `id-${name}`, name }))
      },
      create: async (scope?: CreatedScope) => {
        if (scope) created.push(scope)
        return { id: `id-${scope?.name}` }
      },
    },
  }
  return { admin, created }
}

describe('ensureAdvertisedScopes', () => {
  it('creates the advertised SMART scopes Keycloak lacks, so canonical requests do not fail with invalid_scope', async () => {
    const { admin, created } = realm(['openid', 'profile', 'patient/*.read'])

    await ensureAdvertisedScopes(admin)
    const names = created.map((scope) => scope.name)

    expect(names).toEqual(expect.arrayContaining(['patient/*.rs', 'patient/*.cruds', 'user/*.rs', 'system/*.rs', 'fhirUser']))
    expect(names).not.toContain('openid')
    expect(names).not.toContain('patient/*.read')
  })

  it('creates the introspection scope, carried in the token scope and kept off the consent screen', async () => {
    const { admin, created } = realm(['openid'])

    await ensureAdvertisedScopes(admin)
    const introspection = created.find((scope) => scope.name === config.smart.introspectionScope)

    expect(introspection?.attributes?.['include.in.token.scope']).toBe('true')
    expect(introspection?.attributes?.['display.on.consent.screen']).toBe('false')
  })

  it('creates nothing when every scope exists', async () => {
    const { admin, created } = realm([...smartScopesSupported(), config.smart.introspectionScope])

    await ensureAdvertisedScopes(admin)

    expect(created).toHaveLength(0)
  })

  it('does not fail startup when Keycloak cannot be read', async () => {
    const { admin } = realm([], { failing: true })
    await expect(ensureAdvertisedScopes(admin)).resolves.toBeUndefined()
  })
})
