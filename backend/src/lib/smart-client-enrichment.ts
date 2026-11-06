// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { toTokenEndpointAuthMethod } from './auth-method-mapping'
import { logger } from './logger'
import { audiencesOf } from './audience-mapper'
import { getAttr, getListAttr } from './keycloak-component-config'
import { maskClientSecret } from './secret-mask'
import {
  KEYCLOAK_BUILTIN_DEFAULT_SCOPES,
  STANDARD_OIDC_DEFAULT_SCOPES,
  STANDARD_OIDC_OPTIONAL_SCOPES,
} from './oauth-scopes'
import type { SmartAppType } from '@/schemas'
import { isExchangeResourceServer } from './resource-server-exchange'
import { isGrantablePermission, parseResourceScope } from './smart-scope-grants'
import { appStateFields } from './app-state/registration'

/** Client attribute naming the brokered identity provider an app's users sign in with. */
export const PREFERRED_IDP_ATTRIBUTE = 'preferred_identity_provider'

const APP_TYPES = ['standalone-app', 'ehr-launch', 'backend-service', 'agent'] as const
const SERVER_ACCESS_TYPES = ['all-servers', 'selected-servers', 'user-person-servers'] as const

export type ServerAccessType = (typeof SERVER_ACCESS_TYPES)[number]

/** Which FHIR servers a client may reach, from its `server_access_type` and `allowed_server_ids` attributes. */
export interface ServerAccess {
  type: ServerAccessType | null
  allowedServerIds: string[]
}

/** Who may sign in to a client: `allowed_fhir_user_types` and `required_roles`; empty lists restrict nobody. */
export interface UserRestrictions {
  allowedFhirUserTypes: string[]
  requiredRoles: string[]
}

/** SMART scopes that are valid but don't match the resource-level regex */
export const SMART_LAUNCH_SCOPES = [
  'openid', 'profile', 'email', 'fhirUser',
  'launch', 'launch/patient', 'launch/encounter',
  'offline_access', 'online_access',
]

/** SMART scope pattern: context/Resource.permissions, v2 permissions an in-order subset of `cruds` */
export const SMART_SCOPE_PATTERN = /^(patient|user|system|agent)\/([\w*]+)\.((?=[cruds])c?r?u?d?s?|\*|read|write)$/

/** Returns true if the name is a recognised SMART scope (launch-level OR resource-level) */
export function isSMARTScope(name: string): boolean {
  if (SMART_LAUNCH_SCOPES.includes(name)) return true
  const parsed = parseResourceScope(name)
  return parsed !== null && isGrantablePermission(parsed.permissions)
}

/** `patient_facing` as a boolean; anything but 'true'/'false' (including an admin's '') means passthrough. */
export function parsePatientFacing(
  attrs: Record<string, string | string[]> | undefined,
): boolean | undefined {
  const raw = getAttr(attrs, 'patient_facing')
  return raw === 'true' ? true : raw === 'false' ? false : undefined
}

export function parseServerAccess(attrs: Record<string, string | string[]> | undefined): ServerAccess {
  const raw = getAttr(attrs, 'server_access_type')
  return {
    type: SERVER_ACCESS_TYPES.find((type) => type === raw) ?? null,
    allowedServerIds: getListAttr(attrs, 'allowed_server_ids'),
  }
}

export function parseUserRestrictions(attrs: Record<string, string | string[]> | undefined): UserRestrictions {
  return {
    allowedFhirUserTypes: getListAttr(attrs, 'allowed_fhir_user_types'),
    requiredRoles: getListAttr(attrs, 'required_roles'),
  }
}

/** A client's assigned default and optional scope names. */
export async function fetchClientScopeNames(
  admin: KcAdminClient,
  clientInternalId: string,
): Promise<{ defaultScopeNames: string[]; optionalScopeNames: string[] }> {
  const [defaultScopes, optionalScopes] = await Promise.all([
    admin.clients.listDefaultClientScopes({ id: clientInternalId }),
    admin.clients.listOptionalClientScopes({ id: clientInternalId }),
  ])

  return {
    defaultScopeNames: defaultScopes.flatMap(({ name }) => (name ? [name] : [])),
    optionalScopeNames: optionalScopes.flatMap(({ name }) => (name ? [name] : [])),
  }
}

