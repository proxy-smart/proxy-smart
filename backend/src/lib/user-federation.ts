// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ComponentRepresentation from '@keycloak/keycloak-admin-client/lib/defs/componentRepresentation.js'

export const USER_STORAGE_PROVIDER_TYPE = 'org.keycloak.storage.UserStorageProvider'
export const LDAP_PROVIDER_ID = 'ldap'
export const LDAP_MAPPER_TYPE = 'org.keycloak.storage.ldap.mappers.LDAPStorageMapper'

/** Resolves a realm component only when it is a user storage provider, so a route never acts on another component kind by id. */
export async function findUserStorageProvider(admin: KcAdminClient, id: string): Promise<ComponentRepresentation | undefined> {
  const component = await admin.components.findOne({ id })
  return component?.providerType === USER_STORAGE_PROVIDER_TYPE ? component : undefined
}

/** Resolves an LDAP mapper only when it belongs to the given provider. */
export async function findLdapMapper(admin: KcAdminClient, providerId: string, mapperId: string): Promise<ComponentRepresentation | undefined> {
  const component = await admin.components.findOne({ id: mapperId })
  return component?.parentId === providerId && component.providerType === LDAP_MAPPER_TYPE ? component : undefined
}
