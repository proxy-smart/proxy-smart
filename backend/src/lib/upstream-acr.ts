// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type IdentityProviderMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderMapperRepresentation.js'
import type ProtocolMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/protocolMapperRepresentation'
import { config } from '../config'
import { logger } from './logger'
import { getAdminClient } from './kc-admin-factory'
import { isUserFacingProvider } from './idp-mappers'
import { fromKeycloakConfig } from './keycloak-component-config'
import { isRecord, parseJson, parseJsonRecord } from './type-guards'

/** The token claim carrying the acr the brokered identity provider reported, copied from the user session. */
export const UPSTREAM_ACR_CLAIM = 'upstream_acr'

/** Keycloak's claim-to-session-note mapper names the note after the claim it copies. */
const SESSION_NOTE = 'acr'
const SESSION_NOTE_IDP_MAPPER = 'oidc-user-session-note-idp-mapper'
const SESSION_NOTE_PROTOCOL_MAPPER = 'oidc-usersessionmodel-note-mapper'
const IDP_MAPPER_NAME = 'upstream-acr-session-note'
const PROTOCOL_MAPPER_NAME = 'upstream-acr'
const ACR_SCOPE = 'acr'
const OIDC_PROVIDERS: ReadonlySet<string> = new Set(['oidc', 'keycloak-oidc'])
const ACR_LOA_MAP = 'acr.loa.map'
/** Above any level a local flow reaches, so Keycloak's own acr claim never asserts an upstream value. */
const UPSTREAM_LOA = 100

export type UpstreamAcrAdmin = {
  identityProviders: Pick<KcAdminClient['identityProviders'], 'find' | 'findMappers' | 'createMapper'>
  clientScopes: Pick<KcAdminClient['clientScopes'], 'find' | 'listProtocolMappers' | 'addProtocolMapper'>
  realms: Pick<KcAdminClient['realms'], 'findOne' | 'update'>
  realmName: string
}

export function upstreamAcrIdpMapper(alias: string): IdentityProviderMapperRepresentation {
  return {
    name: IDP_MAPPER_NAME,
    identityProviderAlias: alias,
    identityProviderMapper: SESSION_NOTE_IDP_MAPPER,
    config: {
      claims: JSON.stringify([{ key: SESSION_NOTE, value: '.+' }]),
      'are.claim.values.regex': 'true',
      syncMode: 'FORCE',
    },
  }
}

export const UPSTREAM_ACR_PROTOCOL_MAPPER: ProtocolMapperRepresentation = {
  name: PROTOCOL_MAPPER_NAME,
  protocol: 'openid-connect',
  protocolMapper: SESSION_NOTE_PROTOCOL_MAPPER,
  config: {
    'user.session.note': SESSION_NOTE,
    'claim.name': UPSTREAM_ACR_CLAIM,
    'jsonType.label': 'String',
    'access.token.claim': 'true',
    'id.token.claim': 'true',
    'introspection.token.claim': 'true',
  },
}

function copiesUpstreamAcr(mapper: IdentityProviderMapperRepresentation): boolean {
  if (mapper.identityProviderMapper !== SESSION_NOTE_IDP_MAPPER) return false
  const claims = parseJson(fromKeycloakConfig(mapper.config).claims)
  return Array.isArray(claims) && claims.some((entry) => isRecord(entry) && entry.key === SESSION_NOTE)
}

type Provider = { alias?: string; providerId?: string; config?: Record<string, string> | null }

/** A user-facing OIDC provider copies the acr it reports into the user session; true when the mapper was created. */
export async function ensureUpstreamAcrSessionNote(admin: Pick<UpstreamAcrAdmin, 'identityProviders'>, provider: Provider): Promise<boolean> {
  const alias = provider.alias
  if (!alias || !OIDC_PROVIDERS.has(provider.providerId ?? '') || !isUserFacingProvider(provider)) return false
  const mappers = await admin.identityProviders.findMappers({ alias })
  if (mappers.some(copiesUpstreamAcr)) return false
  await admin.identityProviders.createMapper({ alias, identityProviderMapper: upstreamAcrIdpMapper(alias) })
  return true
}

/** The aliases of the providers it provisioned. */
export async function ensureUpstreamAcrSessionNotes(admin: Pick<UpstreamAcrAdmin, 'identityProviders'>): Promise<string[]> {
  const provisioned: string[] = []
  for (const provider of await admin.identityProviders.find()) {
    if (await ensureUpstreamAcrSessionNote(admin, provider)) provisioned.push(provider.alias ?? '')
  }
  return provisioned
}

/** The built-in acr scope, which every client carries by default, emits the session note as upstream_acr. */
export async function ensureUpstreamAcrClaim(admin: UpstreamAcrAdmin): Promise<'created' | 'present' | 'no-acr-scope'> {
  const scope = (await admin.clientScopes.find()).find((s) => s.name === ACR_SCOPE)
  if (!scope?.id) return 'no-acr-scope'
  const mappers = await admin.clientScopes.listProtocolMappers({ id: scope.id })
  if (mappers.some((m) => m.name === PROTOCOL_MAPPER_NAME)) return 'present'
  await admin.clientScopes.addProtocolMapper({ id: scope.id }, UPSTREAM_ACR_PROTOCOL_MAPPER)
  return 'created'
}

function loaMap(attributes: Record<string, unknown> | undefined): Record<string, unknown> {
  const raw = attributes?.[ACR_LOA_MAP]
  return (typeof raw === 'string' ? parseJsonRecord(raw) : null) ?? {}
}

/** Lists the configured upstream values in the realm's acr_values_supported; values an admin mapped are left as they are. */
export async function ensureUpstreamAcrValuesAdvertised(admin: UpstreamAcrAdmin, values: readonly string[]): Promise<string[]> {
  if (values.length === 0) return []
  const realm = await admin.realms.findOne({ realm: admin.realmName })
  if (!realm) return []
  const current = loaMap(realm.attributes)
  const added = values.filter((value) => !(value in current))
  if (added.length === 0) return []
  const next = { ...current, ...Object.fromEntries(added.map((value) => [value, UPSTREAM_LOA])) }
  await admin.realms.update({ realm: admin.realmName }, { attributes: { ...realm.attributes, [ACR_LOA_MAP]: JSON.stringify(next) } })
  return added
}

async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const outcome = await run()
    logger.keycloak.info(`Upstream acr: ${name}`, { outcome })
  } catch (error) {
    logger.keycloak.warn(`Could not reconcile upstream acr: ${name}`, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Carries the acr a brokered provider reports into tokens as upstream_acr; idempotent and non-fatal. */
export async function ensureUpstreamAcr(): Promise<void> {
  const admin = await getAdminClient()
  if (!admin) {
    logger.keycloak.debug('Skipping upstream acr — no admin credentials configured')
    return
  }
  await step('identity provider session notes', () => ensureUpstreamAcrSessionNotes(admin))
  await step('upstream_acr claim', () => ensureUpstreamAcrClaim(admin))
  await step('acr_values_supported', () => ensureUpstreamAcrValuesAdvertised(admin, config.keycloak.upstreamAcrValues))
}
