// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type OrganizationIdentityProviderLinkRepresentation from '@keycloak/keycloak-admin-client/lib/defs/organizationIdentityProviderLinkRepresentation.js'
import { maskedSecretDestinationChanges } from '../src/lib/idp-secret-destination'
import {
  linkedOrganizationIds,
  requestedOrganizationIds,
  syncOrganizationLinks,
  unknownOrganizationIds,
} from '../src/lib/idp-organization-links'
import { MASKED_SECRET } from '../src/lib/secret-mask'

const STORED = {
  clientId: 'proxy',
  clientSecret: MASKED_SECRET,
  tokenUrl: 'https://idp.example.com/token',
  authorizationUrl: 'https://idp.example.com/auth',
}

describe('masked client secret and its destination (CVE-2026-15943)', () => {
  it('lets the mask through while nothing that routes the secret changes', () => {
    const submitted = { ...STORED, authorizationUrl: 'https://idp.example.com/v2/auth', displayName: 'Hospital' }
    expect(maskedSecretDestinationChanges('oidc', STORED, submitted)).toEqual([])
  })

  it('names every destination key that changed while the mask is still sent', () => {
    const submitted = { ...STORED, tokenUrl: 'https://evil.example.com/token', clientId: 'other' }
    expect(maskedSecretDestinationChanges('oidc', STORED, submitted).sort()).toEqual(['clientId', 'tokenUrl'])
  })

  it('accepts any change once the actual secret is sent again', () => {
    const submitted = { ...STORED, clientSecret: 's3cret', tokenUrl: 'https://new.example.com/token' }
    expect(maskedSecretDestinationChanges('oidc', STORED, submitted)).toEqual([])
  })

  it('treats an unset clientAuthMethod as client_secret_post, as Keycloak does at runtime', () => {
    expect(maskedSecretDestinationChanges('oidc', STORED, { ...STORED, clientAuthMethod: 'client_secret_post' })).toEqual([])
    expect(maskedSecretDestinationChanges('oidc', STORED, { ...STORED, clientAuthMethod: 'client_secret_basic' }))
      .toEqual(['clientAuthMethod'])
  })

  it('treats blank and missing values alike', () => {
    expect(maskedSecretDestinationChanges('oidc', STORED, { ...STORED, tokenIntrospectionUrl: '' })).toEqual([])
  })

  it('applies the provider-specific keys with their defaults', () => {
    const microsoft = { clientId: 'app', clientSecret: MASKED_SECRET }
    expect(maskedSecretDestinationChanges('microsoft', microsoft, { ...microsoft, tenantId: 'common' })).toEqual([])
    expect(maskedSecretDestinationChanges('microsoft', microsoft, { ...microsoft, tenantId: 'contoso' })).toEqual(['tenantId'])
    const paypal = { clientId: 'app', clientSecret: MASKED_SECRET }
    expect(maskedSecretDestinationChanges('paypal', paypal, { ...paypal, sandbox: false })).toEqual([])
    expect(maskedSecretDestinationChanges('paypal', paypal, { ...paypal, sandbox: true })).toEqual(['sandbox'])
  })

  it('leaves providers without an OAuth2 client secret to Keycloak', () => {
    const saml = { singleSignOnServiceUrl: 'https://idp.example.com/sso', clientSecret: MASKED_SECRET }
    expect(maskedSecretDestinationChanges('saml', saml, { ...saml, tokenUrl: 'https://x' })).toEqual([])
  })
})

describe('organization links on an identity provider (Keycloak 26.8 many-to-many)', () => {
  it('reads organizationLinks, falling back to the deprecated organizationId', () => {
    expect(linkedOrganizationIds({ organizationLinks: [{ organizationId: 'a' }, { organizationId: 'b' }] })).toEqual(['a', 'b'])
    expect(linkedOrganizationIds({ organizationId: 'legacy' })).toEqual(['legacy'])
    expect(linkedOrganizationIds({})).toEqual([])
  })

  it('takes organizationIds over organizationId, and leaves links alone when neither is sent', () => {
    expect(requestedOrganizationIds({ organizationIds: ['a', 'a', 'b'], organizationId: 'c' })).toEqual(['a', 'b'])
    expect(requestedOrganizationIds({ organizationId: 'c' })).toEqual(['c'])
    expect(requestedOrganizationIds({ organizationId: '' })).toEqual([])
    expect(requestedOrganizationIds({})).toBeUndefined()
  })

  function fakeOrganizations(existing: string[]) {
    const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
    const calls: string[] = []
    const linkUpdates: OrganizationIdentityProviderLinkRepresentation[] = []
    admin.organizations.findOne = async (query) => {
      if (query && existing.includes(query.id)) return { id: query.id }
      throw new Error('Request failed with status 404')
    }
    admin.organizations.linkIdp = async (query) => {
      calls.push(`link ${query?.orgId} ${query?.alias}`)
      return ''
    }
    admin.organizations.updateIdentityProviderLink = async (_query, payload) => {
      linkUpdates.push(payload)
    }
    admin.organizations.unLinkIdp = async (query) => {
      calls.push(`unlink ${query?.orgId} ${query?.alias}`)
      return ''
    }
    return { admin, calls, linkUpdates }
  }

  it('unlinks what was dropped before linking, so a moved MANAGED link never collides', async () => {
    const { admin, calls, linkUpdates } = fakeOrganizations(['a', 'b'])
    const changes = await syncOrganizationLinks(admin, 'hospital', ['a'], ['b'])
    expect(changes).toEqual({ linked: ['b'], unlinked: ['a'] })
    expect(calls).toEqual(['unlink a hospital', 'link b hospital'])
    expect(linkUpdates).toEqual([{ organizationId: 'b', autoMembership: true, membershipType: 'MANAGED' }])
  })

  it('auto-joins users of a shared provider as UNMANAGED, since only one organization may manage them', async () => {
    const { admin, linkUpdates } = fakeOrganizations(['a', 'b', 'c'])
    await syncOrganizationLinks(admin, 'hospital', ['a'], ['a', 'b', 'c'])
    expect(linkUpdates).toEqual([
      { organizationId: 'b', autoMembership: true, membershipType: 'UNMANAGED' },
      { organizationId: 'c', autoMembership: true, membershipType: 'UNMANAGED' },
    ])
  })

  it('reports organizations that do not exist', async () => {
    const { admin } = fakeOrganizations(['a'])
    expect(await unknownOrganizationIds(admin, ['a', 'ghost'])).toEqual(['ghost'])
  })
})
