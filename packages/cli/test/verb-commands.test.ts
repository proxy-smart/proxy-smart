// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { healthcareUsersCommand } from '../src/commands/healthcare-users'
import { mcpEndpointCommand } from '../src/commands/mcp-endpoint'
import { scopeSetsCommand } from '../src/commands/scope-sets'
import { restartCommand, shutdownCommand } from '../src/commands/server'
import { smartAppsCommand } from '../src/commands/smart-apps'
import { smartScopesCommand } from '../src/commands/smart-scopes'
import { userFederationCommand } from '../src/commands/user-federation'
import { captureStdout, createCommandContext, TEST_URL, type ApiMocks } from './support'

const MOCKS: ApiMocks = {
  scopeSets: {
    getAdminScopeSets: ['sets.list', { scopeSets: [{ id: 'clinical', name: 'Clinical', scopes: ['patient/*.rs'] }] }],
    getAdminScopeSetsById: ['sets.get', { id: 'clinical' }],
    deleteAdminScopeSetsById: ['sets.delete', { success: true }],
  },
  healthcareUsers: {
    getAdminHealthcareUsers: ['users.list', []],
  },
  admin: {
    getAdminSmartScopes: ['scopes.list', { scopes: [] }],
    postAdminShutdown: ['server.shutdown', { success: true }],
    postAdminRestart: ['server.restart', { success: true }],
  },
  mcp: {
    getAdminMcpEndpoint: ['mcp.get', { enabled: true }],
  },
  smartApps: {
    putAdminSmartAppsByClientId: ['apps.update', { success: true }],
  },
  userFederation: {
    putAdminUserFederationByIdMappersByMapperId: ['ldap.updateMapper', { success: true }],
  },
}

const stdout = captureStdout()

describe('verb dispatch', () => {
  it('lists the valid verbs in declaration order for an unknown verb', async () => {
    const { ctx } = createCommandContext(['scope-sets', 'frobnicate'], MOCKS)
    await expect(scopeSetsCommand(ctx)).rejects.toThrow(
      'Unknown scope-sets verb "frobnicate". Use: list | get | create | delete.',
    )
  })

  it('falls back to the command default verb', async () => {
    const { ctx, calls } = createCommandContext(['mcp-endpoint'], MOCKS)
    await mcpEndpointCommand(ctx)
    expect(calls.map(c => c.call)).toEqual(['mcp.get'])
  })

  it('does not resolve inherited object keys as verbs', async () => {
    const { ctx } = createCommandContext(['smart-scopes', 'constructor'], MOCKS)
    await expect(smartScopesCommand(ctx)).rejects.toThrow(/Unknown smart-scopes verb "constructor"/)
  })
})

describe('list verbs', () => {
  it('prints the raw response with --json', async () => {
    const { ctx } = createCommandContext(['scope-sets', 'list', '--json'], MOCKS)
    await scopeSetsCommand(ctx)
    expect(JSON.parse(stdout.text())).toEqual({
      scopeSets: [{ id: 'clinical', name: 'Clinical', scopes: ['patient/*.rs'] }],
    })
  })

  it('prints the extracted rows as a table otherwise', async () => {
    const { ctx } = createCommandContext(['scope-sets'], MOCKS)
    await scopeSetsCommand(ctx)
    expect(stdout.text().split('\n')[0]).toMatch(/^id\s+name\s*$/)
    expect(stdout.text()).toContain('clinical')
  })

  it('turns paging flags into numbers', async () => {
    const { ctx, calls } = createCommandContext(['healthcare-users', 'list', '--limit', '5', '--offset', '10'], MOCKS)
    await healthcareUsersCommand(ctx)
    expect(calls[0]?.args).toEqual({ limit: 5, offset: 10 })
  })
})

describe('keyed and body verbs', () => {
  it('passes the positional key to the API', async () => {
    const { ctx, calls } = createCommandContext(['scope-sets', 'delete', 'clinical'], MOCKS)
    await scopeSetsCommand(ctx)
    expect(calls).toEqual([{ call: 'sets.delete', args: { id: 'clinical' } }])
  })

  it('checks the key before asking for a body', async () => {
    const { ctx } = createCommandContext(['smart-apps', 'update'], MOCKS)
    await expect(smartAppsCommand(ctx)).rejects.toThrow(/Missing required argument <clientId>/)
  })

  it('sends the --data body with the key', async () => {
    const { ctx, calls } = createCommandContext(
      ['smart-apps', 'update', 'patient-portal', '--data', '{"name":"Portal"}'],
      MOCKS,
    )
    await smartAppsCommand(ctx)
    expect(calls[0]?.call).toBe('apps.update')
    expect(calls[0]?.args).toMatchObject({ clientId: 'patient-portal', updateSmartAppRequest: { name: 'Portal' } })
  })

  it('maps the mapper reference onto the resource parameter names', async () => {
    const { ctx, calls } = createCommandContext(
      ['user-federation', 'update-mapper', 'ldap-1', 'm1', '--data', '{"name":"fhir-user"}'],
      MOCKS,
    )
    await userFederationCommand(ctx)
    expect(calls[0]?.args).toMatchObject({ id: 'ldap-1', mapperId: 'm1' })
  })
})

describe('server lifecycle', () => {
  it('refuses to shut down without --yes and names the target', async () => {
    const { ctx, calls } = createCommandContext(['shutdown'], MOCKS)
    await expect(shutdownCommand(ctx)).rejects.toThrow(
      `Refusing to shutdown ${TEST_URL} without confirmation. Re-run with --yes.`,
    )
    expect(calls).toEqual([])
  })

  it('restarts once confirmed', async () => {
    const { ctx, calls } = createCommandContext(['restart', '--yes'], MOCKS)
    await restartCommand(ctx)
    expect(calls.map(c => c.call)).toEqual(['server.restart'])
  })
})
