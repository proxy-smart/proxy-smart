import { describe, it, expect } from 'bun:test'
import { readRealmExport, realmExportPaths, realmExportLabel } from './helpers/realm-exports'
import { fakeKcAdmin } from './helpers/keycloak-admin'
import { SUBJECT_SCOPE, ensureSubjectScope, issuesSubjectTokens } from '../src/lib/kc-system-provisioning'
import { RESOURCE_AUDIENCE_CLIENT_IDS } from '../src/lib/token-audience'

const subMapper = { name: 'sub', protocol: 'openid-connect', protocolMapper: 'oidc-sub-mapper', config: {} }

describe('issuesSubjectTokens', () => {
  it('covers the admin UI and service accounts, whose tokens name a user or the service', () => {
    expect(issuesSubjectTokens({ id: 'a', clientId: 'admin-ui', publicClient: true })).toBe(true)
    expect(issuesSubjectTokens({ id: 'b', clientId: 'shl-exchange', serviceAccountsEnabled: true })).toBe(true)
  })

  it('leaves Keycloak built-ins, bearer-only clients and the resource audiences alone', () => {
    expect(issuesSubjectTokens({ id: 'c', clientId: 'security-admin-console' })).toBe(false)
    expect(issuesSubjectTokens({ id: 'd', clientId: 'legacy-api', bearerOnly: true })).toBe(false)
    for (const clientId of RESOURCE_AUDIENCE_CLIENT_IDS) {
      expect(issuesSubjectTokens({ id: clientId, clientId })).toBe(false)
    }
  })
})

describe('ensureSubjectScope', () => {
  it('attaches the subject scope to every client that lacks it, so their tokens carry sub', async () => {
    const { admin, defaultScopes } = fakeKcAdmin({
      realmScopes: [{ id: 'scope-openid', name: SUBJECT_SCOPE, protocolMappers: [subMapper] }],
      clients: [
        { id: 'admin-ui-id', clientId: 'admin-ui' },
        { id: 'portal-id', clientId: 'patient-portal' },
        { id: 'account-id', clientId: 'account' },
      ],
      clientDefaultScopes: { 'portal-id': ['profile', SUBJECT_SCOPE] },
    })

    await ensureSubjectScope(admin)

    expect(defaultScopes).toEqual([{ id: 'admin-ui-id', clientScopeId: 'scope-openid' }])
  })

  it('creates the scope with its sub mapper in a realm that has none', async () => {
    const fake = fakeKcAdmin({ clients: [{ id: 'admin-ui-id', clientId: 'admin-ui' }] })

    await ensureSubjectScope(fake.admin)

    expect(fake.createdScopes).toHaveLength(1)
    expect(fake.createdScopes[0].protocolMappers?.map((m) => m.protocolMapper)).toEqual(['oidc-sub-mapper'])
    expect(fake.defaultScopeNames()).toEqual([SUBJECT_SCOPE])
  })

  it('restores a sub mapper removed from an existing scope', async () => {
    const fake = fakeKcAdmin({ realmScopes: [{ id: 'scope-openid', name: SUBJECT_SCOPE, protocolMappers: [] }] })

    await ensureSubjectScope(fake.admin)

    expect(fake.createdScopes).toHaveLength(0)
    expect(fake.addedMappers).toEqual([{ scopeId: 'scope-openid', name: 'sub' }])
  })
})

describe.each(realmExportPaths().map(realmExportLabel))('%s', (label) => {
  const path = realmExportPaths().find((p) => realmExportLabel(p) === label)!
  const realm = readRealmExport(path)

  it('maps sub in the subject scope', () => {
    const scope = realm.clientScopes?.find((s) => s.name === SUBJECT_SCOPE)
    expect(scope?.protocolMappers?.some((m) => m.protocolMapper === 'oidc-sub-mapper')).toBe(true)
  })

  it('gives every token-issuing client the subject scope by default', () => {
    const missing = (realm.clients ?? [])
      .filter((client) => issuesSubjectTokens({ ...client, id: client.id ?? client.clientId }))
      .filter((client) => client.defaultClientScopes !== undefined)
      .filter((client) => !client.defaultClientScopes?.includes(SUBJECT_SCOPE))
      .map((client) => client.clientId)
    expect(missing).toEqual([])
  })
})
