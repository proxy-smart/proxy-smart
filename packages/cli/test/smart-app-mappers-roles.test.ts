// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Routing tests for the client protocol-mapper and role verbs.
 *
 * These verbs exist so Keycloak mechanics stop being hand-written against the
 * admin REST API, which means the behaviour worth pinning is exactly that: the
 * verb reaches the right endpoint with the right arguments, and the shorthands
 * (add-audience, --include-technical) put the caller's intent in the request
 * rather than making them encode it. The destructive verbs are gated on --yes
 * for the same reason the rest of the CLI gates them.
 */
import { describe, expect, it } from 'bun:test'
import { smartAppsCommand } from '../src/commands/smart-apps'
import { rolesCommand } from '../src/commands/roles'
import { createCommandContext, captureStdout, type ApiMocks } from './support'

const MOCKS: ApiMocks = {
  smartApps: {
    getAdminSmartApps: ['apps.list', []],
    getAdminSmartAppsByClientIdMappers: ['apps.mappers', [
      {
        id: 'm1',
        name: 'fhir-resource-audience',
        protocolMapper: 'oidc-audience-mapper',
        config: { 'included.client.audience': 'fhir-resource-server', 'access.token.claim': 'true' },
      },
    ]],
    postAdminSmartAppsByClientIdMappers: ['apps.createMapper', { id: 'm2' }],
    postAdminSmartAppsByClientIdMappersAudience: ['apps.addAudience', {
      created: true, resolvedAs: 'client', mapper: { id: 'm3' },
    }],
    putAdminSmartAppsByClientIdMappersByMapperId: ['apps.updateMapper', { success: true }],
    deleteAdminSmartAppsByClientIdMappersByMapperId: ['apps.deleteMapper', { success: true }],
  },
  roles: {
    getAdminRoles: ['roles.list', [
      { name: 'clinician', description: 'Clinical staff', composite: false, isTechnical: false },
    ]],
    getAdminRolesByRoleName: ['roles.get', {}],
    postAdminRoles: ['roles.create', {}],
    putAdminRolesByRoleName: ['roles.update', { success: true }],
    deleteAdminRolesByRoleName: ['roles.delete', { success: true }],
    getAdminRolesClientsByClientId: ['roles.clientList', []],
    getAdminRolesClientsByClientIdByRoleName: ['roles.clientGet', {}],
    postAdminRolesClientsByClientId: ['roles.clientCreate', {}],
    putAdminRolesClientsByClientIdByRoleName: ['roles.clientUpdate', { success: true }],
    deleteAdminRolesClientsByClientIdByRoleName: ['roles.clientDelete', { success: true }],
  },
}

captureStdout()

describe('smart-apps mapper verbs', () => {
  it('lists the mappers on a client', async () => {
    const { ctx, calls } = createCommandContext(['smart-apps', 'mappers', 'patient-portal'], MOCKS)
    await smartAppsCommand(ctx)
    expect(calls[0]?.call).toBe('apps.mappers')
    expect(calls[0]?.args).toEqual({ clientId: 'patient-portal' })
  })

  it('requires a clientId to list mappers', async () => {
    const { ctx } = createCommandContext(['smart-apps', 'mappers'], MOCKS)
    await expect(smartAppsCommand(ctx)).rejects.toThrow(/Missing required argument <clientId>/)
  })

  it('requires both clientId and mapperId to delete a mapper', async () => {
    const { ctx } = createCommandContext(['smart-apps', 'delete-mapper', 'patient-portal'], MOCKS)
    await expect(smartAppsCommand(ctx)).rejects.toThrow(/Missing required argument <mapperId>/)
  })

  it('sends the audience positionally, leaving the optional fields unset', async () => {
    const { ctx, calls } = createCommandContext(['smart-apps', 'add-audience', 'patient-portal', 'fhir-resource-server'], MOCKS)
    await smartAppsCommand(ctx)
    expect(calls[0]?.call).toBe('apps.addAudience')
    expect(calls[0]?.args).toEqual({
      clientId: 'patient-portal',
      addAudienceMapperRequest: {
        audience: 'fhir-resource-server',
        name: undefined,
        includeInIdToken: undefined,
      },
    })
  })

  it('forwards --name and --id-token onto the audience request', async () => {
    const { ctx, calls } = createCommandContext([
      'smart-apps', 'add-audience', 'patient-portal', 'https://fhir.example.com/R4',
      '--name', 'custom-aud', '--id-token',
    ], MOCKS)
    await smartAppsCommand(ctx)
    expect(calls[0]?.args).toEqual({
      clientId: 'patient-portal',
      addAudienceMapperRequest: {
        audience: 'https://fhir.example.com/R4',
        name: 'custom-aud',
        includeInIdToken: true,
      },
    })
  })

  it('requires an audience', async () => {
    const { ctx } = createCommandContext(['smart-apps', 'add-audience', 'patient-portal'], MOCKS)
    await expect(smartAppsCommand(ctx)).rejects.toThrow(/Missing required argument <audience>/)
  })

  it('requires a body to create a mapper', async () => {
    const { ctx } = createCommandContext(['smart-apps', 'create-mapper', 'patient-portal'], MOCKS)
    await expect(smartAppsCommand(ctx)).rejects.toThrow(/requires a request body/)
  })

  it('rejects an unknown verb and names the valid ones', async () => {
    const { ctx } = createCommandContext(['smart-apps', 'frobnicate'], MOCKS)
    await expect(smartAppsCommand(ctx)).rejects.toThrow(/Unknown smart-apps verb "frobnicate"/)
  })
})

