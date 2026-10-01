// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Mapper command tests.
 *
 * These commands are the scriptable half of claim mapping, so the behaviour
 * worth pinning is the routing (which verb hits which endpoint, with which
 * arguments) and the --strict gate that makes them usable as CI checks.
 */
import { describe, expect, it } from 'bun:test'
import { CliError } from '../src/output'
import { identityProvidersCommand } from '../src/commands/identity-providers'
import { userFederationCommand } from '../src/commands/user-federation'
import { createCommandContext, captureStdout, type ApiMocks } from './support'

function mapperStatus(entry: Record<string, unknown>) {
  return {
    status: [{
      alias: 'hospital-oidc',
      providerId: 'oidc',
      enabled: true,
      attributeMapperType: 'oidc-user-attribute-idp-mapper',
      mappers: [],
      missingRequired: [],
      missingOptional: [],
      healthy: true,
      unsupported: false,
      userFacing: true,
      ...entry,
    }],
    definitions: [],
    timestamp: 'now',
  }
}

const MOCKS: ApiMocks = {
  identityProviders: {
    getAdminIdps: ['idps.list', []],
    getAdminIdpsByAlias: ['idps.get', {}],
    getAdminIdpsMapperStatus: ['idps.mapperStatus.realm', mapperStatus({})],
    getAdminIdpsByAliasMapperStatus: ['idps.mapperStatus.one', mapperStatus({})],
    getAdminIdpsByAliasMappers: ['idps.mappers', []],
    getAdminIdpsByAliasMapperTypes: ['idps.mapperTypes', []],
    postAdminIdpsByAliasMappersFix: ['idps.fixMappers', {
      message: 'ok', alias: 'hospital-oidc', attributeMapperType: null,
      created: [], skipped: [], unsupported: false, errors: [], timestamp: 'now',
    }],
    deleteAdminIdpsByAliasMappersByMapperId: ['idps.deleteMapper', { success: true }],
  },
  userFederation: {
    getAdminUserFederation: ['ldap.list', []],
    getAdminUserFederationByIdMappers: ['ldap.mappers', [
      { id: 'm1', name: 'username', providerId: 'user-attribute-ldap-mapper', config: { 'ldap.attribute': 'uid', 'user.model.attribute': 'username' } },
    ]],
    getAdminUserFederationByIdMapperTypes: ['ldap.mapperTypes', []],
    postAdminUserFederationByIdSync: ['ldap.sync', { added: 0 }],
    deleteAdminUserFederationById: ['ldap.delete', { success: true }],
  },
}

captureStdout()

describe('idps command routing', () => {
  it('defaults to listing providers', async () => {
    const { ctx, calls } = createCommandContext(['idps'], MOCKS)
    await identityProvidersCommand(ctx)
    expect(calls.map(c => c.call)).toEqual(['idps.list'])
  })

  it('hits the realm-wide status endpoint when no alias is given', async () => {
    const { ctx, calls } = createCommandContext(['idps', 'mapper-status'], MOCKS)
    await identityProvidersCommand(ctx)
    expect(calls[0]?.call).toBe('idps.mapperStatus.realm')
  })

  it('hits the per-provider status endpoint when an alias is given', async () => {
    const { ctx, calls } = createCommandContext(['idps', 'mapper-status', 'hospital-oidc'], MOCKS)
    await identityProvidersCommand(ctx)
    expect(calls[0]?.call).toBe('idps.mapperStatus.one')
    expect(calls[0]?.args).toEqual({ alias: 'hospital-oidc' })
  })

  it('passes includeOptional=false only for --required-only', async () => {
    const plain = createCommandContext(['idps', 'fix-mappers', 'hospital-oidc'], MOCKS)
    await identityProvidersCommand(plain.ctx)
    expect(plain.calls[0]?.args).toEqual({ alias: 'hospital-oidc', includeOptional: undefined })

    const requiredOnly = createCommandContext(['idps', 'fix-mappers', 'hospital-oidc', '--required-only'], MOCKS)
    await identityProvidersCommand(requiredOnly.ctx)
    expect(requiredOnly.calls[0]?.args).toEqual({ alias: 'hospital-oidc', includeOptional: 'false' })
  })

  it('requires an alias for mapper listing', async () => {
    const { ctx } = createCommandContext(['idps', 'mappers'], MOCKS)
    await expect(identityProvidersCommand(ctx)).rejects.toThrow(/Missing required argument <alias>/)
  })

  it('requires both alias and mapperId to delete a mapper', async () => {
    const { ctx } = createCommandContext(['idps', 'delete-mapper', 'hospital-oidc'], MOCKS)
    await expect(identityProvidersCommand(ctx)).rejects.toThrow(/Missing required argument <mapperId>/)
  })

  it('rejects an unknown verb and names the valid ones', async () => {
    const { ctx } = createCommandContext(['idps', 'frobnicate'], MOCKS)
    await expect(identityProvidersCommand(ctx)).rejects.toThrow(/Unknown idps verb "frobnicate"/)
  })
})

