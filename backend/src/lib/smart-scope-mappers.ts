// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ProtocolMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/protocolMapperRepresentation'
import { logger } from './logger'

/** A Keycloak user attribute emitted as a token claim. */
export interface SmartMapperDefinition {
  name: string
  userAttribute: string
  claimName: string
  /** Keycloak jsonType.label: String, boolean, JSON, ... */
  jsonType: string
}

/** Patient and encounter context live in the TokenContextStore, so only fhirUser needs a mapper. */
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

export const SMART_MAPPER_SCOPES = Object.keys(SMART_SCOPE_MAPPERS)

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

/** How many mappers were created; idempotent. */
export async function ensureScopeMappers(
  admin: KcAdminClient,
  scopeId: string,
  scopeName: string,
): Promise<number> {
  return (await reconcileSmartScope(admin, scopeId, scopeName)).created
}

function reconcileSmartScope(admin: KcAdminClient, scopeId: string, scopeName: string): Promise<ScopeReconciliation> {
  const requiredMappers = SMART_SCOPE_MAPPERS[scopeName] ?? []
  if (requiredMappers.length === 0) return Promise.resolve({ created: 0, errors: [] })
  return reconcileMappersOnScope(admin, scopeId, scopeName, requiredMappers.map(toProtocolMapper))
}

export interface ProtocolMapper {
  name: string
  protocol: string
  protocolMapper: string
  consentRequired?: boolean
  config: Record<string, string>
}

interface ScopeReconciliation {
  created: number
  errors: string[]
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Adds the missing `required` mappers by name; how many were created. Also repairs the RFC 8707 audience scope. */
export async function ensureMappersOnScope(
  admin: KcAdminClient,
  scopeId: string,
  scopeName: string,
  required: ProtocolMapper[],
): Promise<number> {
  return (await reconcileMappersOnScope(admin, scopeId, scopeName, required)).created
}

async function reconcileMappersOnScope(
  admin: KcAdminClient,
  scopeId: string,
  scopeName: string,
  required: ProtocolMapper[],
): Promise<ScopeReconciliation> {
  let existingMappers: ProtocolMapperRepresentation[]
  try {
    existingMappers = await admin.clientScopes.listProtocolMappers({ id: scopeId })
  } catch (error) {
    logger.admin.warn('Could not list scope mappers', { scopeName, error: errorText(error) })
    return { created: 0, errors: [`Failed to list mappers on scope ${scopeName}: ${errorText(error)}`] }
  }

  const existingNames = new Set(existingMappers.map((m) => m.name))
  const result: ScopeReconciliation = { created: 0, errors: [] }

  for (const mapper of required) {
    if (existingNames.has(mapper.name)) {
      logger.admin.debug('Mapper already exists, skipping', { scopeName, mapper: mapper.name })
      continue
    }

    try {
      await admin.clientScopes.addProtocolMapper({ id: scopeId }, mapper)
      logger.admin.info('Auto-provisioned protocol mapper', { scopeName, mapper: mapper.name })
      result.created++
    } catch (error) {
      logger.admin.warn('Failed to auto-provision mapper', { scopeName, mapper: mapper.name, error: errorText(error) })
      result.errors.push(`Failed to create ${mapper.name} on scope ${scopeName}: ${errorText(error)}`)
    }
  }

  return result
}

/** Reconciles every SMART scope's mappers, on startup or from the admin "fix mappers" action. */
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
    const result = await reconcileSmartScope(admin, scope.id, scope.name)
    created += result.created
    errors.push(...result.errors)
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
  missingMappers: string[]
  healthy: boolean
}

/** A scope whose mappers cannot be listed reports every required mapper as missing. */
export async function getSmartMapperStatus(
  admin: KcAdminClient,
): Promise<ScopeMapperInfo[]> {
  const allScopes = await admin.clientScopes.find()
  const results: ScopeMapperInfo[] = []

  for (const scope of allScopes) {
    if (!scope.id || !scope.name || !SMART_SCOPE_MAPPERS[scope.name]) continue

    const mappers: ProtocolMapperRepresentation[] = await admin.clientScopes
      .listProtocolMappers({ id: scope.id })
      .catch(() => [])

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
