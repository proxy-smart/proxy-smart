// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * What happens to a client after its representation is written: scopes, SMART
 * protocol mappers, audience mappers, client roles and JWKS.
 *
 * Create and update each did all of this inline, so the audience-mapper config
 * and the scope/mapper sequence existed twice, in two spellings.
 *
 * Every step is non-fatal on its own: a client that exists with one scope
 * unassigned is fixable from the admin UI, and failing the whole request would
 * leave a half-created client behind instead.
 */

import * as crypto from 'crypto'
import { logger } from '@/lib/logger'
import { isAudienceMapper, resolvedAudienceMapper } from '@/lib/audience-mapper'
import { ensureScopeMappers, SMART_SCOPE_MAPPERS } from '@/lib/smart-scope-mappers'
import { ensureScopesExist, replaceClientScopes, assignResourceIndicatorsScope } from '@/lib/smart-client-enrichment'
import type KcAdminClient from '@keycloak/keycloak-admin-client'

type ClientScope = { id?: string; name?: string }

interface ClientRef {
  /** Keycloak's internal UUID. */
  id: string
  /** The OAuth client_id, for logs. */
  clientId: string
}

const asError = (error: unknown): string => error instanceof Error ? error.message : String(error)

// ─── JWKS ────────────────────────────────────────────────────────

/**
 * Register JWKS for a client in Keycloak.
 * Accepts either an inline JWKS JSON string or a PEM public key (which gets converted to JWK).
 * Does NOT override clientAuthenticatorType — caller is responsible for setting that.
 */
export async function registerJwksForClient(
  admin: KcAdminClient,
  clientInternalId: string,
  options: { jwksString?: string; publicKeyPem?: string; signingAlg?: string }
): Promise<void> {
  let jwksJson: string
  let detectedAlg: string | undefined

  if (options.jwksString) {
    // Use inline JWKS directly, and try to detect alg from the first key
    jwksJson = options.jwksString
    try {
      const parsed = JSON.parse(options.jwksString) as { keys?: { alg?: string }[] }
      detectedAlg = parsed.keys?.[0]?.alg
    } catch { /* ignore parse errors — will use fallback */ }
  } else if (options.publicKeyPem) {
    // Convert PEM → JWK using Node crypto
    const alg = options.signingAlg || 'RS384'
    const keyObject = crypto.createPublicKey(options.publicKeyPem)
    const jwk = keyObject.export({ format: 'jwk' }) as Record<string, unknown>
    jwksJson = JSON.stringify({
      keys: [{ ...jwk, use: 'sig', alg, kid: crypto.randomUUID() }]
    })
    detectedAlg = alg
  } else {
    throw new Error('Either jwksString or publicKeyPem must be provided')
  }

  // Priority: explicit signingAlg > detected from JWKS > fallback RS384
  const alg = options.signingAlg || detectedAlg || 'RS384'

  logger.admin.debug('Registering JWKS for client', { clientInternalId, alg })

  await admin.clients.update({ id: clientInternalId }, {
    attributes: {
      'use.jwks.string': 'true',
      'jwks.string': jwksJson,
      'token.endpoint.auth.signing.alg': alg,
    }
  })

  logger.admin.debug('JWKS registered for client', { clientInternalId })
}

// ─── Scopes ──────────────────────────────────────────────────────

/** Attach the SMART protocol mappers the named scopes require. */
async function provisionSmartMappers(
  admin: KcAdminClient,
  allClientScopes: ClientScope[],
  scopeNames: string[],
): Promise<void> {
  for (const scopeName of scopeNames) {
    if (!SMART_SCOPE_MAPPERS[scopeName]) continue
    const scope = allClientScopes.find(s => s.name === scopeName)
    if (scope?.id) {
      await ensureScopeMappers(admin, scope.id, scopeName)
    }
  }
}

const scopeIdsFor = (names: string[], all: ClientScope[]): string[] =>
  names
    .map(name => all.find(scope => scope.name === name)?.id)
    .filter((id): id is string => Boolean(id))

/**
 * Assign a new client's scopes, creating any SMART scope that does not exist
 * yet (e.g. user/Claim.cud).
 */
export async function assignScopesToNewClient(
  admin: KcAdminClient,
  client: ClientRef,
  scopes: { defaultScopes: string[]; optionalScopes: string[] },
): Promise<void> {
  try {
    let allClientScopes: ClientScope[] = await admin.clientScopes.find()
    allClientScopes = await ensureScopesExist(
      admin,
      [...scopes.defaultScopes, ...scopes.optionalScopes],
      allClientScopes,
    )

    for (const scopeId of scopeIdsFor(scopes.defaultScopes, allClientScopes)) {
      try {
        await admin.clients.addDefaultClientScope({ id: client.id, clientScopeId: scopeId })
      } catch (error) {
        logger.admin.warn('Failed to assign default scope to client', { clientId: client.clientId, scopeId, error })
      }
    }

    for (const scopeId of scopeIdsFor(scopes.optionalScopes, allClientScopes)) {
      try {
        await admin.clients.addOptionalClientScope({ id: client.id, clientScopeId: scopeId })
      } catch (error) {
        logger.admin.warn('Failed to assign optional scope to client', { clientId: client.clientId, scopeId, error })
      }
    }

    await provisionSmartMappers(admin, allClientScopes, [...scopes.defaultScopes, ...scopes.optionalScopes])

    // RFC 8707: every SMART client needs the resource-indicators default scope
    // so its access-token aud binds to the FHIR/MCP resource server (otherwise
    // token exchange with a resource param → invalid_target).
    await assignResourceIndicatorsScope(admin, client.id, client.clientId, allClientScopes)

    logger.admin.debug('Scopes assigned to client', {
      clientId: client.clientId,
      defaultScopes: scopes.defaultScopes,
      optionalScopes: scopes.optionalScopes,
    })
  } catch (error) {
    logger.admin.warn('Failed to assign scopes to client', { clientId: client.clientId, error })
  }
}

