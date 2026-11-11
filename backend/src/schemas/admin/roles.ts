// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'
import { AttributesMap } from './common'

// A role's scope-set link is a descriptive label only; it never grants or denies FHIR/MCP access.

export const Role = t.Object({
  id: t.Optional(t.String({ description: 'Role ID' })),
  name: t.Optional(t.String({ description: 'Role name' })),
  description: t.Optional(t.String({ description: 'Role description' })),
  attributes: t.Optional(AttributesMap)
}, { title: 'Role' })

export const RoleResponse = t.Object({
  id: t.Optional(t.String({ description: 'Role ID' })),
  name: t.Optional(t.String({ description: 'Role name' })),
  description: t.Optional(t.String({ description: 'Role description' })),
  composite: t.Optional(t.Boolean({ description: 'Whether this is a Keycloak composite role' })),
  clientRole: t.Optional(t.Boolean({ description: 'Whether this is a client-level role' })),
  attributes: t.Optional(AttributesMap),
  isTechnical: t.Optional(t.Boolean({
    description: 'True for plumbing roles (offline_access, default-roles-*, uma_authorization) the UI hides by default'
  })),
  grantsAdmin: t.Optional(t.Boolean({
    description: 'True when holding this role confers admin access (same predicate the auth path uses). Realm and admin-UI client locations are equivalent.'
  })),
  representedScopeSetId: t.Optional(t.String({
    description: 'ID of a scope set this role represents (descriptive label only, not enforced)'
  })),
  representedScopeSetName: t.Optional(t.String({
    description: 'Resolved name of the represented scope set'
  })),
  representedScopes: t.Optional(t.Array(t.String(), {
    description: 'Resolved scopes the role typically represents (from the linked scope set and/or fhir_scopes attribute). Descriptive only.'
  }))
}, { title: 'RoleResponse' })

export const CreateRoleRequest = t.Object({
  name: t.String({ description: 'Role name (must be unique)' }),
  description: t.Optional(t.String({ description: 'Role description' })),
  fhirScopes: t.Optional(t.Array(t.String(), { description: 'FHIR scopes this role typically represents (descriptive label, not enforced)' })),
  representedScopeSetId: t.Optional(t.String({ description: 'ID of a scope set this role represents (descriptive label only)' }))
}, { title: 'CreateRoleRequest' })

export const UpdateRoleRequest = t.Object({
  description: t.Optional(t.String({ description: 'Role description' })),
  fhirScopes: t.Optional(t.Array(t.String(), { description: 'FHIR scopes this role typically represents (descriptive label, not enforced)' })),
  representedScopeSetId: t.Optional(t.String({ description: 'ID of a scope set this role represents (descriptive label only). Pass an empty string to clear.' }))
}, { title: 'UpdateRoleRequest' })

/** `clientId` is the OAuth client id, not Keycloak's internal UUID; the routes resolve it. */
export const ClientRoleParams = t.Object({
  clientId: t.String({ description: 'OAuth2 client ID that owns the role' }),
  roleName: t.String({ description: 'Client role name' })
}, { title: 'ClientRoleParams' })

export type RoleType = Static<typeof Role>
export type RoleResponseType = Static<typeof RoleResponse>
export type CreateRoleRequestType = Static<typeof CreateRoleRequest>
export type UpdateRoleRequestType = Static<typeof UpdateRoleRequest>
