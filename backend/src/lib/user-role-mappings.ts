// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type RoleRepresentation from '@keycloak/keycloak-admin-client/lib/defs/roleRepresentation.js'
import { findClientByClientId } from './keycloak-client-lookup'

export interface RoleMapping {
  id: string
  name: string
}

export interface RoleOutcome {
  assigned: string[]
  missing: string[]
}

export interface ClientRoles {
  clientUniqueId: string
  roles: RoleMapping[]
}

/** The role mappings Keycloak accepts; a representation without id or name cannot be mapped. */
export function roleMappings(roles: RoleRepresentation[]): RoleMapping[] {
  return roles.flatMap(({ id, name }) => (id && name ? [{ id, name }] : []))
}

const outcome = (requested: string[], found: RoleMapping[]): RoleOutcome => {
  const assigned = found.map(role => role.name)
  return { assigned, missing: requested.filter(name => !assigned.includes(name)) }
}

const pick = (available: RoleMapping[], requested: string[]) => available.filter(role => requested.includes(role.name))

const notIn = (roles: RoleMapping[], other: RoleMapping[]) => roles.filter(role => !other.some(o => o.id === role.id))

export async function findClientRoles(admin: KcAdminClient, clientId: string): Promise<ClientRoles | undefined> {
  const client = await findClientByClientId(admin, clientId)
  if (!client?.id) return undefined
  return { clientUniqueId: client.id, roles: roleMappings(await admin.clients.listRoles({ id: client.id })) }
}

/** Additively maps the requested realm roles that exist. */
export async function assignRealmRoles(admin: KcAdminClient, userId: string, requested: string[]): Promise<RoleOutcome> {
  if (requested.length === 0) return { assigned: [], missing: [] }
  const found = pick(roleMappings(await admin.roles.find()), requested)
  if (found.length > 0) await admin.users.addRealmRoleMappings({ id: userId, roles: found })
  return outcome(requested, found)
}

/** Makes the user's direct realm roles exactly the requested ones, touching only the difference. */
export async function replaceRealmRoles(admin: KcAdminClient, userId: string, requested: string[]): Promise<RoleOutcome> {
  const wanted = pick(roleMappings(await admin.roles.find()), requested)
  const current = roleMappings(await admin.users.listRealmRoleMappings({ id: userId }))
  const toRemove = notIn(current, wanted)
  const toAdd = notIn(wanted, current)
  if (toRemove.length > 0) await admin.users.delRealmRoleMappings({ id: userId, roles: toRemove })
  if (toAdd.length > 0) await admin.users.addRealmRoleMappings({ id: userId, roles: toAdd })
  return outcome(requested, wanted)
}

/** Additively maps the requested roles of one client; undefined when the client does not exist. */
export async function assignClientRoles(admin: KcAdminClient, userId: string, clientId: string, requested: string[]): Promise<RoleOutcome | undefined> {
  const client = await findClientRoles(admin, clientId)
  if (!client) return undefined
  const found = pick(client.roles, requested)
  if (found.length > 0) await admin.users.addClientRoleMappings({ id: userId, clientUniqueId: client.clientUniqueId, roles: found })
  return outcome(requested, found)
}

/** Makes the user's roles of one client exactly the requested ones; undefined when the client does not exist. */
export async function replaceClientRoles(admin: KcAdminClient, userId: string, clientId: string, requested: string[]): Promise<RoleOutcome | undefined> {
  const client = await findClientRoles(admin, clientId)
  if (!client) return undefined
  const { clientUniqueId } = client
  const wanted = pick(client.roles, requested)
  const current = roleMappings(await admin.users.listClientRoleMappings({ id: userId, clientUniqueId }))
  const toRemove = notIn(current, wanted)
  const toAdd = notIn(wanted, current)
  if (toRemove.length > 0) await admin.users.delClientRoleMappings({ id: userId, clientUniqueId, roles: toRemove })
  if (toAdd.length > 0) await admin.users.addClientRoleMappings({ id: userId, clientUniqueId, roles: toAdd })
  return outcome(requested, wanted)
}
