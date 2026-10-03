// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { toTokenEndpointAuthMethod } from './auth-method-mapping'
import { logger } from './logger'
import { audiencesOf } from './audience-mapper'
import { getAttr } from './keycloak-component-config'
import {
  KEYCLOAK_BUILTIN_DEFAULT_SCOPES,
  STANDARD_OIDC_DEFAULT_SCOPES,
  STANDARD_OIDC_OPTIONAL_SCOPES,
} from './oauth-scopes'
import type { SmartAppType } from '@/schemas'

/** Valid literal values for schema-validated enums */
const VALID_APP_TYPES = new Set(['standalone-app', 'ehr-launch', 'backend-service', 'agent'])
const VALID_SERVER_ACCESS_TYPES = new Set(['all-servers', 'selected-servers', 'user-person-servers'])

/** SMART scopes that are valid but don't match the resource-level regex */
export const SMART_LAUNCH_SCOPES = [
  'openid', 'profile', 'email', 'fhirUser',
  'launch', 'launch/patient', 'launch/encounter',
  'offline_access', 'online_access',
]

/** SMART v2 scope pattern: context/Resource.permissions */
export const SMART_SCOPE_PATTERN = /^(patient|user|system|agent)\/([\w*]+)\.(([cruds]+)|\*|read|write)$/

/** Returns true if the name is a recognised SMART scope (launch-level OR resource-level) */
export function isSMARTScope(name: string): boolean {
  return SMART_SCOPE_PATTERN.test(name) || SMART_LAUNCH_SCOPES.includes(name)
}

/**
 * Read `patient_facing` off a Keycloak client. Client attributes are plain strings, user
 * attributes are arrays; `getAttr` is what knows the difference. Anything else is `undefined`,
 * which means passthrough — including the empty string an admin clear writes.
 *
 * One reader, beside `getAttr`. A second inlined copy is how the original bug survived:
 * the cache indexed the raw value (`'true'[0]` is `'t'`), so every client fell through.
 */
export function parsePatientFacing(
  attrs: Record<string, string | string[]> | undefined,
): boolean | undefined {
  const raw = getAttr(attrs, 'patient_facing')
  return raw === 'true' ? true : raw === 'false' ? false : undefined
}

/**
 * Fetch the actual scope names assigned to a client via the Keycloak
 * `default-client-scopes` / `optional-client-scopes` sub-resources.
 *
 * These endpoints return objects with `{ id, name }`, which is the only
 * reliable way to get scope IDs — the top-level `clients.findOne()`
 * representation returns scope **names** in `defaultClientScopes`, not IDs.
 */
export async function fetchClientScopeNames(
  admin: KcAdminClient,
  clientInternalId: string,
): Promise<{ defaultScopeNames: string[]; optionalScopeNames: string[] }> {
  const [defaultScopes, optionalScopes] = await Promise.all([
    admin.clients.listDefaultClientScopes({ id: clientInternalId }),
    admin.clients.listOptionalClientScopes({ id: clientInternalId }),
  ])

  return {
    defaultScopeNames: defaultScopes.map(s => s.name!).filter(Boolean),
    optionalScopeNames: optionalScopes.map(s => s.name!).filter(Boolean),
  }
}

/**
 * Enrich a raw Keycloak ClientRepresentation into a SmartAppType for the API.
 *
 * Fetches scope names via the list sub-resources and maps every Keycloak
 * attribute to the corresponding API field.
 */