describe('idps mapper-status --strict', () => {
  it('stays silent when every provider is healthy', async () => {
    const { ctx } = createCommandContext(['idps', 'mapper-status', '--strict'], MOCKS)
    await identityProvidersCommand(ctx)
  })

  it('fails when a required import is missing', async () => {
    const { ctx } = createCommandContext(['idps', 'mapper-status', '--strict'], MOCKS, {
      identityProviders: {
        getAdminIdpsMapperStatus: ['idps.mapperStatus.realm', mapperStatus({
          missingRequired: ['fhirUser-import'], healthy: false,
        })],
      },
    })

    await expect(identityProvidersCommand(ctx)).rejects.toThrow(CliError)
  })

  it('does not fail on a machine trust anchor that carries no user attributes', async () => {
    const { ctx } = createCommandContext(['idps', 'mapper-status', '--strict'], MOCKS, {
      identityProviders: {
        getAdminIdpsMapperStatus: ['idps.mapperStatus.realm', mapperStatus({
          alias: 'proxy-smart-signing', userFacing: false,
        })],
      },
    })

    await identityProvidersCommand(ctx)
  })
})

describe('user-federation command routing', () => {
  it('defaults to listing providers', async () => {
    const { ctx, calls } = createCommandContext(['user-federation'], MOCKS)
    await userFederationCommand(ctx)
    expect(calls.map(c => c.call)).toEqual(['ldap.list'])
  })

  it('sends the sync action in the request body, defaulting to a full sync', async () => {
    const { ctx, calls } = createCommandContext(['user-federation', 'sync', 'ldap-1'], MOCKS)
    await userFederationCommand(ctx)
    expect(calls[0]?.args).toEqual({ id: 'ldap-1', userFederationSyncRequest: { action: 'triggerFullSync' } })
  })

  it('rejects an unsupported sync action', async () => {
    const { ctx } = createCommandContext(['user-federation', 'sync', 'ldap-1', '--action', 'triggerNonsense'], MOCKS)
    await expect(userFederationCommand(ctx)).rejects.toThrow(/--action must be/)
  })

  it('refuses to delete a provider without --yes', async () => {
    const { ctx, calls } = createCommandContext(['user-federation', 'delete', 'ldap-1'], MOCKS)
    await expect(userFederationCommand(ctx)).rejects.toThrow(/--yes/)
    expect(calls).toEqual([])
  })

  it('fails --strict when no mapper writes fhirUser', async () => {
    const { ctx } = createCommandContext(['user-federation', 'mappers', 'ldap-1', '--strict'], MOCKS)
    await expect(userFederationCommand(ctx)).rejects.toThrow(/fhirUser/)
  })

  it('passes --strict when a mapper writes fhirUser', async () => {
    const { ctx } = createCommandContext(['user-federation', 'mappers', 'ldap-1', '--strict'], MOCKS, {
      userFederation: {
        getAdminUserFederationByIdMappers: ['ldap.mappers', [
          { id: 'm2', name: 'fhir-user', providerId: 'user-attribute-ldap-mapper', config: { 'ldap.attribute': 'employeeNumber', 'user.model.attribute': 'fhirUser' } },
        ]],
      },
    })

    await userFederationCommand(ctx)
  })
})