describe('roles command routing', () => {
  it('defaults to listing realm roles with technical roles hidden', async () => {
    const { ctx, calls } = createCommandContext(['roles'], MOCKS)
    await rolesCommand(ctx)
    expect(calls[0]?.call).toBe('roles.list')
    expect(calls[0]?.args).toEqual({ includeTechnical: undefined })
  })

  it('asks for technical roles only when --include-technical is passed', async () => {
    const { ctx, calls } = createCommandContext(['roles', 'list', '--include-technical'], MOCKS)
    await rolesCommand(ctx)
    expect(calls[0]?.args).toEqual({ includeTechnical: 'true' })
  })

  it('routes client verbs to the client-role endpoints', async () => {
    const { ctx, calls } = createCommandContext(['roles', 'client-roles', 'admin-ui'], MOCKS)
    await rolesCommand(ctx)
    expect(calls[0]?.call).toBe('roles.clientList')
    expect(calls[0]?.args).toEqual({ clientId: 'admin-ui' })
  })

  it('takes clientId then roleName for a single client role', async () => {
    const { ctx, calls } = createCommandContext(['roles', 'client-get', 'admin-ui', 'app-admin'], MOCKS)
    await rolesCommand(ctx)
    expect(calls[0]?.call).toBe('roles.clientGet')
    expect(calls[0]?.args).toEqual({ clientId: 'admin-ui', roleName: 'app-admin' })
  })

  it('refuses to delete a realm role without --yes', async () => {
    const { ctx, calls } = createCommandContext(['roles', 'delete', 'clinician'], MOCKS)
    await expect(rolesCommand(ctx)).rejects.toThrow(/--yes/)
    expect(calls).toEqual([])
  })

  it('refuses to delete a client role without --yes', async () => {
    const { ctx, calls } = createCommandContext(['roles', 'client-delete', 'admin-ui', 'app-admin'], MOCKS)
    await expect(rolesCommand(ctx)).rejects.toThrow(/--yes/)
    expect(calls).toEqual([])
  })

  it('deletes a client role once --yes is given', async () => {
    const { ctx, calls } = createCommandContext(['roles', 'client-delete', 'admin-ui', 'app-admin', '--yes'], MOCKS)
    await rolesCommand(ctx)
    expect(calls[0]?.call).toBe('roles.clientDelete')
    expect(calls[0]?.args).toEqual({ clientId: 'admin-ui', roleName: 'app-admin' })
  })

  it('rejects an unknown verb and names the valid ones', async () => {
    const { ctx } = createCommandContext(['roles', 'frobnicate'], MOCKS)
    await expect(rolesCommand(ctx)).rejects.toThrow(/Unknown roles verb "frobnicate"/)
  })
})
