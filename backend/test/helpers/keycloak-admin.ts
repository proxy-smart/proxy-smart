// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { mock } from 'bun:test'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation.js'
import type ClientScopeRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientScopeRepresentation.js'
import type ClientPolicyRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientPolicyRepresentation.js'
import type UserConsentRepresentation from '@keycloak/keycloak-admin-client/lib/defs/userConsentRepresentation.js'

export interface FakeKcAdminOptions {
  /** Clients the realm already has; `clients.find({ clientId })` filters them. */
  clients?: ClientRepresentation[]
  /** Client scopes the realm defines. */
  realmScopes?: ClientScopeRepresentation[]
  /** Names of the optional scopes every client already holds. */
  optionalScopes?: string[]
  /** Default scope names a client already holds, by its internal id. */
  clientDefaultScopes?: Record<string, string[]>
  /** The realm's attributes; `realms.update` replaces them. */
  realmAttributes?: Record<string, string>
  /** Realm client policies; `clientPolicies.updatePolicy` replaces them. */
  policies?: ClientPolicyRepresentation[]
  /** Each user's Keycloak consents and offline grants, by user id; `users.revokeConsent` removes one. */
  consents?: Record<string, UserConsentRepresentation[]>
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
  createdScopes: ClientScopeRepresentation[]
  addedMappers: { scopeId: string; name?: string }[]
  /** Realm scope names attached so far (the id when the realm has no such scope). */
  defaultScopeNames: () => string[]
  optionalScopeNames: () => string[]
  realmAttributes: Record<string, string>
  policies: ClientPolicyRepresentation[]
  consents: Record<string, UserConsentRepresentation[]>
  revokedConsents: { id: string; clientId: string }[]
}

export const CREATED_CLIENT_ID = 'created-client-id'

/** A real KcAdminClient with client and client-scope calls answered in memory; anything else fails against a dead host. */
export function fakeKcAdmin({
  clients = [],
  realmScopes = [],
  optionalScopes = [],
  clientDefaultScopes = {},
  realmAttributes = {},
  policies = [],
  consents = {},
}: FakeKcAdminOptions = {}): FakeKcAdmin {
  const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
  const scopeName = ({ clientScopeId }: ScopeAssignment) =>
    realmScopes.find((s) => s.id === clientScopeId)?.name ?? clientScopeId
  const fake: FakeKcAdmin = {
    admin,
    created: [],
    updated: [],
    defaultScopes: [],
    optionalScopes: [],
    createdScopes: [],
    addedMappers: [],
    defaultScopeNames: () => fake.defaultScopes.map(scopeName),
    optionalScopeNames: () => fake.optionalScopes.map(scopeName),
    realmAttributes: { ...realmAttributes },
    policies: [...policies],
    consents: structuredClone(consents),
    revokedConsents: [],
  }
  const assignment = (payload?: ScopeAssignment): ScopeAssignment => ({ id: payload?.id ?? '', clientScopeId: payload?.clientScopeId ?? '' })

  admin.clients.find = async (query) =>
    query?.clientId === undefined ? clients : clients.filter((c) => c.clientId === query.clientId)
  admin.clients.create = async (rep) => {
    fake.created.push(rep ?? {})
    return { id: CREATED_CLIENT_ID }
  }
  admin.clients.findOne = async (query) => {
    const id = query?.id
    const created = fake.created[fake.created.length - 1]
    return id === CREATED_CLIENT_ID && created ? { ...created, id } : clients.find((c) => c.id === id)
  }
  admin.clients.update = async ({ id }, payload) => {
    fake.updated.push({ id, payload })
  }
  admin.clients.listOptionalClientScopes = async () => optionalScopes.map((name) => ({ name }))
  admin.clients.listDefaultClientScopes = async (query) =>
    (clientDefaultScopes[query?.id ?? ''] ?? []).map((name) => ({ name }))
  admin.clients.addDefaultClientScope = async (payload) => {
    fake.defaultScopes.push(assignment(payload))
  }
  admin.clients.addOptionalClientScope = async (payload) => {
    fake.optionalScopes.push(assignment(payload))
  }
  admin.realms.findOne = async (query) => ({ realm: query?.realm, attributes: { ...fake.realmAttributes } })
  admin.realms.update = async (_query, rep) => {
    fake.realmAttributes = { ...(rep.attributes ?? {}) }
  }
  admin.users.listConsents = async (query) => fake.consents[query?.id ?? ''] ?? []
  admin.users.revokeConsent = async (query) => {
    const id = query?.id ?? ''
    const clientId = query?.clientId ?? ''
    fake.revokedConsents.push({ id, clientId })
    fake.consents[id] = (fake.consents[id] ?? []).filter((consent) => consent.clientId !== clientId)
  }
  admin.clientPolicies.listPolicies = async () => ({ policies: fake.policies })
  admin.clientPolicies.updatePolicy = async (rep) => {
    fake.policies = rep?.policies ?? []
  }
  admin.clientScopes.find = async () => realmScopes
  admin.clientScopes.findOneByName = async ({ name }) => realmScopes.find((s) => s.name === name)
  admin.clientScopes.create = async (rep) => {
    const scope = { ...rep, id: `scope-${rep?.name ?? fake.createdScopes.length}` }
    fake.createdScopes.push(scope)
    realmScopes.push(scope)
    return { id: scope.id }
  }
  admin.clientScopes.listProtocolMappers = async (query) =>
    realmScopes.find((s) => s.id === query?.id)?.protocolMappers ?? []
  admin.clientScopes.addProtocolMapper = async (query, mapper) => {
    fake.addedMappers.push({ scopeId: query?.id ?? '', name: mapper?.name })
  }
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
