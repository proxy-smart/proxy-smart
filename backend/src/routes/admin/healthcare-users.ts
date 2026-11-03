// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import type KeycloakAdminClient from '@keycloak/keycloak-admin-client'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import {
  SuccessResponse,
  CommonErrorResponses,
  PaginationQuery,
  HealthcareUser,
  CreateHealthcareUserRequest,
  UpdateHealthcareUserRequest,
  UserIdParam,
  type HealthcareUserType,
  type OrganizationMembershipType,
  type SuccessResponseType,
  type ErrorResponseType,
  type UpdateHealthcareUserRequestType,
} from '@/schemas'
import { mapHealthcareUser, requireAdminClient } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'
import { logger } from '@/lib/logger'
import { healthcareUserAccessRoutes } from './healthcare-user-access'
import { assignClientRoles, assignRealmRoles, replaceClientRoles, replaceRealmRoles, type RoleOutcome } from '@/lib/user-role-mappings'
import { findClientByClientId } from '@/lib/keycloak-client-lookup'
import { config } from '@/config'

/** Elysia infers t.Record bodies as {}; the validated value is the schema's Static type. */
function clientRoleEntries(clientRoles: UpdateHealthcareUserRequestType['clientRoles']): [string, string[]][] {
  return Object.entries(clientRoles ?? {})
}

const roleNames = (roles: { name?: string }[]): string[] => roles.flatMap(({ name }) => (name ? [name] : []))

function warnUnapplied(clientId: string, result: RoleOutcome | undefined): void {
  if (!result) logger.admin.warn('Client roles requested for a client that does not exist', { clientId })
  else if (result.missing.length > 0) logger.admin.warn('Some requested client roles do not exist', { clientId, missing: result.missing })
}

/** None when the realm has Organizations off or Keycloak cannot say. */
async function memberOrganizations(admin: KeycloakAdminClient, userId: string): Promise<OrganizationMembershipType[]> {
  try {
    const joined = await admin.organizations.memberOrganizations({ userId })
    return joined.flatMap((org) => org.id && org.name ? [{ id: org.id, name: org.name, alias: org.alias }] : [])
  } catch (error) {
    logger.admin.debug('Could not list organization memberships', { userId, error })
    return []
  }
}

