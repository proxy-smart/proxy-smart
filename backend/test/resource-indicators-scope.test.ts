/**
 * Unit tests for assignResourceIndicatorsScope — the shared helper that attaches
 * the RFC 8707 `resource-indicators` client scope to every SMART client the
 * backend provisions (DCR + admin API). Without this default scope, Keycloak's
 * resource-indicators post-processor cannot bind a requested `resource` into the
 * token `aud` and token exchange fails with `invalid_target`.
 */
import { describe, it, expect } from 'bun:test'
import { readRealmExport, realmExportPaths, realmExportLabel } from './helpers/realm-exports'
import { fakeKcAdmin } from './helpers/keycloak-admin'
import {
  assignResourceIndicatorsScope,
  RESOURCE_INDICATORS_SCOPE,
} from '../src/lib/smart-client-enrichment'
import { RESOURCE_AUDIENCE_CLIENT_IDS, needsResourceIndicators } from '../src/lib/kc-system-provisioning'

describe('assignResourceIndicatorsScope', () => {
  it('attaches the resource-indicators scope by its resolved id', async () => {
    const { admin, defaultScopes } = fakeKcAdmin({ realmScopes: [
      { id: 'scope-openid', name: 'openid' },
      { id: 'scope-ri', name: RESOURCE_INDICATORS_SCOPE },
    ] })

    await assignResourceIndicatorsScope(admin, 'client-uuid', 'my-client')

    expect(defaultScopes).toHaveLength(1)
    expect(defaultScopes[0]).toEqual({ id: 'client-uuid', clientScopeId: 'scope-ri' })
  })

  it('reuses a provided scope list instead of re-fetching', async () => {
    const { admin, defaultScopes } = fakeKcAdmin() // find() would return nothing
    const preloaded = [{ id: 'scope-ri', name: RESOURCE_INDICATORS_SCOPE }]

    await assignResourceIndicatorsScope(admin, 'client-uuid', 'my-client', preloaded)

    expect(defaultScopes).toHaveLength(1)
    expect(defaultScopes[0].clientScopeId).toBe('scope-ri')
  })

  it('is a safe no-op when the scope is absent from the realm', async () => {
    // Correct locally, but it is why production went unnoticed: nothing CREATED
    // the scope, so this branch ran for every client. ensureResourceIndicatorsScope
    // now guarantees it exists first.
    const { admin, defaultScopes } = fakeKcAdmin({ realmScopes: [{ id: 'scope-openid', name: 'openid' }] })

    await assignResourceIndicatorsScope(admin, 'client-uuid', 'my-client')

    expect(defaultScopes).toHaveLength(0)
  })

  it('does not throw when Keycloak rejects the attachment', async () => {
    const { admin } = fakeKcAdmin({ realmScopes: [{ id: 'scope-ri', name: RESOURCE_INDICATORS_SCOPE }] })
    admin.clients.addDefaultClientScope = async () => { throw new Error('kc failure') }

    // Errors are swallowed and logged — provisioning must not fail on this.
    await expect(
      assignResourceIndicatorsScope(admin, 'client-uuid', 'my-client'),
    ).resolves.toBeUndefined()
  })
})

/**
 * Pins the regression: keying only on `smart_app` skipped export-seeded apps on
 * every reconcile run, so their token exchanges returned `invalid_target`.
 */
describe('needsResourceIndicators', () => {
  const client = (clientId: string, attributes?: Record<string, string>) =>
    ({ id: `${clientId}-uuid`, clientId, attributes })

  it('covers an export-seeded SMART app, which carries client_type and no smart_app', () => {
    expect(needsResourceIndicators(client('seeded-app', { client_type: 'standalone-app' }))).toBe(true)
  })

  it('covers a client provisioned through the admin API or DCR', () => {
    expect(needsResourceIndicators(client('registered-app', { smart_app: 'true' }))).toBe(true)
  })

  it('excludes the resource clients, which are the audience and never the requester', () => {
    for (const clientId of RESOURCE_AUDIENCE_CLIENT_IDS) {
      expect(needsResourceIndicators(client(clientId, { resource_url: 'https://example.test/fhir' }))).toBe(false)
    }
  })

  it('leaves a client with neither marker alone', () => {
    expect(needsResourceIndicators(client('some-service', { 'access.token.lifespan': '300' }))).toBe(false)
    expect(needsResourceIndicators(client('bare'))).toBe(false)
  })

  it('skips a client Keycloak returned without an internal id', () => {
    expect(needsResourceIndicators({ clientId: 'no-id', attributes: { smart_app: 'true' } })).toBe(false)
  })
})

/** The reconciler creates the scope; the export declares it. They must agree. */
describe.each(realmExportPaths().map(realmExportLabel))('%s', (label) => {
  const path = realmExportPaths().find((p) => realmExportLabel(p) === label)!
  const scope = readRealmExport(path).clientScopes
    ?.find((s) => s.name === RESOURCE_INDICATORS_SCOPE)

  it('declares the resource-indicators scope', () => {
    expect(scope).toBeDefined()
  })

  it('maps exactly the audiences the reconciler creates', () => {
    const audiences = (scope?.protocolMappers ?? [])
      .filter((m) => m.protocolMapper === 'oidc-audience-mapper')
      .map((m) => m.config?.['included.client.audience'])
      .filter(Boolean)
      .sort()

    expect(audiences).toEqual([...RESOURCE_AUDIENCE_CLIENT_IDS].sort())
  })
})
