// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { mock } from 'bun:test'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation.js'
import type ClientScopeRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientScopeRepresentation.js'

export interface FakeKcAdminOptions {
  /** Clients the realm already has; `clients.find({ clientId })` filters them. */
  clients?: ClientRepresentation[]
  /** Client scopes the realm defines. */
  realmScopes?: ClientScopeRepresentation[]
  /** Names of the optional scopes every client already holds. */
  optionalScopes?: string[]
}

export interface ScopeAssignment {
  id: string
  clientScopeId: string
}

export interface FakeKcAdmin {
  admin: KcAdminClient
  created: ClientRepresentation[]
  updated: { id: string; payload: ClientRepresentation }[]
  defaultScopes: ScopeAssignment[]
  optionalScopes: ScopeAssignment[]
  /** Realm scope names attached so far (the id when the realm has no such scope). */
  defaultScopeNames: () => string[]
  optionalScopeNames: () => string[]
}

/** A real KcAdminClient with client and client-scope calls answered in memory; anything else fails against a dead host. */
export function fakeKcAdmin({ clients = [], realmScopes = [], optionalScopes = [] }: FakeKcAdminOptions = {}): FakeKcAdmin {
  const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
  const scopeName = ({ clientScopeId }: ScopeAssignment) =>
    realmScopes.find((s) => s.id === clientScopeId)?.name ?? clientScopeId
  const fake: FakeKcAdmin = {
    admin,
    created: [],
    updated: [],
    defaultScopes: [],
    optionalScopes: [],
    defaultScopeNames: () => fake.defaultScopes.map(scopeName),
    optionalScopeNames: () => fake.optionalScopes.map(scopeName),
  }
  const assignment = (payload?: ScopeAssignment): ScopeAssignment => ({ id: payload?.id ?? '', clientScopeId: payload?.clientScopeId ?? '' })

  admin.clients.find = async (query) =>
    query?.clientId === undefined ? clients : clients.filter((c) => c.clientId === query.clientId)
  admin.clients.create = async (rep) => {
    fake.created.push(rep ?? {})
    return { id: 'created-client-id' }
  }
  admin.clients.update = async ({ id }, payload) => {
    fake.updated.push({ id, payload })
  }
  admin.clients.listOptionalClientScopes = async () => optionalScopes.map((name) => ({ name }))
  admin.clients.addDefaultClientScope = async (payload) => {
    fake.defaultScopes.push(assignment(payload))
  }
  admin.clients.addOptionalClientScope = async (payload) => {
    fake.optionalScopes.push(assignment(payload))
  }
  admin.clientScopes.find = async () => realmScopes
  admin.clientScopes.findOneByName = async ({ name }) => realmScopes.find((s) => s.name === name)
  return fake
}

/** Replaces the admin client factory; by default no admin connection, as in a stack without Keycloak admin credentials. */
export function mockKcAdminFactory(getAdminClient: () => Promise<unknown> = async () => null): void {
  mock.module('@/lib/kc-admin-factory', () => ({
    getAdminClient,
    invalidateAdminToken: () => {},
    resetAdminClient: () => {},
  }))
}
