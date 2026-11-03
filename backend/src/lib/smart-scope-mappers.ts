// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ProtocolMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/protocolMapperRepresentation'
import { logger } from './logger'

/**
 * SMART on FHIR scope-to-protocol-mapper definitions.
 *
 * These mappers ensure Keycloak user attributes are emitted as JWT claims
 * so the proxy's token endpoint can inject SMART launch context (fhirUser)
 * into the token response.
 *
 * NOTE: patient and encounter context is now handled by the TokenContextStore
 * (session-based, per-token) rather than KC user attributes + protocol mappers.
 */

export interface SmartMapperDefinition {
  /** Protocol mapper name stored in Keycloak */
  name: string
  /** Keycloak user attribute to read */
  userAttribute: string
  /** JWT claim name emitted into the access/id token */
  claimName: string
  /** JSON type label (String, boolean, JSON, etc.) */
  jsonType: string
}

/**
 * Map from scope name → required protocol mapper(s).
 *
 * When a scope is assigned to a client, each listed mapper must exist on
 * that scope in Keycloak so the corresponding user attribute flows into
 * the issued token.
 *
 * NOTE: launch/patient and launch/encounter no longer use KC protocol mappers.
 * Patient and encounter context is stored per-token via TokenContextStore.
 */
export const SMART_SCOPE_MAPPERS: Record<string, SmartMapperDefinition[]> = {
  'fhirUser': [
    {
      name: 'fhirUser-mapper',
      userAttribute: 'fhirUser',
      claimName: 'fhirUser',
      jsonType: 'String',
    },
  ],
}

/** All scope names that have SMART-critical mappers */
export const SMART_MAPPER_SCOPES = Object.keys(SMART_SCOPE_MAPPERS)

/**
 * Build a Keycloak ProtocolMapperRepresentation from a SmartMapperDefinition.
 */
function toProtocolMapper(def: SmartMapperDefinition) {
  return {
    name: def.name,
    protocol: 'openid-connect',
    protocolMapper: 'oidc-usermodel-attribute-mapper',
    consentRequired: false,
    config: {
      'userinfo.token.claim': 'true',
      'user.attribute': def.userAttribute,
      'id.token.claim': 'true',
      'access.token.claim': 'true',
      'claim.name': def.claimName,
      'jsonType.label': def.jsonType,
    },
  }
}

/**
 * Ensure all required SMART protocol mappers exist on the given scope.
 *
 * Idempotent: skips mappers that already exist (matched by name).
 *
 * @returns number of mappers that were actually created (0 if all existed)
 */
export async function ensureScopeMappers(
  admin: KcAdminClient,
  scopeId: string,
  scopeName: string,
): Promise<number> {
  const requiredMappers = SMART_SCOPE_MAPPERS[scopeName]
  if (!requiredMappers || requiredMappers.length === 0) return 0
  return ensureMappersOnScope(admin, scopeId, scopeName, requiredMappers.map(toProtocolMapper))
}

/** A Keycloak protocol mapper as the admin API accepts it. */
export interface ProtocolMapper {
  name: string
  protocol: string
  protocolMapper: string
  consentRequired?: boolean
  config: Record<string, string>
}

/**
 * Add whichever of `required` are missing from a scope, matched by name.
 *
 * Idempotent, and per-mapper non-fatal. Shared with the RFC 8707 audience mappers
 * in kc-system-provisioning, which are a different mapper type but need the same
 * "a scope that exists is not necessarily a scope that works" reconciliation.
 *
 * @returns how many were actually created
 */
export async function ensureMappersOnScope(
  admin: KcAdminClient,
  scopeId: string,
  scopeName: string,
  required: ProtocolMapper[],
): Promise<number> {
  let existingMappers: { name?: string }[] = []
  try {
    existingMappers = await admin.clientScopes.listProtocolMappers({ id: scopeId })
  } catch {
    // Scope may have no mappers yet — that's fine
  }

  const existingNames = new Set(existingMappers.map((m) => m.name))
  let created = 0

  for (const mapper of required) {
    if (existingNames.has(mapper.name)) {
      logger.admin.debug('Mapper already exists, skipping', { scopeName, mapper: mapper.name })
      continue
    }

    try {
      await admin.clientScopes.addProtocolMapper({ id: scopeId }, mapper)
      logger.admin.info('Auto-provisioned protocol mapper', { scopeName, mapper: mapper.name })
      created++
    } catch (error) {
      logger.admin.warn('Failed to auto-provision mapper', {
        scopeName,
        mapper: mapper.name,
        error: error instanceof Error ? error.message : error,
      })
    }
  }

  return created
}

/**
 * Scan all SMART-related scopes and ensure their required mappers exist.
 *
 * Call on startup or from an admin "fix mappers" action.
 *
 * @returns summary of what was done
 */
export async function ensureAllSmartMappers(
  admin: KcAdminClient,
): Promise<{ scanned: number; created: number; errors: string[] }> {
  const allScopes = await admin.clientScopes.find()
  let scanned = 0
  let created = 0
  const errors: string[] = []

  for (const scope of allScopes) {
    if (!scope.id || !scope.name || !SMART_SCOPE_MAPPERS[scope.name]) continue
    scanned++

    try {
      created += await ensureScopeMappers(admin, scope.id, scope.name)
    } catch (error) {
      const msg = `Failed on scope ${scope.name}: ${error instanceof Error ? error.message : error}`
      errors.push(msg)
      logger.admin.error('ensureAllSmartMappers failed for scope', { scope: scope.name, error })
    }
  }

  return { scanned, created, errors }
}

export interface ScopeMapperInfo {
  scopeId: string
  scopeName: string
  mappers: {
    id?: string
    name: string
    claimName: string
    userAttribute: string
    accessTokenClaim: boolean
    idTokenClaim: boolean
    userinfoTokenClaim: boolean
  }[]
  /** Mappers that should exist according to SMART_SCOPE_MAPPERS but are missing */
  missingMappers: string[]
  /** Whether all required mappers are present */
  healthy: boolean
}

/**
 * Get the status of all SMART-related scope mappers.
 */
export async function getSmartMapperStatus(
  admin: KcAdminClient,
): Promise<ScopeMapperInfo[]> {
  const allScopes = await admin.clientScopes.find()
  const results: ScopeMapperInfo[] = []

  for (const scope of allScopes) {
    if (!scope.id || !scope.name || !SMART_SCOPE_MAPPERS[scope.name]) continue

    let mappers: ProtocolMapperRepresentation[] = []
    try {
      mappers = await admin.clientScopes.listProtocolMappers({ id: scope.id })
    } catch {
      // No mappers
    }

    const existingMapperNames = new Set(mappers.map((m) => m.name))
    const requiredMappers = SMART_SCOPE_MAPPERS[scope.name] || []
    const missingMappers = requiredMappers
      .filter((def) => !existingMapperNames.has(def.name))
      .map((def) => def.name)

    results.push({
      scopeId: scope.id,
      scopeName: scope.name,
      mappers: mappers
        .filter((m) => m.protocolMapper === 'oidc-usermodel-attribute-mapper')
        .map((m) => ({
          id: m.id,
          name: m.name ?? '',
          claimName: m.config?.['claim.name'] ?? '',
          userAttribute: m.config?.['user.attribute'] ?? '',
          accessTokenClaim: m.config?.['access.token.claim'] === 'true',
          idTokenClaim: m.config?.['id.token.claim'] === 'true',
          userinfoTokenClaim: m.config?.['userinfo.token.claim'] === 'true',
        })),
      missingMappers,
      healthy: missingMappers.length === 0,
    })
  }

  return results
}
