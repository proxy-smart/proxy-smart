// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import type { CimdDocument } from '@proxy-smart/auth'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation.js'
import { createCimdStandIn, isPartyIdentifier } from '../src/routes/auth/cimd-client'
import { getClientRegistrationSettings } from '../src/routes/admin/client-registration-settings'
import { STANDARD_OIDC_DEFAULT_SCOPES } from '../src/lib/oauth-scopes'
import { fakeKcAdmin, type FakeKcAdmin } from './helpers/keycloak-admin'
import { TEST_BASE_URL, useTestEnv } from './helpers/test-env'

useTestEnv()

const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const PROXY_CALLBACK = `${TEST_BASE_URL}/auth/smart-callback`
const REALM_SCOPES = STANDARD_OIDC_DEFAULT_SCOPES.map((name) => ({ id: `scope-${name}`, name }))

const document = (metadata: Record<string, unknown> = {}): CimdDocument => {
  const body = { client_id: CLIENT_ID, client_name: 'Claude', redirect_uris: [REDIRECT], ...metadata }
  return { client_id: CLIENT_ID, client_name: 'Claude', redirect_uris: [REDIRECT], metadata: body }
}

interface StandInOptions {
  domains?: string[]
  doc?: () => CimdDocument | null
  admin?: () => Promise<FakeKcAdmin['admin']>
  partyIdentifiers?: string[]
}

function standIn(kc: FakeKcAdmin, options: StandInOptions = {}) {
  const fetched: string[] = []
  const ready = createCimdStandIn({
    admin: options.admin ?? (async () => kc.admin),
    settings: getClientRegistrationSettings,
    trustedDomains: async () => options.domains ?? ['claude.ai'],
    resolveDocument: async (clientId) => {
      fetched.push(clientId)
      return options.doc ? options.doc() : document()
    },
    isPartyIdentifier: async (clientId) => (options.partyIdentifiers ?? []).includes(clientId),
    now: () => 1_700_000_000_000,
  })
  return { ready, fetched }
}

const existingStandIn = (overrides: ClientRepresentation = {}): ClientRepresentation => ({
  id: 'stand-in-uuid',
  clientId: CLIENT_ID,
  enabled: true,
  redirectUris: [REDIRECT, PROXY_CALLBACK],
  attributes: { client_id_metadata_document: 'true', approved: 'true', approval_required: 'false' },
  ...overrides,
})

