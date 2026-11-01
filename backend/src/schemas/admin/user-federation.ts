// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'
import { MapperTypeProperty } from './common'

/**
 * User Federation (LDAP) schemas for Keycloak User Storage Providers
 * Maps to Keycloak's ComponentRepresentation with providerType: org.keycloak.storage.UserStorageProvider
 */

// ==================== LDAP Configuration ====================

export const LdapConfig = t.Object({
  // Connection
  connectionUrl: t.String({ description: 'LDAP connection URL (e.g. ldap://host:389 or ldaps://host:636)' }),
  bindDn: t.Optional(t.String({ description: 'DN used to bind to the LDAP server' })),
  bindCredential: t.Optional(t.String({ description: 'Bind credential (password)' })),
  startTls: t.Optional(t.Boolean({ description: 'Enable StartTLS', default: false })),

  // Users
  usersDn: t.String({ description: 'Full DN of the LDAP tree where users are stored' }),
  usernameLDAPAttribute: t.Optional(t.String({ description: 'LDAP attribute for username', default: 'uid' })),
  rdnLDAPAttribute: t.Optional(t.String({ description: 'LDAP attribute for RDN', default: 'uid' })),
  uuidLDAPAttribute: t.Optional(t.String({ description: 'LDAP attribute for UUID', default: 'entryUUID' })),
  userObjectClasses: t.Optional(t.String({ description: 'LDAP user object classes (comma-separated)', default: 'inetOrgPerson, organizationalPerson' })),
  customUserSearchFilter: t.Optional(t.String({ description: 'Custom LDAP filter for user searches' })),

  // Auth & Sync
  authType: t.Optional(t.String({ description: 'Authentication type (simple or none)', default: 'simple' })),
  searchScope: t.Optional(t.String({ description: 'LDAP search scope (1=one level, 2=subtree)', default: '2' })),
  editMode: t.Optional(t.String({ description: 'Edit mode: READ_ONLY, WRITABLE, or UNSYNCED', default: 'READ_ONLY' })),
  vendor: t.Optional(t.String({ description: 'LDAP vendor: ad, rhds, tivoli, edirectory, other' })),
  pagination: t.Optional(t.Boolean({ description: 'Enable LDAP pagination', default: true })),
  batchSizeForSync: t.Optional(t.String({ description: 'Batch size for synchronization', default: '1000' })),
  fullSyncPeriod: t.Optional(t.String({ description: 'Full sync period in seconds (-1 to disable)', default: '-1' })),
  changedSyncPeriod: t.Optional(t.String({ description: 'Changed users sync period in seconds (-1 to disable)', default: '-1' })),

  // Advanced
  importEnabled: t.Optional(t.Boolean({ description: 'Import users into Keycloak DB', default: true })),
  syncRegistrations: t.Optional(t.Boolean({ description: 'Sync new Keycloak registrations to LDAP', default: false })),
  trustEmail: t.Optional(t.Boolean({ description: 'Trust email addresses from LDAP', default: false })),
  connectionPooling: t.Optional(t.Boolean({ description: 'Enable connection pooling', default: true })),
  connectionTimeout: t.Optional(t.String({ description: 'Connection timeout in ms' })),
  readTimeout: t.Optional(t.String({ description: 'Read timeout in ms' })),
}, { title: 'LdapConfig' })

// ==================== Request Schemas ====================

export const CreateUserFederationRequest = t.Object({
  name: t.String({ description: 'Display name for this federation provider' }),
  config: LdapConfig,
}, { title: 'CreateUserFederationRequest' })

export const UpdateUserFederationRequest = t.Object({
  name: t.Optional(t.String({ description: 'Display name for this federation provider' })),
  config: t.Optional(LdapConfig),
}, { title: 'UpdateUserFederationRequest' })

export const UserFederationSyncRequest = t.Object({
  action: t.Union([
    t.Literal('triggerFullSync'),
    t.Literal('triggerChangedUsersSync'),
  ], { description: 'Sync action to perform' }),
}, { title: 'UserFederationSyncRequest' })

export const LdapTestConnectionRequest = t.Object({
  connectionUrl: t.String({ description: 'LDAP connection URL' }),
  bindDn: t.Optional(t.String({ description: 'Bind DN' })),
  bindCredential: t.Optional(t.String({ description: 'Bind credential' })),
  useTruststoreSpi: t.Optional(t.String({ description: 'Use truststore SPI', default: 'ldapsOnly' })),
  connectionTimeout: t.Optional(t.String({ description: 'Connection timeout in ms' })),
  startTls: t.Optional(t.String({ description: 'Start TLS' })),
  authType: t.Optional(t.String({ description: 'Auth type', default: 'simple' })),
}, { title: 'LdapTestConnectionRequest' })