export const healthcareUsersRoutes = new Elysia({ prefix: '/healthcare-users' })
  .use(keycloakPlugin)
  .use(healthcareUserAccessRoutes)
  
  .get('/', async ({ getAdmin, query, set, headers }): Promise<HealthcareUserType[] | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const allUsers = await admin.users.find({
        max: Number(query.limit) || 50,
        first: Number(query.offset) || 0
      })
      
      const adminUiClientId = config.keycloak.adminUiClientId
      const adminUiClient = await findClientByClientId(admin, adminUiClientId).catch(error => {
        logger.admin.warn('Could not resolve the admin UI client', { clientId: adminUiClientId, error })
        return undefined
      })

      const healthcareUsers = await Promise.all(allUsers.flatMap(({ id }) => (id ? [id] : [])).map(async (userId) => {
        const complete = await admin.users.findOne({ id: userId }).catch(error => {
          logger.admin.warn('Failed to get complete details for user', { userId, error })
          return undefined
        })
        const user = complete ?? allUsers.find(u => u.id === userId) ?? { id: userId }

        let realmRoles: string[] = []
        const clientRoles: Record<string, string[]> = {}
        try {
          realmRoles = roleNames(await admin.users.listRealmRoleMappings({ id: userId }))
          if (adminUiClient?.id) {
            clientRoles[adminUiClientId] = roleNames(await admin.users.listClientRoleMappings({ id: userId, clientUniqueId: adminUiClient.id }))
          }
        } catch (roleError) {
          logger.admin.warn('Could not get roles for user', { userId, error: roleError })
        }

        let federatedIdentities: { identityProvider: string; userId: string; userName: string }[] = []
        try {
          federatedIdentities = (await admin.users.listFederatedIdentities({ id: userId })).map(link => ({
            identityProvider: link.identityProvider ?? '',
            userId: link.userId ?? '',
            userName: link.userName ?? ''
          }))
        } catch (fedError) {
          logger.admin.warn('Could not get federated identities for user', { userId, error: fedError })
        }

        return {
          ...mapHealthcareUser(user),
          realmRoles,
          clientRoles,
          organizations: await memberOrganizations(admin, userId),
          federatedIdentities
        }
      }))

      logger.admin.info(`Returning ${healthcareUsers.length} healthcare users`)
      return healthcareUsers
    } catch (error) {
      logger.admin.error('Error in healthcare users endpoint', { error })
      return handleAdminError(error, set)
    }
  }, {
    query: PaginationQuery,
    response: {
      200: t.Array(HealthcareUser),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'List Healthcare Users',
      description: 'Get all healthcare users with optional pagination',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })
  
  .post('/', async ({ getAdmin, body, set, headers }): Promise<HealthcareUserType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const userData = {
        username: body.username,
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
        enabled: body.enabled !== undefined ? body.enabled : true,
        emailVerified: body.emailVerified,
        attributes: {
          organization: body.organization ? [body.organization] : [],
          ...(body.fhirPersons && body.fhirPersons.length > 0 && { 
            fhir_persons: [JSON.stringify(body.fhirPersons)]
          }),
          ...(body.fhirUser && { fhirUser: [body.fhirUser] })
        },
        credentials: body.password ? [{
          type: 'password',
          value: body.password,
          temporary: body.temporaryPassword || false
        }] : []
      }

      const result = await admin.users.create(userData)
      
      // Keycloak does not always return the id, and roles cannot be assigned without it.
      const createdId = result.id
        ?? (await admin.users.find({ username: userData.username, exact: true }))[0]?.id
      if (!createdId) {
        throw new Error('User was created but its id could not be resolved, so roles were not assigned')
      }

      // Not downgraded to a warning: an account created without its roles is not a success.
      const roleOutcome = await assignRealmRoles(admin, createdId, body.realmRoles ?? [])
      if (roleOutcome.missing.length > 0) {
        logger.admin.warn('Some requested realm roles do not exist', {
          username: userData.username, missing: roleOutcome.missing,
        })
      }

      for (const [clientId, roleNames] of clientRoleEntries(body.clientRoles)) {
        warnUnapplied(clientId, await assignClientRoles(admin, createdId, clientId, roleNames))
      }

      const created = await admin.users.findOne({ id: createdId })
      if (!created) return { error: 'Failed to retrieve created user' }
      return { ...mapHealthcareUser(created), realmRoles: roleOutcome.assigned }
    } catch (error) {
      logger.admin.error('Error creating healthcare user', { error })
      return handleAdminError(error, set)
    }
  }, {
    body: CreateHealthcareUserRequest,
    response: {
      200: HealthcareUser,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Create Healthcare User',
      description: 'Create a new healthcare user',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })
  
  .get('/:userId', async ({ getAdmin, params, set, headers }): Promise<HealthcareUserType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const user = await admin.users.findOne({ id: params.userId })
      if (!user) {
        set.status = 404
        return { error: 'Healthcare user not found' }
      }
      return mapHealthcareUser(user)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: UserIdParam,
    response: {
      200: HealthcareUser,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get Healthcare User',
      description: 'Get a healthcare user by userId',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })
  
  .put('/:userId', async ({ getAdmin, params, body, set, headers }): Promise<HealthcareUserType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      
      // Fetch existing user to merge — Keycloak PUT replaces the entire representation
      const existingUser = await admin.users.findOne({ id: params.userId })
      if (!existingUser) {
        set.status = 404
        return { error: 'User not found' }
      }

      const existingAttrs = existingUser.attributes || {}
      const mergedAttributes = {
        ...existingAttrs,
        ...(body.organization !== undefined && { organization: body.organization ? [body.organization] : undefined }),
        ...(body.fhirPersons && body.fhirPersons.length > 0 && { 
          fhir_persons: [JSON.stringify(body.fhirPersons)]
        }),
        ...(body.fhirUser !== undefined && { fhirUser: body.fhirUser ? [body.fhirUser] : undefined })
      }

      const updateData = {
        firstName: body.firstName ?? existingUser.firstName,
        lastName: body.lastName ?? existingUser.lastName,
        email: body.email ?? existingUser.email,
        enabled: body.enabled ?? existingUser.enabled,
        emailVerified: body.emailVerified ?? existingUser.emailVerified,
        attributes: mergedAttributes
      }
      
      await admin.users.update({ id: params.userId }, updateData)
      
      // Handle password reset — Keycloak requires a separate API call for credentials
      const passwordValue = body.password || body.credentials?.find(c => c.type === 'password')?.value
      const isTemporary = body.temporaryPassword ?? body.credentials?.find(c => c.type === 'password')?.temporary ?? false
      if (passwordValue) {
        await admin.users.resetPassword({
          id: params.userId,
          credential: {
            type: 'password',
            value: passwordValue,
            temporary: isTemporary
          }
        })
      }
      
      if (body.realmRoles !== undefined) {
        const { missing } = await replaceRealmRoles(admin, params.userId, body.realmRoles)
        if (missing.length > 0) logger.admin.warn('Some requested realm roles do not exist', { userId: params.userId, missing })
      }
      for (const [clientId, roleNames] of clientRoleEntries(body.clientRoles)) {
        warnUnapplied(clientId, await replaceClientRoles(admin, params.userId, clientId, roleNames))
      }

      // Return the updated user object
      const updated = await admin.users.findOne({ id: params.userId })
      if (!updated) {
        set.status = 404
        return { error: 'Healthcare user not found' }
      }
      return mapHealthcareUser(updated)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: UserIdParam,
    body: UpdateHealthcareUserRequest,
    response: {
      200: HealthcareUser,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Update Healthcare User',
      description: 'Update a healthcare user by userId',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })
  
  .delete('/:userId', async ({ getAdmin, params, set, headers }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      await admin.users.del({ id: params.userId })
      return { success: true, message: 'Healthcare user deleted successfully' }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: UserIdParam,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Delete Healthcare User',
      description: 'Delete a healthcare user by userId',
      tags: ['healthcare-users'],
      security: [{ BearerAuth: [] }]
    }
  })
