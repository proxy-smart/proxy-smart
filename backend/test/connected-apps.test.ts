// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation.js'
import { MemoryClientApprovalBackend } from '../src/lib/client-approvals'
import { isRevokedRefreshToken, listConnectedApps, revokeConnectedApp } from '../src/lib/connected-apps'
import { selfOnboardedKind } from '../src/lib/realm-clients'
import { fakeKcAdmin, type FakeKcAdmin } from './helpers/keycloak-admin'

const USER = 'user-1'
const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const IMAGING = 'https://imaging.example.com/mcp'
const SCRIBE = 'https://scribe.example.com/mcp'

const CLIENTS: ClientRepresentation[] = [
  { id: 'c1', clientId: CLAUDE, name: 'Claude (claude.ai)', attributes: { client_id_metadata_document: 'true' } },
  { id: 'c2', clientId: 'smart_app_1', name: 'Cursor', attributes: { dynamic_registration: 'true' } },
  { id: 'c3', clientId: 'mcp-client', name: 'MCP Client', attributes: { client_type: 'mcp-client' } },
  { id: 'c4', clientId: 'patient-portal', name: 'Patient Portal', attributes: { smart_app: 'true' } },
]

async function setup(): Promise<{ kc: FakeKcAdmin; approvals: MemoryClientApprovalBackend; deps: Parameters<typeof listConnectedApps>[1] }> {
  const kc = fakeKcAdmin({
    clients: CLIENTS,
    consents: {
      [USER]: [
        { clientId: 'smart_app_1', grantedClientScopes: ['openid', 'offline_access'], createdDate: 500 },
        { clientId: 'patient-portal', grantedClientScopes: ['openid'], createdDate: 100 },
      ],
    },
  })
  const approvals = new MemoryClientApprovalBackend()
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback'
  await approvals.save({ userId: USER, clientId: CLAUDE, resource: IMAGING, redirectUri, scopes: ['openid'], approvedAt: 1_000 })
  await approvals.save({ userId: USER, clientId: CLAUDE, resource: SCRIBE, redirectUri, scopes: ['openid', 'profile'], approvedAt: 2_000 })
  return { kc, approvals, deps: { admin: async () => kc.admin, approvals, now: () => 9_000 } }
}

/** An unsigned JWT: the refresh check reads claims Keycloak itself verifies afterwards. */
const refreshToken = (claims: Record<string, unknown>) =>
  ['{"alg":"none"}', JSON.stringify(claims), ''].map((part) => Buffer.from(part).toString('base64url')).join('.')

describe('connected apps', () => {
  it('lists the apps the user connected, whichever way, and leaves out apps an admin registered', async () => {
    const { deps } = await setup()
    const apps = await listConnectedApps(USER, deps)

    expect(apps.map((app) => [app.clientId, app.kind])).toEqual([
      [CLAUDE, 'metadata-document'],
      ['smart_app_1', 'dynamic-registration'],
    ])
    expect(apps[0]).toEqual({
      clientId: CLAUDE,
      name: 'Claude (claude.ai)',
      host: 'claude.ai',
      kind: 'metadata-document',
      resources: [IMAGING, SCRIBE],
      scopes: ['openid', 'profile'],
      connectedAt: 1_000,
    })
    expect(apps[1]).toMatchObject({ name: 'Cursor', resources: [], scopes: ['openid', 'offline_access'], connectedAt: 500 })
  })

  it('disconnecting forgets the approvals, drops the Keycloak grant and records when', async () => {
    const { kc, approvals, deps } = await setup()

    expect(await revokeConnectedApp(USER, CLAUDE, deps)).toBe(true)

    expect(await approvals.forUser(USER)).toEqual([])
    expect(await approvals.revokedAt(USER, CLAUDE)).toBe(9_000)
    expect(kc.revokedConsents).toEqual([{ id: USER, clientId: CLAUDE }])
    expect((await listConnectedApps(USER, deps)).map((app) => app.clientId)).toEqual(['smart_app_1'])
  })

  it('refuses to disconnect what the user never connected, an admin-registered app included', async () => {
    const { kc, deps } = await setup()
    expect(await revokeConnectedApp(USER, 'patient-portal', deps)).toBe(false)
    expect(await revokeConnectedApp('user-2', CLAUDE, deps)).toBe(false)
    expect(kc.revokedConsents).toEqual([])
  })
})

describe('refresh tokens of a disconnected app', () => {
  it('are refused when issued before the disconnect, and accepted after a new sign-in', async () => {
    const { approvals } = await setup()
    await approvals.revoke({ userId: USER, clientId: CLAUDE, revokedAt: 10_000 })

    expect(await isRevokedRefreshToken(refreshToken({ sub: USER, iat: 9 }), CLAUDE, approvals)).toBe(true)
    expect(await isRevokedRefreshToken(refreshToken({ sub: USER, iat: 11 }), CLAUDE, approvals)).toBe(false)
  })

  it('are untouched for another client or user, and when the token cannot be read', async () => {
    const { approvals } = await setup()
    await approvals.revoke({ userId: USER, clientId: CLAUDE, revokedAt: 10_000 })

    expect(await isRevokedRefreshToken(refreshToken({ sub: USER, iat: 9 }), 'smart_app_1', approvals)).toBe(false)
    expect(await isRevokedRefreshToken(refreshToken({ sub: 'user-2', iat: 9 }), CLAUDE, approvals)).toBe(false)
    expect(await isRevokedRefreshToken('opaque', CLAUDE, approvals)).toBe(false)
    expect(await isRevokedRefreshToken(refreshToken({ sub: USER, iat: 9 }), undefined, approvals)).toBe(false)
  })
})

describe('which clients count as connected by the user', () => {
  it('reads the markers each way of connecting leaves', () => {
    expect(CLIENTS.map(selfOnboardedKind)).toEqual(['metadata-document', 'dynamic-registration', 'mcp-client', null])
  })
})
