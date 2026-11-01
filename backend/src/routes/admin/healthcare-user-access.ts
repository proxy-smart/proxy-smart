// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import {
  SuccessResponse,
  CommonErrorResponses,
  UserIdParam,
  FederatedIdentity,
  LinkFederatedIdentityRequest,
  type SuccessResponseType,
  type ErrorResponseType,
} from '@/schemas'
import { requireAdminClient } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'

/** Additively assigns realm roles; shared by user create and POST /:userId/realm-roles. */
export async function assignRealmRoles(
  admin: KcAdminClient,
  userId: string,
  requested: string[],
): Promise<{ assigned: string[]; missing: string[] }> {
  if (requested.length === 0) return { assigned: [], missing: [] }
  const all = await admin.roles.find()
  const found = all.filter(role => requested.includes(role.name || ''))
  const assigned = found.map(role => role.name!).filter(Boolean)
  if (found.length > 0) {
    await admin.users.addRealmRoleMappings({
      id: userId,
      roles: found.map(role => ({ id: role.id!, name: role.name! })),
    })
  }
  return { assigned, missing: requested.filter(name => !assigned.includes(name)) }
}

/** IdP links and additive role grants, mounted under /healthcare-users; PUT /:userId replaces every role, these touch one. */
export const healthcareUserAccessRoutes = new Elysia()
  .use(keycloakPlugin)

  .get('/:userId/federated-identities', async ({ getAdmin, params, set, headers }) => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const identities = await admin.users.listFederatedIdentities({ id: params.userId })
      return identities.map(id => ({
        identityProvider: id.identityProvider ?? '',
        userId: id.userId ?? '',
        userName: id.userName ?? ''
      }))
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: UserIdParam,
    response: { 200: t.Array(FederatedIdentity), ...CommonErrorResponses },
    detail: {
      summary: 'List Federated Identities',
      description: 'Get all identity provider links for a user',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })

  .post('/:userId/federated-identities/:provider', async ({ getAdmin, params, body, set, headers }) => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const linkBody = body
      await admin.users.addToFederatedIdentity({
        id: params.userId,
        federatedIdentityId: params.provider,
        federatedIdentity: {
          identityProvider: params.provider,
          userId: linkBody.providerUserId,
          userName: linkBody.providerUserName
        }
      })
      return { success: true, message: `Linked identity provider '${params.provider}'` }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      userId: t.String({ description: 'User ID' }),
      provider: t.String({ description: 'Identity provider alias' })
    }),
    body: LinkFederatedIdentityRequest,
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Link Federated Identity',
      description: 'Link an identity provider account to a user',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })

  .delete('/:userId/federated-identities/:provider', async ({ getAdmin, params, set, headers }) => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      await admin.users.delFromFederatedIdentity({
        id: params.userId,
        federatedIdentityId: params.provider
      })
      return { success: true, message: `Unlinked identity provider '${params.provider}'` }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      userId: t.String({ description: 'User ID' }),
      provider: t.String({ description: 'Identity provider alias' })
    }),
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Unlink Federated Identity',
      description: 'Remove an identity provider link from a user',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })

  .post('/:userId/realm-roles', async ({ getAdmin, params, body, set, headers }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })

      // Ensure the user exists before mutating role mappings.
      const user = await admin.users.findOne({ id: params.userId })
      if (!user) { set.status = 404; return { error: 'User not found' } }

      const requested = body.roles ?? []
      if (requested.length === 0) {
        return { success: true, message: 'No roles to add' }
      }

      // addRealmRoleMappings is additive in Keycloak: it does not remove others.
      const { assigned } = await assignRealmRoles(admin, params.userId, requested)
      if (assigned.length === 0) {
        set.status = 404
        return { error: 'None of the requested realm roles exist' }
      }
      return { success: true, message: `Added ${assigned.length} realm role(s)` }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: UserIdParam,
    body: t.Object({
      roles: t.Array(t.String(), { description: 'Realm role names to add (additive, existing roles are preserved)' })
    }),
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Add Realm Roles to User',
      description: 'Additively assign realm roles to a user without removing existing roles.',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })

  .delete('/:userId/realm-roles/:roleName', async ({ getAdmin, params, set, headers }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })

      const role = await admin.roles.findOneByName({ name: params.roleName })
      if (!role) { set.status = 404; return { error: `Realm role '${params.roleName}' not found` } }

      await admin.users.delRealmRoleMappings({
        id: params.userId,
        roles: [{ id: role.id!, name: role.name! }]
      })
      return { success: true, message: `Removed realm role '${params.roleName}'` }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      userId: t.String({ description: 'User ID' }),
      roleName: t.String({ description: 'Realm role name to remove' })
    }),
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Remove Realm Role from User',
      description: 'Remove a single realm role from a user without touching the others.',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })

  .post('/:userId/client-roles/:clientId', async ({ getAdmin, params, body, set, headers }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })

      const user = await admin.users.findOne({ id: params.userId })
      if (!user) { set.status = 404; return { error: 'User not found' } }

      const clients = await admin.clients.find({ clientId: params.clientId })
      if (clients.length === 0) { set.status = 404; return { error: `Client '${params.clientId}' not found` } }
      const client = clients[0]

      const requested = body.roles ?? []
      if (requested.length === 0) {
        return { success: true, message: 'No roles to add' }
      }

      const clientRoles = await admin.clients.listRoles({ id: client.id! })
      const rolesToAssign = clientRoles
        .filter(role => requested.includes(role.name || ''))
        .map(role => ({ id: role.id!, name: role.name! }))

      if (rolesToAssign.length === 0) {
        set.status = 404
        return { error: `None of the requested client roles exist for '${params.clientId}'` }
      }

      await admin.users.addClientRoleMappings({
        id: params.userId,
        clientUniqueId: client.id!,
        roles: rolesToAssign
      })
      return { success: true, message: `Added ${rolesToAssign.length} client role(s) for '${params.clientId}'` }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      userId: t.String({ description: 'User ID' }),
      clientId: t.String({ description: 'Keycloak client ID (e.g. admin-ui)' })
    }),
    body: t.Object({
      roles: t.Array(t.String(), { description: 'Client role names to add (additive, existing roles are preserved)' })
    }),
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Add Client Roles to User',
      description: 'Additively assign client roles to a user without removing existing roles.',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })

  .delete('/:userId/client-roles/:clientId/:roleName', async ({ getAdmin, params, set, headers }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })

      const clients = await admin.clients.find({ clientId: params.clientId })
      if (clients.length === 0) { set.status = 404; return { error: `Client '${params.clientId}' not found` } }
      const client = clients[0]

      const clientRoles = await admin.clients.listRoles({ id: client.id! })
      const role = clientRoles.find(r => r.name === params.roleName)
      if (!role) { set.status = 404; return { error: `Client role '${params.roleName}' not found for '${params.clientId}'` } }

      await admin.users.delClientRoleMappings({
        id: params.userId,
        clientUniqueId: client.id!,
        roles: [{ id: role.id!, name: role.name! }]
      })
      return { success: true, message: `Removed client role '${params.roleName}'` }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      userId: t.String({ description: 'User ID' }),
      clientId: t.String({ description: 'Keycloak client ID (e.g. admin-ui)' }),
      roleName: t.String({ description: 'Client role name to remove' })
    }),
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Remove Client Role from User',
      description: 'Remove a single client role from a user without touching the others.',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })
