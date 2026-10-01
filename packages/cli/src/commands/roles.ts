// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * `proxy-smart roles <verb>`: realm roles, and client roles under their own verbs so a
 * forgotten flag can never write the wrong kind. Client ids resolve server-side.
 */
import {
  CreateRoleRequestFromJSON,
  UpdateRoleRequestFromJSON,
  type RoleResponse,
} from '../api-client'
import { flagBool } from '../args'
import { requirePositional } from './shared'
import { dataVerb, jsonVerb, nestedListVerb, positional, verbCommand, type Target } from './verbs/core'
import { crudVerbs } from './verbs/crud'

interface ClientRoleRef {
  clientId: string
  roleName: string
}

/** Represented scopes are a descriptive label, never an access grant. */
function roleRow(role: RoleResponse) {
  return {
    name: role.name ?? '-',
    description: role.description ?? '-',
    composite: role.composite ?? false,
    technical: role.isTechnical ?? false,
    representedScopeSet: role.representedScopeSetName ?? '-',
    representedScopes: role.representedScopes?.join(',') || '-',
  }
}

const clientRole: Target<ClientRoleRef> = args => ({
  clientId: requirePositional(args, 2, 'clientId'),
  roleName: requirePositional(args, 3, 'roleName'),
})

const realmRoles = crudVerbs({
  key: 'roleName',
  list: {
    fetch: ({ api, args }) => api.roles.getAdminRoles({
      includeTechnical: flagBool(args.flags, 'include-technical') ? 'true' : undefined,
    }),
    rows: roles => roles.map(roleRow),
  },
  get: (api, roleName) => api.roles.getAdminRolesByRoleName({ roleName }),
  create: (api, data) => api.roles.postAdminRoles({ createRoleRequest: CreateRoleRequestFromJSON(data) }),
  update: (api, data, roleName) => api.roles.putAdminRolesByRoleName({
    roleName,
    updateRoleRequest: UpdateRoleRequestFromJSON(data),
  }),
  remove: (api, roleName) => api.roles.deleteAdminRolesByRoleName({ roleName }),
  confirmRemove: roleName => `Refusing to delete role "${roleName}" without --yes.`,
})

export const rolesCommand = verbCommand('roles', {
  ...realmRoles,
  'client-roles': nestedListVerb(
    'clientId',
    (api, clientId) => api.roles.getAdminRolesClientsByClientId({ clientId }),
    roleRow,
  ),
  'client-get': jsonVerb(clientRole, (api, ref) => api.roles.getAdminRolesClientsByClientIdByRoleName(ref)),
  'client-create': dataVerb(positional('clientId'), (api, data, clientId) => api.roles.postAdminRolesClientsByClientId({
    clientId,
    createRoleRequest: CreateRoleRequestFromJSON(data),
  })),
  'client-update': dataVerb(clientRole, (api, data, ref) => api.roles.putAdminRolesClientsByClientIdByRoleName({
    ...ref,
    updateRoleRequest: UpdateRoleRequestFromJSON(data),
  })),
  'client-delete': jsonVerb(
    clientRole,
    (api, ref) => api.roles.deleteAdminRolesClientsByClientIdByRoleName(ref),
    ({ clientId, roleName }) => `Refusing to delete role "${roleName}" on client "${clientId}" without --yes.`,
  ),
})