/** A Keycloak client as the admin API's SmartAppType. */
export async function enrichClient(
  admin: KcAdminClient,
  client: ClientRepresentation,
): Promise<SmartAppType> {
  const fullClient = client.id ? await admin.clients.findOne({ id: client.id }) : undefined
  if (!fullClient?.id) throw new Error(`Client ${client.clientId} not found`)

  const { defaultScopeNames, optionalScopeNames } = await fetchClientScopeNames(admin, fullClient.id)

  const clientType = fullClient.attributes?.['client_type']
  const appType = Array.isArray(clientType) ? clientType[0] : clientType
  const hasOfflineAccess = optionalScopeNames.includes('offline_access')
  const serverAccess = parseServerAccess(fullClient.attributes)

  return {
    ...maskClientSecret(fullClient),
    defaultClientScopes: defaultScopeNames,
    optionalClientScopes: optionalScopeNames,
    appType: APP_TYPES.find((type) => type === appType) ?? (fullClient.serviceAccountsEnabled ? 'backend-service' : 'standalone-app'),
    clientType: fullClient.serviceAccountsEnabled ? 'backend-service' : (fullClient.publicClient ? 'public' : 'confidential'),
    tokenEndpointAuthMethod: toTokenEndpointAuthMethod(fullClient),

    launchUrl: getAttr(fullClient.attributes, 'launch_url'),
    homeUrl: fullClient.baseUrl || undefined,
    logoUri: getAttr(fullClient.attributes, 'logo_uri'),
    tosUri: getAttr(fullClient.attributes, 'tos_uri'),
    policyUri: getAttr(fullClient.attributes, 'policy_uri'),
    preferredIdentityProvider: getAttr(fullClient.attributes, PREFERRED_IDP_ATTRIBUTE) || undefined,
    contacts: getAttr(fullClient.attributes, 'contacts') === undefined ? undefined : getListAttr(fullClient.attributes, 'contacts'),

    serverAccessType: serverAccess.type ?? undefined,
    allowedServerIds: getAttr(fullClient.attributes, 'allowed_server_ids') === undefined ? undefined : serverAccess.allowedServerIds,

    organizationIds: getListAttr(fullClient.attributes, 'organization_ids'),

    scopeSetId: getAttr(fullClient.attributes, 'scope_set_id'),

    requirePkce: getAttr(fullClient.attributes, 'pkce.code.challenge.method')?.includes('S256'),
    allowOfflineAccess: hasOfflineAccess,

    tokenExchangeEnabled: getAttr(fullClient.attributes, 'standard.token.exchange.enabled') === 'true',
    resourceServer: isExchangeResourceServer(fullClient),
    accessTokenLifespan: getAttr(fullClient.attributes, 'access.token.lifespan') ? Number(getAttr(fullClient.attributes, 'access.token.lifespan')) : undefined,

    audienceClients: audiencesOf(fullClient.protocolMappers),

    ...parseUserRestrictions(fullClient.attributes),

    patientFacing: parsePatientFacing(fullClient.attributes),

    consentRequired: fullClient.consentRequired ?? false,
    fullScopeAllowed: fullClient.fullScopeAllowed ?? true,

    clientSessionIdleTimeout: getAttr(fullClient.attributes, 'client.session.idle.timeout') ? Number(getAttr(fullClient.attributes, 'client.session.idle.timeout')) : undefined,
    clientSessionMaxLifespan: getAttr(fullClient.attributes, 'client.session.max.lifespan') ? Number(getAttr(fullClient.attributes, 'client.session.max.lifespan')) : undefined,

    backchannelLogoutUrl: getAttr(fullClient.attributes, 'backchannel.logout.url') || undefined,
    frontChannelLogoutUrl: getAttr(fullClient.attributes, 'frontchannel.logout.url') || undefined,

    ...appStateFields(fullClient.attributes),
  }
}

/** RFC 8707 scope whose audience mappers let Keycloak bind a requested `resource` into `aud`; without it exchanges fail invalid_target. */
export const RESOURCE_INDICATORS_SCOPE = 'resource-indicators'

/** Idempotent; warns and returns when the realm lacks the scope. */
export async function assignResourceIndicatorsScope(
  admin: KcAdminClient,
  clientInternalId: string,
  clientId: string,
  allClientScopes?: { id?: string; name?: string }[],
): Promise<void> {
  try {
    const scopes = allClientScopes ?? await admin.clientScopes.find()
    const scope = scopes.find(s => s.name === RESOURCE_INDICATORS_SCOPE)
    if (!scope?.id) {
      logger.admin.warn(
        'resource-indicators client scope missing from realm — token audience binding will fail for this client',
        { clientId },
      )
      return
    }
    await admin.clients.addDefaultClientScope({ id: clientInternalId, clientScopeId: scope.id })
    logger.admin.debug('Assigned resource-indicators default scope to client', { clientId })
  } catch (error) {
    logger.admin.warn('Failed to assign resource-indicators scope to client', { clientId, error })
  }
}