export async function enrichClient(
  admin: KcAdminClient,
  client: ClientRepresentation,
  options: { maskSecret?: boolean } = {},
): Promise<SmartAppType> {
  const fullClient = await admin.clients.findOne({ id: client.id! })
  if (!fullClient) throw new Error(`Client ${client.clientId} not found`)

  const { defaultScopeNames, optionalScopeNames } = await fetchClientScopeNames(admin, fullClient.id!)

  const clientType = fullClient.attributes?.['client_type']
  const appType = Array.isArray(clientType) ? clientType[0] : clientType
  const hasOfflineAccess = optionalScopeNames.includes('offline_access')

  return {
    ...fullClient,
    defaultClientScopes: defaultScopeNames,
    optionalClientScopes: optionalScopeNames,
    appType: (VALID_APP_TYPES.has(appType!) ? appType : undefined) || (fullClient.serviceAccountsEnabled ? 'backend-service' : 'standalone-app'),
    clientType: (fullClient.serviceAccountsEnabled ? 'backend-service' : (fullClient.publicClient ? 'public' : 'confidential')) as 'backend-service' | 'public' | 'confidential',
    tokenEndpointAuthMethod: toTokenEndpointAuthMethod(fullClient),

    // Client secret
    ...(fullClient.secret && { secret: options.maskSecret !== false ? '**********' : fullClient.secret }),

    // Metadata fields from attributes
    launchUrl: getAttr(fullClient.attributes, 'launch_url'),
    homeUrl: fullClient.baseUrl || undefined,
    logoUri: getAttr(fullClient.attributes, 'logo_uri'),
    tosUri: getAttr(fullClient.attributes, 'tos_uri'),
    policyUri: getAttr(fullClient.attributes, 'policy_uri'),
    contacts: getAttr(fullClient.attributes, 'contacts')?.split(',').filter(Boolean),

    // Server access control
    serverAccessType: (VALID_SERVER_ACCESS_TYPES.has(getAttr(fullClient.attributes, 'server_access_type')!) ? getAttr(fullClient.attributes, 'server_access_type') : undefined) as 'all-servers' | 'selected-servers' | 'user-person-servers' | undefined,
    allowedServerIds: getAttr(fullClient.attributes, 'allowed_server_ids')?.split(',').filter(Boolean),

    // Organization assignment
    organizationIds: getAttr(fullClient.attributes, 'organization_ids')?.split(',').filter(Boolean) || [],

    // Scope set reference
    scopeSetId: getAttr(fullClient.attributes, 'scope_set_id'),

    // PKCE and offline access
    requirePkce: getAttr(fullClient.attributes, 'pkce.code.challenge.method')?.includes('S256'),
    allowOfflineAccess: hasOfflineAccess,

    // Token exchange & access token lifespan
    tokenExchangeEnabled: getAttr(fullClient.attributes, 'standard.token.exchange.enabled') === 'true',
    accessTokenLifespan: getAttr(fullClient.attributes, 'access.token.lifespan') ? Number(getAttr(fullClient.attributes, 'access.token.lifespan')) : undefined,

    // Audience mappers
    audienceClients: audiencesOf(fullClient.protocolMappers),

    // User type & role restrictions
    allowedFhirUserTypes: getAttr(fullClient.attributes, 'allowed_fhir_user_types')?.split(',').filter(Boolean) || [],
    requiredRoles: getAttr(fullClient.attributes, 'required_roles')?.split(',').filter(Boolean) || [],

    // fhirUser resolution
    patientFacing: parsePatientFacing(fullClient.attributes),

    // Consent & scope settings
    consentRequired: fullClient.consentRequired ?? false,
    fullScopeAllowed: fullClient.fullScopeAllowed ?? true,

    // Session timeout settings
    clientSessionIdleTimeout: getAttr(fullClient.attributes, 'client.session.idle.timeout') ? Number(getAttr(fullClient.attributes, 'client.session.idle.timeout')) : undefined,
    clientSessionMaxLifespan: getAttr(fullClient.attributes, 'client.session.max.lifespan') ? Number(getAttr(fullClient.attributes, 'client.session.max.lifespan')) : undefined,

    // Logout settings
    backchannelLogoutUrl: getAttr(fullClient.attributes, 'backchannel.logout.url') || undefined,
    frontChannelLogoutUrl: getAttr(fullClient.attributes, 'frontchannel.logout.url') || undefined,
  } as SmartAppType
}

/**
 * The RFC 8707 resource-indicators client scope.
 *
 * Attaching it as a DEFAULT scope pre-populates the access-token `aud` with the
 * resource-server client ids (fhir-resource-server / mcp-resource-server), which
 * is the ONLY way Keycloak's resource-indicators post-processor can bind a
 * requested `resource` into `aud`. Without it, any token exchange that carries a
 * `resource` param (every SMART launch through this proxy does — it forwards the
 * session `aud` as `resource`) fails with `invalid_target`.
 *
 * The scope + its audience mappers + the resource clients are defined in
 * keycloak/realm-export.json and reconciled onto deployments by the deploy
 * scripts. This constant + {@link assignResourceIndicatorsScope} attach it to
 * every client the backend provisions at runtime (DCR + admin API), so no
 * hardcoded per-client list is needed.
 */