describe('standing in for a CIMD client', () => {
  it('creates a Keycloak client named by the document URL, which only the proxy callback reaches', async () => {
    const kc = fakeKcAdmin({ realmScopes: REALM_SCOPES })

    expect(await standIn(kc).ready(CLIENT_ID)).toBeNull()

    const [created] = kc.created
    expect(created?.clientId).toBe(CLIENT_ID)
    expect(created?.name).toBe('Claude (claude.ai)')
    expect(created?.publicClient).toBe(true)
    expect(created?.redirectUris).toContain(PROXY_CALLBACK)
    expect(created?.attributes?.client_id_metadata_document).toBe('true')
    expect(created?.attributes?.dynamic_registration).toBeUndefined()
    expect(created?.attributes?.expires_at).toBeUndefined()
    expect(kc.defaultScopeNames()).toEqual(expect.arrayContaining([...STANDARD_OIDC_DEFAULT_SCOPES]))
  })

  it('asks Keycloak once for an unchanged document', async () => {
    const kc = fakeKcAdmin()
    const { ready } = standIn(kc)

    await ready(CLIENT_ID)
    await ready(CLIENT_ID)

    expect(kc.created).toHaveLength(1)
    expect(kc.updated).toHaveLength(0)
  })

  it('coalesces concurrent first sign-ins onto one create', async () => {
    const kc = fakeKcAdmin()
    const { ready } = standIn(kc)

    expect(await Promise.all([ready(CLIENT_ID), ready(CLIENT_ID)])).toEqual([null, null])
    expect(kc.created).toHaveLength(1)
  })

  it('refreshes the stand-in from a changed document, keeping what an operator decided', async () => {
    const kc = fakeKcAdmin({ clients: [existingStandIn({ enabled: false, attributes: { client_id_metadata_document: 'true', approved: 'false', approval_required: 'true', 'smart.preferred_idp': 'corp' } })] })

    const refusal = await standIn(kc, { doc: () => document({ client_name: 'Claude Desktop' }) }).ready(CLIENT_ID)

    const [update] = kc.updated
    expect(update?.payload.name).toBe('Claude Desktop (claude.ai)')
    expect(update?.payload.enabled).toBe(false)
    expect(update?.payload.attributes?.approved).toBe('false')
    expect(update?.payload.attributes?.['smart.preferred_idp']).toBe('corp')
    expect(refusal?.error).toBe('unauthorized_client')
    expect(refusal?.error_description).toContain('approval')
  })

  it('never takes over a client registered another way under the same identifier', async () => {
    const kc = fakeKcAdmin({ clients: [existingStandIn({ attributes: { dynamic_registration: 'true' } })] })

    expect((await standIn(kc).ready(CLIENT_ID))?.error).toBe('unauthorized_client')
    expect(kc.updated).toHaveLength(0)
    expect(kc.created).toHaveLength(0)
  })

  it('refuses a host the operator has not trusted, before fetching anything', async () => {
    const kc = fakeKcAdmin()
    const { ready, fetched } = standIn(kc, { domains: ['vscode.dev'] })

    expect((await ready(CLIENT_ID))?.error).toBe('unauthorized_client')
    expect(fetched).toEqual([])
    expect(kc.created).toHaveLength(0)
  })

  it('refuses an identifier this server or one of its resources already holds, before fetching it', async () => {
    const kc = fakeKcAdmin()
    const { ready, fetched } = standIn(kc, { partyIdentifiers: [CLIENT_ID] })

    expect((await ready(CLIENT_ID))?.error).toBe('unauthorized_client')
    expect(fetched).toEqual([])
    expect(kc.created).toHaveLength(0)
  })

  it('keeps no logo, which could only be shown prefetched from servers this one trusts', async () => {
    const kc = fakeKcAdmin()
    await standIn(kc, { doc: () => document({ logo_uri: 'https://claude.ai/logo.png' }) }).ready(CLIENT_ID)
    expect(kc.created[0]?.attributes?.['smart.logo_uri']).toBe('')
  })

  it('refuses a document that cannot be read', async () => {
    const kc = fakeKcAdmin()
    expect((await standIn(kc, { doc: () => null }).ready(CLIENT_ID))?.error).toBe('invalid_request')
    expect(kc.created).toHaveLength(0)
  })

  it('holds a document to the same registration policy as /auth/register', async () => {
    const kc = fakeKcAdmin()
    const doc = () => document({ redirect_uris: ['http://claude.ai/callback'] })

    const refusal = await standIn(kc, { doc }).ready(CLIENT_ID)

    expect(refusal?.error).toBe('invalid_request')
    expect(refusal?.error_description).toContain('https')
    expect(kc.created).toHaveLength(0)
  })

  it('refuses metadata that is not RFC 7591 client metadata', async () => {
    const kc = fakeKcAdmin()
    const refusal = await standIn(kc, { doc: () => document({ grant_types: 'authorization_code' }) }).ready(CLIENT_ID)
    expect(refusal?.error).toBe('invalid_request')
  })

  it('answers temporarily_unavailable when Keycloak cannot be reached', async () => {
    const kc = fakeKcAdmin()
    const admin = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    expect((await standIn(kc, { admin }).ready(CLIENT_ID))?.error).toBe('temporarily_unavailable')
  })
})

describe('identifiers this server holds', () => {
  it("reserves everything on the proxy's own origin, its issuer and resources included", async () => {
    expect(await isPartyIdentifier(`${TEST_BASE_URL}/auth/realms/test`)).toBe(true)
    expect(await isPartyIdentifier(`${TEST_BASE_URL}/mcp`)).toBe(true)
  })
})
