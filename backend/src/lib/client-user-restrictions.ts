// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// A SMART app's `allowed_fhir_user_types` / `required_roles` decide who may hold its tokens.

import { getFhirUserResourceType } from '@proxy-smart/auth'
import { clientRoles, realmRoles } from './admin-roles'
import { readKeycloakClaims, tokenClientId, type ClaimSet } from './jwt-claims'
import { getClientUserRestrictions } from './smart-client-config-cache'
import { getAdminClient } from './kc-admin-factory'
import { getAttr } from './keycloak-component-config'
import type { UserRestrictions } from './smart-client-enrichment'
import { logger } from './logger'
import { optionalString } from './type-guards'

const CLINICIAN_TYPES: ReadonlySet<string> = new Set(['Practitioner', 'PractitionerRole'])

export interface UserRestrictionDeps {
  restrictions(clientId: string): Promise<UserRestrictions>
  /** The Patient (true) or Practitioner (false) a Person links to. */
  linkedIdentity(fhirUser: string, patientFacing: boolean): Promise<string | undefined>
  /** The account's fhirUser attribute, for a token whose scope left the claim out. */
  accountFhirUser?(userId: string): Promise<string | undefined>
}

export type UserRestrictionOutcome =
  | { allowed: true }
  | { allowed: false; status: 400 | 503; error: 'invalid_grant' | 'temporarily_unavailable'; description: string }

export function userRestrictionDeps(linkedIdentity: UserRestrictionDeps['linkedIdentity']): UserRestrictionDeps {
  return { restrictions: getClientUserRestrictions, linkedIdentity, accountFhirUser }
}

export function restrictsAnyone(restrictions: UserRestrictions): boolean {
  return restrictions.allowedFhirUserTypes.length > 0 || restrictions.requiredRoles.length > 0
}

async function accountFhirUser(userId: string): Promise<string | undefined> {
  const admin = await getAdminClient()
  return admin ? getAttr((await admin.users.findOne({ id: userId }))?.attributes, 'fhirUser') : undefined
}

const roleNames = (roles: readonly { name?: string }[]) => roles.flatMap((role) => (role.name ? [role.name] : []))

/** A Keycloak account as the claims a token for `clientId` would carry; null without an admin client. */
export async function accountClaims(userId: string, clientId: string): Promise<ClaimSet | null> {
  const admin = await getAdminClient()
  if (!admin) return null
  const [user, realm, clients] = await Promise.all([
    admin.users.findOne({ id: userId }),
    admin.users.listCompositeRealmRoleMappings({ id: userId }),
    admin.clients.find({ clientId, max: 1 }),
  ])
  const clientUniqueId = clients[0]?.id
  const own = clientUniqueId ? await admin.users.listCompositeClientRoleMappings({ id: userId, clientUniqueId }) : []
  const fhirUser = getAttr(user?.attributes, 'fhirUser')
  return {
    sub: userId,
    azp: clientId,
    ...(fhirUser && { fhirUser }),
    realm_access: { roles: roleNames(realm) },
    resource_access: { [clientId]: { roles: roleNames(own) } },
  }
}

const typeOf = (fhirUser: string | undefined) => (fhirUser ? getFhirUserResourceType(fhirUser) : null)

/** The account's own FHIR type, plus the types its Person links to that the client would accept. */
async function identityTypes(fhirUser: string | undefined, allowed: ReadonlySet<string>, deps: UserRestrictionDeps): Promise<Set<string>> {
  const own = typeOf(fhirUser)
  const types = new Set(own ? [own] : [])
  if (!fhirUser || own !== 'Person') return types
  const wanted = [
    ...(allowed.has('Patient') ? [true] : []),
    ...([...allowed].some((type) => CLINICIAN_TYPES.has(type)) ? [false] : []),
  ]
  for (const patientFacing of wanted) {
    const linked = typeOf(await deps.linkedIdentity(fhirUser, patientFacing))
    if (linked) types.add(linked)
  }
  return types
}

function refuse(clientId: string, description: string, detail: Record<string, unknown>): UserRestrictionOutcome {
  logger.auth.warn('Token refused: the user is not one this client admits', { clientId, ...detail })
  return { allowed: false, status: 400, error: 'invalid_grant', description }
}

/** Always enforced, on every grant that issues a user's token: a restriction an administrator configured is not a mode. */
export async function checkUserRestrictions(tokenPayload: ClaimSet, deps: UserRestrictionDeps): Promise<UserRestrictionOutcome> {
  const clientId = tokenClientId(tokenPayload)
  if (!clientId) return { allowed: true }

  let restrictions: UserRestrictions
  try {
    restrictions = await deps.restrictions(clientId)
  } catch (error) {
    logger.auth.error('Cannot read who may sign in to this client', {
      clientId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { allowed: false, status: 503, error: 'temporarily_unavailable', description: 'Who may sign in to this app cannot be verified right now.' }
  }

  const claims = readKeycloakClaims(tokenPayload)
  const held = new Set([...realmRoles(claims), ...clientRoles(claims, clientId)])
  const missingRoles = restrictions.requiredRoles.filter((role) => !held.has(role))
  if (missingRoles.length > 0) {
    return refuse(clientId, 'This account does not have the role this app requires.', { missingRoles })
  }

  if (restrictions.allowedFhirUserTypes.length === 0) return { allowed: true }
  const allowed = new Set(restrictions.allowedFhirUserTypes)
  const userId = optionalString(tokenPayload.sub)
  const fhirUser = optionalString(tokenPayload.fhirUser) ?? (userId ? await deps.accountFhirUser?.(userId) : undefined)
  const types = await identityTypes(fhirUser, allowed, deps)
  if ([...types].some((type) => allowed.has(type))) return { allowed: true }
  return refuse(
    clientId,
    `This app is only available to ${restrictions.allowedFhirUserTypes.join(' or ')} accounts.`,
    { fhirUser: fhirUser ?? '(none)', identityTypes: [...types] },
  )
}
