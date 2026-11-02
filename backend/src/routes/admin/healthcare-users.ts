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
import { assignRealmRoles, healthcareUserAccessRoutes } from './healthcare-user-access'

/** Elysia infers t.Record bodies as {}; the validated value is the schema's Static type. */
function clientRoleEntries(clientRoles: UpdateHealthcareUserRequestType['clientRoles']): [string, string[]][] {
  return Object.entries(clientRoles ?? {})
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
      
      logger.admin.info(`Found ${allUsers.length} users`)
      
      // Fetch complete user details (including timestamps) for each user
      const completeUsers = await Promise.all(
        allUsers.map(async (user) => {
          try {
            // Get complete user details including timestamps
            const completeUser = await admin.users.findOne({ id: user.id! })
            logger.admin.debug(`Complete user data for ${user.username}`, {
              id: completeUser?.id,
              username: completeUser?.username,
              createdTimestamp: completeUser?.createdTimestamp,
              created: completeUser?.createdTimestamp ? new Date(completeUser.createdTimestamp).toISOString() : 'null/undefined'
            })
            return completeUser || user
          } catch (error) {
            logger.admin.warn(`Failed to get complete details for user ${user.username}`, { error })
            return user
          }
        })
      )
      
      // Same client for every user in the loop below, so it is looked up once.
      const adminUiClientId = await admin.clients
        .find({ clientId: 'admin-ui' })
        .then(clients => clients[0]?.id)
        .catch(error => {
          logger.admin.warn('Could not resolve the admin-ui client', { error })
          return undefined
        })

      // Filter for healthcare users and map them with role information
      const healthcareUsers = await Promise.all(completeUsers.map(async (user) => {
        const profile = mapHealthcareUser(user)
        
        // Get user's realm roles and client roles
        let realmRoles: string[] = []
        const clientRoles: Record<string, string[]> = {}
        try {
          const userRoles = await admin.users.listRealmRoleMappings({ id: user.id! })
          realmRoles = userRoles.map(role => role.name || '').filter(Boolean)
          
          // Get client role mappings for admin-ui client
          if (adminUiClientId) {
            try {
              const userClientRoles = await admin.users.listClientRoleMappings({ id: user.id!, clientUniqueId: adminUiClientId })
              clientRoles['admin-ui'] = userClientRoles.map(role => role.name || '').filter(Boolean)
            } catch (clientRoleError) {
              logger.admin.warn(`Could not get client roles for user ${user.username}`, { error: clientRoleError })
            }
          }
        } catch (roleError) {
          logger.admin.warn(`Could not get roles for user ${user.username}`, { error: roleError })
        }
        
        // Get federated identity links
        let federatedIdentities: { identityProvider: string; userId: string; userName: string }[] = []
        try {
          const links = await admin.users.listFederatedIdentities({ id: user.id! })
          federatedIdentities = links.map(link => ({
            identityProvider: link.identityProvider ?? '',
            userId: link.userId ?? '',
            userName: link.userName ?? ''
          }))
        } catch (fedError) {
          logger.admin.warn(`Could not get federated identities for user ${user.username}`, { error: fedError })
        }
        
        return {
          ...profile,
          realmRoles,
          clientRoles,
          organizations: await memberOrganizations(admin, user.id!),
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
      
      // The id is needed to assign roles. The client does not always return one,
      // and the old code silently skipped the whole block when it did not — which
      // is how a create could accept realmRoles and apply none of them.
      const createdId = result.id
        ?? (await admin.users.find({ username: userData.username, exact: true }))[0]?.id
      if (!createdId) {
        throw new Error('User was created but its id could not be resolved, so roles were not assigned')
      }

      // Deliberately NOT wrapped in a catch that downgrades to a warning: an
      // account created without its roles is not a success worth reporting as one.
      const roleOutcome = await assignRealmRoles(admin, createdId, body.realmRoles ?? [])
      if (roleOutcome.missing.length > 0) {
        logger.admin.warn('Some requested realm roles do not exist', {
          username: userData.username, missing: roleOutcome.missing,
        })
      }

      if (createdId && body.clientRoles) {
        try {
          
          // Assign client roles
          if (body.clientRoles) {
            for (const [clientId, roleNames] of clientRoleEntries(body.clientRoles)) {
              try {
                const clients = await admin.clients.find({ clientId })
                if (clients.length > 0) {
                  const client = clients[0]
                  const clientRoles = await admin.clients.listRoles({ id: client.id! })
                  const rolesToAssign = clientRoles.filter(role => 
                    roleNames.includes(role.name || '')
                  ).map(role => ({ id: role.id!, name: role.name! }))
                  if (rolesToAssign.length > 0) {
                    await admin.users.addClientRoleMappings({
                      id: createdId,
                      clientUniqueId: client.id!,
                      roles: rolesToAssign
                    })
                  }
                }
              } catch (clientError) {
                logger.admin.warn(`Could not assign client roles for ${clientId}`, { clientId, error: clientError })
              }
            }
          }
        } catch (roleError) {
          logger.admin.warn('Could not assign roles', { error: roleError })
        }
      }
      
      // Echo the roles that actually stuck. The response schema always declared
      // realmRoles; the mapper never filled it, so the create answered 200 with no
      // way to tell whether the roles had been applied.
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
      
      // Handle role updates if specified
      if (body.realmRoles !== undefined || body.clientRoles !== undefined) {
        try {
          // Update realm roles
          if (body.realmRoles !== undefined) {
            // Remove all existing realm roles
            const existingRoles = await admin.users.listRealmRoleMappings({ id: params.userId })
            if (existingRoles.length > 0) {
              await admin.users.delRealmRoleMappings({
                id: params.userId,
                roles: existingRoles.map(role => ({ id: role.id!, name: role.name! }))
              })
            }
            
            // Add new realm roles
            if (body.realmRoles.length > 0) {
              const allRealmRoles = await admin.roles.find()
              const rolesToAssign = allRealmRoles.filter(role => 
                body.realmRoles!.includes(role.name || '')
              ).map(role => ({ id: role.id!, name: role.name! }))
              if (rolesToAssign.length > 0) {
                await admin.users.addRealmRoleMappings({
                  id: params.userId,
                  roles: rolesToAssign
                })
              }
            }
          }
          
          // Update client roles
          if (body.clientRoles !== undefined) {
            for (const [clientId, roleNames] of clientRoleEntries(body.clientRoles)) {
              try {
                const clients = await admin.clients.find({ clientId })
                if (clients.length > 0) {
                  const client = clients[0]
                  
                  // Remove existing client roles
                  const existingClientRoles = await admin.users.listClientRoleMappings({ 
                    id: params.userId, 
                    clientUniqueId: client.id! 
                  })
                  if (existingClientRoles.length > 0) {
                    await admin.users.delClientRoleMappings({
                      id: params.userId,
                      clientUniqueId: client.id!,
                      roles: existingClientRoles.map(role => ({ id: role.id!, name: role.name! }))
                    })
                  }
                  
                  // Add new client roles
                  if (roleNames.length > 0) {
                    const clientRoles = await admin.clients.listRoles({ id: client.id! })
                    const rolesToAssign = clientRoles.filter(role => 
                      roleNames.includes(role.name || '')
                    ).map(role => ({ id: role.id!, name: role.name! }))
                    if (rolesToAssign.length > 0) {
                      await admin.users.addClientRoleMappings({
                        id: params.userId,
                        clientUniqueId: client.id!,
                        roles: rolesToAssign
                      })
                    }
                  }
                }
              } catch (clientError) {
                logger.admin.warn(`Could not update client roles for ${clientId}`, { clientId, userId: params.userId, error: clientError })
              }
            }
          }
        } catch (roleError) {
          logger.admin.warn('Could not update roles', { userId: params.userId, error: roleError })
        }
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