/** Attach the baseline OIDC scopes unconditionally; each attachment is best-effort, since the client already exists. */
export async function assignStandardOidcScopes(
  admin: KcAdminClient,
  clientInternalId: string,
  clientId: string,
  allClientScopes?: { id?: string; name?: string }[],
): Promise<void> {
  let scopes: { id?: string; name?: string }[]
  try {
    scopes = allClientScopes ?? await admin.clientScopes.find()
  } catch (error) {
    logger.admin.warn('Could not read realm client scopes; client left without baseline scopes', { clientId, error })
    return
  }

  await addClientScopesByName(
    admin,
    clientInternalId,
    clientId,
    [...KEYCLOAK_BUILTIN_DEFAULT_SCOPES, ...STANDARD_OIDC_DEFAULT_SCOPES],
    scopes,
    'default',
  )
  await addClientScopesByName(
    admin,
    clientInternalId,
    clientId,
    STANDARD_OIDC_OPTIONAL_SCOPES,
    scopes,
    'optional',
  )
}

/** Resolve each name against the realm and attach it; an unknown or rejected name costs only itself. */
async function addClientScopesByName(
  admin: KcAdminClient,
  clientInternalId: string,
  clientId: string,
  names: readonly string[],
  allClientScopes: { id?: string; name?: string }[],
  kind: 'default' | 'optional',
): Promise<void> {
  for (const name of names) {
    const scope = allClientScopes.find(s => s.name === name)
    if (!scope?.id) {
      logger.admin.debug('Scope not present in realm, skipping', { clientId, name, kind })
      continue
    }
    try {
      if (kind === 'default') {
        await admin.clients.addDefaultClientScope({ id: clientInternalId, clientScopeId: scope.id })
      } else {
        await admin.clients.addOptionalClientScope({ id: clientInternalId, clientScopeId: scope.id })
      }
      logger.admin.debug('Assigned scope to client', { clientId, name, kind })
    } catch (error) {
      logger.admin.warn('Failed to assign scope to client', { clientId, name, kind, error })
    }
  }
}

/** Create any missing SMART scopes, resource-level and launch-level alike. */
export async function ensureScopesExist(
  admin: { clientScopes: Pick<KcAdminClient['clientScopes'], 'create'> },
  scopeNames: string[],
  existingScopes: { id?: string; name?: string }[],
): Promise<{ id?: string; name?: string }[]> {
  const existingNames = new Set(existingScopes.map(s => s.name))
  const updatedScopes = [...existingScopes]

  for (const name of scopeNames) {
    if (existingNames.has(name)) continue
    if (!isSMARTScope(name)) continue

    try {
      const created = await admin.clientScopes.create({
        name,
        description: `SMART scope: ${name}`,
        protocol: 'openid-connect',
        attributes: {
          'include.in.token.scope': 'true',
          'display.on.consent.screen': 'true',
          'consent.screen.text': name,
        },
      })
      updatedScopes.push({ id: created.id, name })
      existingNames.add(name)
      logger.admin.info('Auto-created missing SMART scope', { name, id: created.id })
    } catch (err) {
      logger.admin.warn('Failed to auto-create SMART scope', { name, error: err })
    }
  }

  return updatedScopes
}

/** Replace a client's default and/or optional scopes; callers re-attach resource-indicators afterwards. */
export async function replaceClientScopes(
  admin: KcAdminClient,
  clientInternalId: string,
  clientId: string,
  allClientScopes: { id?: string; name?: string }[],
  defaultScopes?: string[],
  optionalScopes?: string[],
): Promise<void> {
  if (defaultScopes) {
    const existingDefaults = await admin.clients.listDefaultClientScopes({ id: clientInternalId })
    for (const scope of existingDefaults) {
      if (!scope.id) continue
      try {
        await admin.clients.delDefaultClientScope({ id: clientInternalId, clientScopeId: scope.id })
      } catch (error) {
        logger.admin.warn('Failed to remove existing default scope', { clientId, scopeId: scope.id, scopeName: scope.name, error })
      }
    }
    await addClientScopesByName(admin, clientInternalId, clientId, defaultScopes, allClientScopes, 'default')
  }

  if (optionalScopes) {
    const existingOptionals = await admin.clients.listOptionalClientScopes({ id: clientInternalId })
    for (const scope of existingOptionals) {
      if (!scope.id) continue
      try {
        await admin.clients.delOptionalClientScope({ id: clientInternalId, clientScopeId: scope.id })
      } catch (error) {
        logger.admin.warn('Failed to remove existing optional scope', { clientId, scopeId: scope.id, scopeName: scope.name, error })
      }
    }
    await addClientScopesByName(admin, clientInternalId, clientId, optionalScopes, allClientScopes, 'optional')
  }
}