export const RESOURCE_INDICATORS_SCOPE = 'resource-indicators'

/**
 * Attach the {@link RESOURCE_INDICATORS_SCOPE} to a client as a DEFAULT scope.
 * Idempotent (Keycloak's addDefaultClientScope is a PUT), so it is safe to call
 * after scope replacement / on every update. No-op with a warning if the scope
 * is absent from the realm (deployment misconfiguration).
 */
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

/**
 * Attach the baseline scopes every client this deployment provisions needs, whatever it asked
 * for at registration.
 *
 * UNCONDITIONAL ON PURPOSE. Keycloak rejects an authorize request naming a scope the client
 * does not hold — `invalid_scope`, before the login page — and the MCP 401 challenge tells
 * clients to name {@link STANDARD_OIDC_DEFAULT_SCOPES}. Deriving the grant from the optional
 * `scope` field of an RFC 7591 registration request meant a client that omitted it (legitimate,
 * and correct when you plan to read the scopes out of the resource metadata afterwards) could
 * not authorize at all.
 *
 * Keycloak's admin API cannot do this at create time: `clients.create` honours only the realm's
 * DEFAULT client scopes and silently ignores a `defaultClientScopes` array in the payload, so
 * every scope has to be attached afterwards through the explicit endpoints used here.
 *
 * Each attachment is independent and best-effort: one scope missing from the realm must not
 * cost the client the others. Absences are warned about rather than thrown, because the client
 * already exists by this point and failing the registration would leave an orphan behind.
 */
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

/**
 * Attach client scopes to a client by NAME, resolving each against the realm's scope list.
 *
 * The shared half of every scope assignment in this file: name → id → add, one at a time so a
 * scope missing from the realm or rejected by Keycloak costs only itself. `assignStandardOidcScopes`
 * and {@link replaceClientScopes} differ in what they attach and whether they clear first, not
 * in how a name becomes an attachment, so that part lives here once.
 *
 * A name with no matching realm scope is logged and skipped rather than treated as an error:
 * `openid` is implicit in some realms, and SMART scopes may legitimately not exist yet.
 */
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

/**
 * Auto-create missing SMART client scopes in Keycloak.
 *
 * Handles BOTH resource-level scopes (patient/Observation.read) AND
 * launch-level scopes (launch/patient, fhirUser, etc.).
 */
export async function ensureScopesExist(
  admin: KcAdminClient,
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

/**
 * Replace all default/optional client scopes on a client with new ones.
 *
 * Uses `listDefaultClientScopes` / `listOptionalClientScopes` to get proper
 * scope IDs for removal (NOT the client representation which returns names).
 */
export async function replaceClientScopes(
  admin: KcAdminClient,
  clientInternalId: string,
  clientId: string,
  allClientScopes: { id?: string; name?: string }[],
  defaultScopes?: string[],
  optionalScopes?: string[],
): Promise<void> {
  if (defaultScopes) {
    // Use the list sub-resource to get scope objects with real IDs
    const existingDefaults = await admin.clients.listDefaultClientScopes({ id: clientInternalId })
    for (const scope of existingDefaults) {
      try {
        await admin.clients.delDefaultClientScope({ id: clientInternalId, clientScopeId: scope.id! })
      } catch (error) {
        logger.admin.warn('Failed to remove existing default scope', { clientId, scopeId: scope.id, scopeName: scope.name, error })
      }
    }
    await addClientScopesByName(admin, clientInternalId, clientId, defaultScopes, allClientScopes, 'default')
  }

  if (optionalScopes) {
    const existingOptionals = await admin.clients.listOptionalClientScopes({ id: clientInternalId })
    for (const scope of existingOptionals) {
      try {
        await admin.clients.delOptionalClientScope({ id: clientInternalId, clientScopeId: scope.id! })
      } catch (error) {
        logger.admin.warn('Failed to remove existing optional scope', { clientId, scopeId: scope.id, scopeName: scope.name, error })
      }
    }
    await addClientScopesByName(admin, clientInternalId, clientId, optionalScopes, allClientScopes, 'optional')
  }
}