// ==================== Response Schemas ====================

export const UserFederationProviderResponse = t.Object({
  id: t.Optional(t.String({ description: 'Component ID' })),
  name: t.Optional(t.String({ description: 'Provider name' })),
  providerId: t.Optional(t.String({ description: 'Provider type (ldap)' })),
  providerType: t.Optional(t.String({ description: 'Provider class' })),
  parentId: t.Optional(t.String({ description: 'Parent realm ID' })),
  config: t.Optional(t.Record(t.String(), t.Any({ description: 'Provider configuration' }))),
}, { title: 'UserFederationProviderResponse' })

export const UserFederationSyncResultResponse = t.Object({
  added: t.Optional(t.Number({ description: 'Users added' })),
  updated: t.Optional(t.Number({ description: 'Users updated' })),
  removed: t.Optional(t.Number({ description: 'Users removed' })),
  failed: t.Optional(t.Number({ description: 'Failed operations' })),
  status: t.Optional(t.String({ description: 'Sync status message' })),
  ignored: t.Optional(t.Boolean({ description: 'Whether sync was ignored' })),
}, { title: 'UserFederationSyncResultResponse' })

export const LdapTestConnectionResponse = t.Object({
  success: t.Boolean({ description: 'Whether connection test succeeded' }),
  message: t.Optional(t.String({ description: 'Connection test message' })),
}, { title: 'LdapTestConnectionResponse' })

export const UserFederationMapperResponse = t.Object({
  id: t.Optional(t.String({ description: 'Mapper ID' })),
  name: t.Optional(t.String({ description: 'Mapper name' })),
  providerId: t.Optional(t.String({ description: 'Mapper provider ID' })),
  providerType: t.Optional(t.String({ description: 'Mapper provider type' })),
  parentId: t.Optional(t.String({ description: 'Parent component ID' })),
  config: t.Optional(t.Record(t.String(), t.Any({ description: 'Mapper configuration' }))),
}, { title: 'UserFederationMapperResponse' })

export const UserFederationMapperTypeResponse = t.Object({
  id: t.String({ description: 'Mapper provider ID used as providerId when creating a mapper' }),
  helpText: t.Optional(t.String({ description: 'What this mapper type does' })),
  properties: t.Array(MapperTypeProperty, { description: 'Configurable properties' }),
}, { title: 'UserFederationMapperTypeResponse' })

export const CreateUserFederationMapperRequest = t.Object({
  name: t.String({ description: 'Mapper name (unique per federation provider)' }),
  providerId: t.String({ description: 'LDAP mapper type (e.g. user-attribute-ldap-mapper, group-ldap-mapper)' }),
  config: t.Record(t.String(), t.String(), { description: 'Mapper configuration keyed by the type\'s property names' }),
}, { title: 'CreateUserFederationMapperRequest' })

export const UpdateUserFederationMapperRequest = t.Object({
  name: t.Optional(t.String({ description: 'Mapper name' })),
  config: t.Optional(t.Record(t.String(), t.String(), { description: 'Configuration entries to merge into the mapper' })),
}, { title: 'UpdateUserFederationMapperRequest' })

// ==================== Type Exports ====================

export type LdapConfigType = Static<typeof LdapConfig>
export type CreateUserFederationRequestType = Static<typeof CreateUserFederationRequest>
export type UpdateUserFederationRequestType = Static<typeof UpdateUserFederationRequest>
export type UserFederationSyncRequestType = Static<typeof UserFederationSyncRequest>
export type LdapTestConnectionRequestType = Static<typeof LdapTestConnectionRequest>
export type UserFederationProviderResponseType = Static<typeof UserFederationProviderResponse>
export type UserFederationSyncResultResponseType = Static<typeof UserFederationSyncResultResponse>
export type LdapTestConnectionResponseType = Static<typeof LdapTestConnectionResponse>
export type UserFederationMapperResponseType = Static<typeof UserFederationMapperResponse>
export type UserFederationMapperTypeResponseType = Static<typeof UserFederationMapperTypeResponse>
export type CreateUserFederationMapperRequestType = Static<typeof CreateUserFederationMapperRequest>
export type UpdateUserFederationMapperRequestType = Static<typeof UpdateUserFederationMapperRequest>