/** Replace an existing client's scope assignment with the requested set. */
export async function replaceScopesForClient(
  admin: KcAdminClient,
  client: ClientRef,
  scopes: { defaultScopes?: string[]; optionalScopes?: string[] },
): Promise<void> {
  try {
    const requested = [...(scopes.defaultScopes || []), ...(scopes.optionalScopes || [])]
    let allClientScopes: ClientScope[] = await admin.clientScopes.find()
    allClientScopes = await ensureScopesExist(admin, requested, allClientScopes)

    await replaceClientScopes(
      admin,
      client.id,
      client.clientId,
      allClientScopes,
      scopes.defaultScopes,
      scopes.optionalScopes,
    )

    // replaceClientScopes wipes existing default scopes before re-adding the
    // requested set, so re-attach resource-indicators (RFC 8707) to keep the
    // client's token-audience binding intact after an update.
    await assignResourceIndicatorsScope(admin, client.id, client.clientId, allClientScopes)

    await provisionSmartMappers(admin, allClientScopes, requested)

    logger.admin.debug('Scopes updated for client', {
      clientId: client.clientId,
      defaultScopes: scopes.defaultScopes,
      optionalScopes: scopes.optionalScopes,
    })
  } catch (error) {
    logger.admin.warn('Failed to update scopes for client', { clientId: client.clientId, error })
  }
}

/** Offline access is the refresh-token grant, and Keycloak models it as a scope. */
export async function enableOfflineAccess(admin: KcAdminClient, client: ClientRef): Promise<void> {
  try {
    const allClientScopes = await admin.clientScopes.find()
    const offlineScope = allClientScopes.find(scope => scope.name === 'offline_access')
    if (offlineScope?.id) {
      await admin.clients.addOptionalClientScope({ id: client.id, clientScopeId: offlineScope.id })
      logger.admin.debug('Offline access enabled for client', { clientId: client.clientId })
    }
  } catch (error) {
    logger.admin.warn('Failed to enable offline access', { clientId: client.clientId, error })
  }
}

// ─── Audience mappers ────────────────────────────────────────────

const appAudienceMapper = (admin: KcAdminClient, audience: string) =>
  resolvedAudienceMapper(admin, audience, `audience-${audience}`)

/** Add audience mappers to a client that has none yet. */
export async function addAudienceMappers(
  admin: KcAdminClient,
  client: ClientRef,
  targets: string[],
): Promise<void> {
  for (const targetClientId of targets) {
    try {
      await admin.clients.addProtocolMapper({ id: client.id }, await appAudienceMapper(admin, targetClientId))
      logger.admin.debug('Audience mapper added', { clientId: client.clientId, targetClientId })
    } catch (error) {
      logger.admin.warn('Failed to add audience mapper', { clientId: client.clientId, targetClientId, error })
    }
  }
}

/** Swap a client's audience mappers for exactly the requested set. */
export async function replaceAudienceMappers(
  admin: KcAdminClient,
  client: ClientRef,
  targets: string[],
): Promise<void> {
  try {
    const existingMappers = await admin.clients.listProtocolMappers({ id: client.id })
    for (const mapper of existingMappers.filter(isAudienceMapper)) {
      if (mapper.id) {
        await admin.clients.delProtocolMapper({ id: client.id, mapperId: mapper.id })
      }
    }

    for (const targetClientId of targets) {
      await admin.clients.addProtocolMapper({ id: client.id }, await appAudienceMapper(admin, targetClientId))
    }
    logger.admin.debug('Audience mappers updated', { clientId: client.clientId, audienceClients: targets })
  } catch (error) {
    logger.admin.warn('Failed to update audience mappers', { clientId: client.clientId, error })
  }
}

// ─── Client roles ────────────────────────────────────────────────

/** Create the client roles a new app declares as required. */
export async function createClientRoles(
  admin: KcAdminClient,
  client: ClientRef,
  roleNames: string[],
): Promise<void> {
  for (const roleName of roleNames) {
    try {
      await admin.clients.createRole({
        id: client.id,
        name: roleName,
        description: `Required role for ${client.clientId}`,
      })
      logger.admin.debug('Created client role on new app', { clientId: client.clientId, role: roleName })
    } catch (error) {
      logger.admin.warn('Failed to create client role', { clientId: client.clientId, role: roleName, error: asError(error) })
    }
  }
}

/** Make a client's roles match the requested set exactly, adding and removing. */
export async function syncClientRoles(
  admin: KcAdminClient,
  client: ClientRef,
  roleNames: string[],
): Promise<void> {
  try {
    const existingRoles = await admin.clients.listRoles({ id: client.id })
    const existingNames = new Set(existingRoles.map(role => role.name))
    const desiredNames = new Set(roleNames)

    for (const roleName of desiredNames) {
      if (!existingNames.has(roleName)) {
        await admin.clients.createRole({
          id: client.id,
          name: roleName,
          description: `Required role for ${client.clientId}`,
        })
        logger.admin.debug('Created client role', { clientId: client.clientId, role: roleName })
      }
    }

    for (const role of existingRoles) {
      if (role.name && !desiredNames.has(role.name)) {
        await admin.clients.delRole({ id: client.id, roleName: role.name })
        logger.admin.debug('Deleted client role', { clientId: client.clientId, role: role.name })
      }
    }
  } catch (error) {
    logger.admin.warn('Failed to sync client roles', { clientId: client.clientId, error })
  }
}
