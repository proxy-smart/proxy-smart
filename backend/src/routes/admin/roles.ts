// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import { 
  CommonErrorResponses, 
  CreateRoleRequest, 
  UpdateRoleRequest,
  RoleResponse,
  SuccessResponse,
  ClientRoleParams,
  type RoleResponseType,
  type SuccessResponseType,
  type ErrorResponseType
} from '@/schemas'
import { handleAdminError } from '@/lib/admin-error-handler'
import { requireAdminClient } from '@/lib/admin-utils'
import { enrichRole, isTechnicalRole } from '@/lib/role-metadata'
import { buildRoleAttributes, mergeRoleUpdate } from '@/lib/role-payload'
import { resolveClientInternalId } from '@/lib/keycloak-client-lookup'
import { logger } from '@/lib/logger'

/**
 * Healthcare Roles & Permissions Management
 *
 * All routes now use the user's access token to perform operations,
 * acting as a secure proxy for Keycloak admin operations.
 *
 * Roles carry DESCRIPTIVE metadata only: a role may reference a scope set as a
 * human-readable label of the "typical scopes it represents". This is never used
 * for FHIR/MCP access enforcement (that stays scope-based in smart-access-control.ts).
 */
export const rolesRoutes = new Elysia({ prefix: '/roles' })
  .use(keycloakPlugin)

  .get('/', async ({ getAdmin, headers, query, set }): Promise<RoleResponseType[] | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const realmRoles = await admin.roles.find()

      // Hide plumbing roles (offline_access, default-roles-*, uma_authorization)
      // by default. Pass ?includeTechnical=true to include them.
      const includeTechnical = query.includeTechnical === 'true'
      const filtered = includeTechnical
        ? realmRoles
        : realmRoles.filter(role => !isTechnicalRole(role))

      return filtered.map(enrichRole)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    query: t.Object({
      includeTechnical: t.Optional(t.String({ description: 'Set to "true" to include technical/plumbing roles (default hides them)' }))
    }),
    response: {
      200: t.Array(RoleResponse),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'List All Roles',
      description: 'Get all realm roles, enriched with descriptive metadata (isTechnical flag + represented scope set). Technical/plumbing roles are hidden unless ?includeTechnical=true.',
      tags: ['roles']
    }
  })

  .post('/', async ({ getAdmin, body, headers, set }): Promise<RoleResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      await admin.roles.create({
        name: body.name,
        description: body.description,
        attributes: buildRoleAttributes(body)
      })
      // Return the created role object (fetch by name), enriched with metadata.
      const created = await admin.roles.findOneByName({ name: body.name })
      return created ? enrichRole(created) : {}
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: CreateRoleRequest,
    response: {
      200: RoleResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Create Healthcare Role',
      description: 'Create a new healthcare-specific role',
      tags: ['roles']
    }
  })

  .get('/:roleName', async ({ getAdmin, params, headers, set }): Promise<RoleResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const role = await admin.roles.findOneByName({ name: params.roleName })

      if (!role) {
        set.status = 404
        return { error: 'Role not found' }
      }

      return enrichRole(role)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      roleName: t.String({ description: 'Role name' })
    }),
    response: {
      200: RoleResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get Healthcare Role',
      description: 'Get a healthcare-specific role by name',
      tags: ['roles']
    }
  })

  .put('/:roleName', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const role = await admin.roles.findOneByName({ name: params.roleName })

      if (!role) {
        set.status = 404
        return { error: 'Role not found' }
      }

      await admin.roles.updateByName({ name: params.roleName }, mergeRoleUpdate(role, body))
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      roleName: t.String({ description: 'Role name' })
    }),
    body: UpdateRoleRequest,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Update Healthcare Role',
      description: 'Update a healthcare-specific role by name',
      tags: ['roles']
    }
  })

  .delete('/:roleName', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })

      // Check if role exists before deletion
      const role = await admin.roles.findOneByName({ name: params.roleName })
      if (!role) {
        set.status = 404
        return { error: 'Role not found' }
      }

      await admin.roles.delByName({ name: params.roleName })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      roleName: t.String({ description: 'Role name' })
    }),
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Delete Healthcare Role',
      description: 'Delete a healthcare-specific role by name',
      tags: ['roles']
    }
  })

  // ─── Composites ─────────────────────────────────────────────────────────────
  //
  // A COMPOSITE role grants other roles. The realm's default role
  // (`default-roles-<realm>`) is the one that matters most here: Keycloak assigns it to every
  // user it creates, including users created by an identity-provider broker, so whatever it
  // grants is the baseline every account starts with.
  //
  // These endpoints exist because that baseline was previously unreadable and unfixable through
  // the proxy. `offline_access` missing from the default composite lets a user log in and then
  // fail the token exchange with "Offline tokens not allowed for the user or client" — a failure
  // that looks like a broken server and is invisible without being able to inspect the composite.
  // Diagnosing it meant the Keycloak console; repairing it meant raw Keycloak REST. Now neither.

  .get('/:roleName/composites', async ({ getAdmin, params, headers, set }): Promise<RoleResponseType[] | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const role = await admin.roles.findOneByName({ name: params.roleName })
      if (!role?.id) {
        set.status = 404
        return { error: 'Role not found' }
      }

      // Realm composites only. A composite may also grant CLIENT roles, which are listed per
      // client and would make this response two different shapes in one array.
      const composites = await admin.roles.getCompositeRolesForRealm({ id: role.id })
      return composites.map(enrichRole)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      roleName: t.String({ description: 'Composite role name, e.g. default-roles-proxy-smart' })
    }),
    response: {
      200: t.Array(RoleResponse),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'List Realm Roles Granted By A Composite',
      description:
        'The realm roles a composite role grants. For `default-roles-<realm>` this is the baseline every user — including brokered users — receives at creation.',
      tags: ['roles']
    }
  })

  .post('/:roleName/composites', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const role = await admin.roles.findOneByName({ name: params.roleName })
      if (!role?.id) {
        set.status = 404
        return { error: 'Role not found' }
      }

      // Resolve every name to a real role BEFORE writing anything: Keycloak accepts a partial
      // list and silently ignores entries it cannot resolve, so a typo would otherwise report
      // success while granting nothing.
      const resolved = []
      for (const name of body.realmRoles) {
        const target = await admin.roles.findOneByName({ name })
        if (!target?.id) {
          set.status = 400
          return { error: `Realm role not found: ${name}` }
        }
        resolved.push(target)
      }

      // Idempotent: Keycloak treats re-adding an existing composite as a no-op, so this is safe
      // to run as a reconcile step.
      await admin.roles.createComposite({ roleId: role.id }, resolved)
      logger.admin.info('Composite roles added', {
        composite: params.roleName,
        added: body.realmRoles,
      })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      roleName: t.String({ description: 'Composite role name' })
    }),
    body: t.Object({
      realmRoles: t.Array(t.String(), {
        minItems: 1,
        description: 'Realm role names to grant through this composite',
      })
    }),
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Grant Realm Roles Through A Composite',
      description:
        'Adds realm roles to a composite. Idempotent. Every name is resolved before any write, so an unknown role fails the request rather than being silently skipped.',
      tags: ['roles']
    }
  })

  .delete('/:roleName/composites/:compositeName', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const role = await admin.roles.findOneByName({ name: params.roleName })
      if (!role?.id) {
        set.status = 404
        return { error: 'Role not found' }
      }
      const target = await admin.roles.findOneByName({ name: params.compositeName })
      if (!target?.id) {
        set.status = 404
        return { error: `Realm role not found: ${params.compositeName}` }
      }

      await admin.roles.delCompositeRoles({ id: role.id }, [target])
      logger.admin.info('Composite role removed', {
        composite: params.roleName,
        removed: params.compositeName,
      })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      roleName: t.String({ description: 'Composite role name' }),
      compositeName: t.String({ description: 'Realm role to stop granting' })
    }),
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Revoke A Realm Role From A Composite',
      description:
        'Removes one realm role from a composite. Exists so granting through a composite is reversible without the Keycloak console.',
      tags: ['roles']
    }
  })

  // ─── Client Roles ───────────────────────────────────────────────────────────

  .get('/clients/:clientId', async ({ getAdmin, params, headers, set }): Promise<RoleResponseType[] | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const internalId = await resolveClientInternalId(admin, params.clientId)
      if (!internalId) {
        set.status = 404
        return { error: `Client '${params.clientId}' not found` }
      }

      const clientRoles = await admin.clients.listRoles({ id: internalId })
      return clientRoles.map(enrichRole)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      clientId: t.String({ description: 'Keycloak client ID' })
    }),
    response: {
      200: t.Array(RoleResponse),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'List Client Roles',
      description: 'Get all roles for a specific Keycloak client (e.g., admin-ui)',
      tags: ['roles']
    }
  })

  .post('/clients/:clientId', async ({ getAdmin, params, body, headers, set }): Promise<RoleResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const internalId = await resolveClientInternalId(admin, params.clientId)
      if (!internalId) {
        set.status = 404
        return { error: `Client '${params.clientId}' not found` }
      }

      const existing = await admin.clients.findRole({ id: internalId, roleName: body.name })
      if (existing) {
        set.status = 409
        return { error: `Role '${body.name}' already exists on client '${params.clientId}'` }
      }

      await admin.clients.createRole({
        id: internalId,
        name: body.name,
        description: body.description,
        attributes: buildRoleAttributes(body)
      })

      logger.admin.info('Created client role', { clientId: params.clientId, role: body.name })

      const created = await admin.clients.findRole({ id: internalId, roleName: body.name })
      return created ? enrichRole(created) : {}
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      clientId: t.String({ description: 'Keycloak client ID' })
    }),
    body: CreateRoleRequest,
    response: {
      200: RoleResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Create Client Role',
      description: 'Create a role scoped to a specific Keycloak client, resolved by client id',
      tags: ['roles']
    }
  })

  .get('/clients/:clientId/:roleName', async ({ getAdmin, params, headers, set }): Promise<RoleResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const internalId = await resolveClientInternalId(admin, params.clientId)
      if (!internalId) {
        set.status = 404
        return { error: `Client '${params.clientId}' not found` }
      }

      const role = await admin.clients.findRole({ id: internalId, roleName: params.roleName })
      if (!role) {
        set.status = 404
        return { error: `Role '${params.roleName}' not found on client '${params.clientId}'` }
      }

      return enrichRole(role)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: ClientRoleParams,
    response: {
      200: RoleResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get Client Role',
      description: 'Get a single role on a specific Keycloak client',
      tags: ['roles']
    }
  })

  .put('/clients/:clientId/:roleName', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const internalId = await resolveClientInternalId(admin, params.clientId)
      if (!internalId) {
        set.status = 404
        return { error: `Client '${params.clientId}' not found` }
      }

      const role = await admin.clients.findRole({ id: internalId, roleName: params.roleName })
      if (!role) {
        set.status = 404
        return { error: `Role '${params.roleName}' not found on client '${params.clientId}'` }
      }

      await admin.clients.updateRole(
        { id: internalId, roleName: params.roleName },
        mergeRoleUpdate(role, body)
      )

      logger.admin.info('Updated client role', { clientId: params.clientId, role: params.roleName })

      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: ClientRoleParams,
    body: UpdateRoleRequest,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Update Client Role',
      description: 'Update a role on a specific Keycloak client. Same descriptive metadata as realm roles.',
      tags: ['roles']
    }
  })

  .delete('/clients/:clientId/:roleName', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const internalId = await resolveClientInternalId(admin, params.clientId)
      if (!internalId) {
        set.status = 404
        return { error: `Client '${params.clientId}' not found` }
      }

      const role = await admin.clients.findRole({ id: internalId, roleName: params.roleName })
      if (!role) {
        set.status = 404
        return { error: `Role '${params.roleName}' not found on client '${params.clientId}'` }
      }

      await admin.clients.delRole({ id: internalId, roleName: params.roleName })

      logger.admin.info('Deleted client role', { clientId: params.clientId, role: params.roleName })

      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: ClientRoleParams,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Delete Client Role',
      description: 'Delete a role from a specific Keycloak client',
      tags: ['roles']
    }
  })
