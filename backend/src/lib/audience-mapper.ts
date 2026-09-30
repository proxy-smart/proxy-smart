// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ProtocolMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/protocolMapperRepresentation.js'
import { findClientByClientId } from '@/lib/keycloak-client-lookup'
import { logger } from '@/lib/logger'
import type { ProtocolMapper } from '@/lib/smart-scope-mappers'

export const AUDIENCE_MAPPER_TYPE = 'oidc-audience-mapper'

/** Names a realm client. Since Keycloak 26.7.5 it adds nothing unless that client exists and is enabled. */
export const INCLUDED_CLIENT_AUDIENCE = 'included.client.audience'

/** A literal audience value, typically a resource URL. */
export const INCLUDED_CUSTOM_AUDIENCE = 'included.custom.audience'

export type AudienceKind = 'client' | 'custom'

function configValue(mapper: ProtocolMapperRepresentation, key: string): string | undefined {
  const value: unknown = mapper.config?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function isAudienceMapper(mapper: ProtocolMapperRepresentation): boolean {
  return mapper.protocolMapper === AUDIENCE_MAPPER_TYPE
}

/** The audience a mapper emits, whichever key it is stored under. */
export function audienceOf(mapper: ProtocolMapperRepresentation): string | undefined {
  return configValue(mapper, INCLUDED_CLIENT_AUDIENCE) ?? configValue(mapper, INCLUDED_CUSTOM_AUDIENCE)
}

export function audienceKindOf(mapper: ProtocolMapperRepresentation): AudienceKind {
  return configValue(mapper, INCLUDED_CLIENT_AUDIENCE) ? 'client' : 'custom'
}

/** Every audience a set of mappers emits, in order. */
export function audiencesOf(mappers: ProtocolMapperRepresentation[] | undefined): string[] {
  return (mappers ?? []).filter(isAudienceMapper).flatMap((mapper) => audienceOf(mapper) ?? [])
}

export async function resolveAudienceKind(admin: KcAdminClient, audience: string): Promise<AudienceKind> {
  return (await findClientByClientId(admin, audience)) ? 'client' : 'custom'
}

export function audienceMapper(
  audience: string,
  kind: AudienceKind,
  name: string,
  includeInIdToken = false,
): ProtocolMapper {
  return {
    name,
    protocol: 'openid-connect',
    protocolMapper: AUDIENCE_MAPPER_TYPE,
    consentRequired: false,
    config: {
      [kind === 'client' ? INCLUDED_CLIENT_AUDIENCE : INCLUDED_CUSTOM_AUDIENCE]: audience,
      'id.token.claim': includeInIdToken ? 'true' : 'false',
      'access.token.claim': 'true',
    },
  }
}

/** An audience mapper for a value that may or may not be a realm client. */
export async function resolvedAudienceMapper(
  admin: KcAdminClient,
  audience: string,
  name: string,
): Promise<ProtocolMapper> {
  return audienceMapper(audience, await resolveAudienceKind(admin, audience), name)
}

/** The slice of the admin client the reconcile touches. */
export interface AudienceReconcileAdmin {
  clients: Pick<KcAdminClient['clients'], 'find' | 'updateProtocolMapper'>
  clientScopes: Pick<KcAdminClient['clientScopes'], 'find' | 'updateProtocolMapper'>
}

export interface ReconciledAudience {
  owner: string
  ownerType: 'client' | 'client-scope'
  mapper: string
  audience: string
}

function asCustomAudience(mapper: ProtocolMapperRepresentation, audience: string): ProtocolMapperRepresentation {
  const config: Record<string, string> = {}
  for (const [key, value] of Object.entries(mapper.config ?? {})) {
    if (key !== INCLUDED_CLIENT_AUDIENCE && typeof value === 'string') config[key] = value
  }
  return { ...mapper, config: { ...config, [INCLUDED_CUSTOM_AUDIENCE]: audience } }
}

/**
 * Move `included.client.audience` values that name no client at all (URLs) to
 * `included.custom.audience`, where Keycloak 26.7.5+ still emits them. A mapper
 * naming an existing but disabled client is left alone: dropping it is the point.
 */
export async function reconcileLiteralAudiences(admin: AudienceReconcileAdmin): Promise<ReconciledAudience[]> {
  const [clients, scopes] = await Promise.all([admin.clients.find(), admin.clientScopes.find()])
  const knownClientIds = new Set(clients.flatMap((client) => client.clientId ?? []))

  type Update = (mapperId: string, mapper: ProtocolMapperRepresentation) => Promise<void>
  const owners: { owner: string; ownerType: ReconciledAudience['ownerType']; mappers: ProtocolMapperRepresentation[]; update: Update }[] = [
    ...clients.flatMap(({ id, clientId, protocolMappers }) => id ? [{
      owner: clientId ?? id,
      ownerType: 'client' as const,
      mappers: protocolMappers ?? [],
      update: (mapperId: string, mapper: ProtocolMapperRepresentation) => admin.clients.updateProtocolMapper({ id, mapperId }, mapper),
    }] : []),
    ...scopes.flatMap(({ id, name, protocolMappers }) => id ? [{
      owner: name ?? id,
      ownerType: 'client-scope' as const,
      mappers: protocolMappers ?? [],
      update: (mapperId: string, mapper: ProtocolMapperRepresentation) => admin.clientScopes.updateProtocolMapper({ id, mapperId }, mapper),
    }] : []),
  ]

  const reconciled: ReconciledAudience[] = []
  for (const { owner, ownerType, mappers, update } of owners) {
    for (const mapper of mappers) {
      const audience = configValue(mapper, INCLUDED_CLIENT_AUDIENCE)
      if (!isAudienceMapper(mapper) || !mapper.id || !audience || knownClientIds.has(audience)) continue
      const entry = { owner, ownerType, mapper: mapper.name ?? mapper.id, audience }
      try {
        await update(mapper.id, asCustomAudience(mapper, audience))
        reconciled.push(entry)
        logger.keycloak.info('Moved literal audience to included.custom.audience', entry)
      } catch (error) {
        logger.keycloak.warn('Could not move literal audience', { ...entry, error })
      }
    }
  }
  return reconciled
}
