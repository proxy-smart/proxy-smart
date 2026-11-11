// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type IdentityProviderMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderMapperRepresentation.js'
import type { IdentityProviderMapperTypeRepresentation } from '@keycloak/keycloak-admin-client/lib/defs/identityProviderMapperTypeRepresentation.js'
import type { ConfigPropertyRepresentation } from '@keycloak/keycloak-admin-client/lib/defs/configPropertyRepresentation.js'
import { logger } from './logger'
import { fromKeycloakConfig } from './keycloak-component-config'
import type { MapperTypePropertyType } from '@/schemas'

/** IdP attribute-import mappers brokered logins need for SMART (above all `fhirUser`): declare, report, provision. */

export type IdpMapperSyncMode = 'INHERIT' | 'IMPORT' | 'LEGACY' | 'FORCE'

export interface IdpAttributeMapperDefinition {
  /** Mapper name stored in Keycloak */
  name: string
  /** Keycloak user attribute the brokered value is written to */
  userAttribute: string
  /** Claim name (OIDC) or attribute name (SAML) on the external assertion */
  externalName: string
  /** A provider is only reported healthy when every required mapper exists */
  required: boolean
  /** FORCE re-imports on every login, so upstream changes propagate */
  syncMode: IdpMapperSyncMode
  description: string
}

/** Each userAttribute must be declared in REQUIRED_USER_ATTRIBUTES (init/realm-settings.ts) or Keycloak drops it. */
export const SMART_IDP_ATTRIBUTE_MAPPERS: IdpAttributeMapperDefinition[] = [
  {
    name: 'fhirUser-import',
    userAttribute: 'fhirUser',
    externalName: 'fhirUser',
    required: true,
    syncMode: 'FORCE',
    description:
      'Imports the fhirUser reference from the external identity so brokered users resolve to a FHIR resource in SMART launches',
  },
  {
    name: 'organization-import',
    userAttribute: 'organization',
    externalName: 'organization',
    required: false,
    syncMode: 'FORCE',
    description:
      'Imports the organization the external identity belongs to, used for tenant-scoped views of brokered users',
  },
]

/** Config keys used by Keycloak mapper types for the external claim/attribute */
const SOURCE_CONFIG_KEYS = ['claim', 'attribute.name', 'attribute.friendly.name', 'jsonField'] as const

/** Config keys used by Keycloak mapper types for the target user attribute */
const TARGET_CONFIG_KEYS = ['user.attribute', 'userAttribute'] as const

/** Keycloak's built-in OIDC/SAML types; provider-specific variants are discovered from their declared properties. */
const KNOWN_ATTRIBUTE_MAPPER_TYPES: Record<string, { sourceKey: string; targetKey: string }> = {
  'oidc-user-attribute-idp-mapper': { sourceKey: 'claim', targetKey: 'user.attribute' },
  'saml-user-attribute-idp-mapper': { sourceKey: 'attribute.name', targetKey: 'user.attribute' },
}

export interface ResolvedAttributeMapperType {
  /** Keycloak mapper type id (identityProviderMapper) */
  id: string
  /** Config key carrying the external claim/attribute name */
  sourceKey: string
  /** Config key carrying the target Keycloak user attribute */
  targetKey: string
  /** Whether the type accepts a syncMode config entry */
  supportsSyncMode: boolean
}

const propertyNames = (type: IdentityProviderMapperTypeRepresentation): Set<string> =>
  new Set((type.properties ?? []).map((property) => property.name).filter((name): name is string => !!name))

/** The config properties a Keycloak mapper type declares, for the IdP and LDAP mapper-type endpoints. */
export const normalizeMapperTypeProperties = (
  properties: ConfigPropertyRepresentation[] | undefined,
): MapperTypePropertyType[] =>
  (properties ?? [])
    .filter((property): property is ConfigPropertyRepresentation & { name: string } => !!property.name)
    .map((property) => ({
      name: property.name,
      label: property.label,
      helpText: property.helpText,
      type: property.type,
      defaultValue:
        property.defaultValue === undefined || property.defaultValue === null
          ? undefined
          : String(property.defaultValue),
      options: property.options,
      secret: property.secret,
      required: property.required,
    }))

/** The provider's claim → user-attribute mapper type, or null when it offers none. */
export async function resolveAttributeMapperType(
  admin: KcAdminClient,
  alias: string,
): Promise<ResolvedAttributeMapperType | null> {
  let types: Record<string, IdentityProviderMapperTypeRepresentation>
  try {
    types = await admin.identityProviders.findMapperTypes({ alias })
  } catch (error) {
    logger.admin.warn('Could not list IdP mapper types', {
      alias,
      error: error instanceof Error ? error.message : error,
    })
    return null
  }

  const available = Object.values(types).filter((type) => !!type.id)

  for (const [id, binding] of Object.entries(KNOWN_ATTRIBUTE_MAPPER_TYPES)) {
    const match = available.find((type) => type.id === id)
    if (match) {
      return { id, ...binding, supportsSyncMode: propertyNames(match).has('syncMode') }
    }
  }

  for (const type of available) {
    if (!type.id?.includes('user-attribute')) continue
    const names = propertyNames(type)
    const sourceKey = SOURCE_CONFIG_KEYS.find((key) => names.has(key))
    const targetKey = TARGET_CONFIG_KEYS.find((key) => names.has(key))
    if (sourceKey && targetKey) {
      return { id: type.id, sourceKey, targetKey, supportsSyncMode: names.has('syncMode') }
    }
  }

  return null
}

export function buildAttributeMapper(
  alias: string,
  definition: IdpAttributeMapperDefinition,
  type: ResolvedAttributeMapperType,
): IdentityProviderMapperRepresentation {
  const config: Record<string, string> = {
    [type.sourceKey]: definition.externalName,
    [type.targetKey]: definition.userAttribute,
  }
  if (type.supportsSyncMode) {
    config.syncMode = definition.syncMode
  }

  return {
    name: definition.name,
    identityProviderAlias: alias,
    identityProviderMapper: type.id,
    config,
  }
}

export interface IdpMapperEntry {
  id?: string
  name: string
  identityProviderMapper: string
  /** Target Keycloak user attribute, when the mapper writes one */
  userAttribute?: string
  /** Source claim / assertion attribute, when the mapper reads one */
  externalName?: string
  syncMode?: string
  config: Record<string, string>
}

/** Any IdP mapper as claim → attribute, whatever its type. */
export function normalizeIdpMapper(mapper: IdentityProviderMapperRepresentation): IdpMapperEntry {
  const config = fromKeycloakConfig(mapper.config)
  const firstOf = (keys: readonly string[]): string | undefined =>
    keys.map((key) => config[key]).find((value) => !!value)

  return {
    id: mapper.id,
    name: mapper.name ?? '',
    identityProviderMapper: mapper.identityProviderMapper ?? '',
    userAttribute: firstOf(TARGET_CONFIG_KEYS),
    externalName: firstOf(SOURCE_CONFIG_KEYS),
    syncMode: config.syncMode,
    config,
  }
}

export interface IdpMapperStatus {
  alias: string
  providerId: string
  displayName?: string
  enabled: boolean
  /** Mapper type used for attribute imports, null when the provider has none */
  attributeMapperType: string | null
  mappers: IdpMapperEntry[]
  /** Names of required definitions with no matching mapper */
  missingRequired: string[]
  /** Names of optional definitions with no matching mapper */
  missingOptional: string[]
  /** Definitions whose mapper EXISTS but does not do what the definition asks */
  misconfigured: { name: string; mapper: string; differences: string[] }[]
  /** No required mapper missing and none misconfigured; always true when unsupported or not user-facing */
  healthy: boolean
  /** True when the provider supports no attribute-import mapper type */
  unsupported: boolean
  /** False for machine trust anchors, where user attributes do not apply */
  userFacing: boolean
}

/** Matched on the target attribute, not the name, so a renamed mapper still counts. */
const findMapperFor = (
  definition: IdpAttributeMapperDefinition,
  mappers: IdpMapperEntry[],
): IdpMapperEntry | undefined =>
  mappers.find((mapper) => mapper.userAttribute === definition.userAttribute)

/** Only syncMode is compared: a provider may legitimately publish the claim under another name. */
function mapperDrift(
  definition: IdpAttributeMapperDefinition,
  mapper: IdpMapperEntry,
  supportsSyncMode: boolean,
): string[] {
  if (!supportsSyncMode || mapper.syncMode === definition.syncMode) return []
  return [`syncMode is ${mapper.syncMode ?? '(unset)'}, expected ${definition.syncMode}`]
}

/** False for a client-assertion IdP, a machine trust anchor no user logs in through. */
export function isUserFacingProvider(provider: { config?: Record<string, string> | null }): boolean {
  return fromKeycloakConfig(provider.config).supportsClientAssertions !== 'true'
}

export async function getIdpMapperStatus(
  admin: KcAdminClient,
  provider: {
    alias?: string
    providerId?: string
    displayName?: string
    enabled?: boolean
    config?: Record<string, string> | null
  },
): Promise<IdpMapperStatus> {
  const alias = provider.alias ?? ''

  const [mapperList, attributeType] = await Promise.all([
    admin.identityProviders.findMappers({ alias }).catch((): IdentityProviderMapperRepresentation[] => []),
    resolveAttributeMapperType(admin, alias),
  ])

  const mappers = mapperList.map(normalizeIdpMapper)
  const userFacing = isUserFacingProvider(provider)
  const missingRequired: string[] = []
  const missingOptional: string[] = []
  const misconfigured: IdpMapperStatus['misconfigured'] = []

  if (userFacing) {
    for (const definition of SMART_IDP_ATTRIBUTE_MAPPERS) {
      const mapper = findMapperFor(definition, mappers)
      if (!mapper) {
        if (definition.required) missingRequired.push(definition.name)
        else missingOptional.push(definition.name)
        continue
      }

      const differences = mapperDrift(definition, mapper, attributeType?.supportsSyncMode ?? false)
      if (differences.length > 0) {
        misconfigured.push({ name: definition.name, mapper: mapper.name, differences })
      }
    }
  }

  const unsupported = attributeType === null

  return {
    alias,
    providerId: provider.providerId ?? '',
    displayName: provider.displayName,
    enabled: provider.enabled !== false,
    attributeMapperType: attributeType?.id ?? null,
    mappers,
    missingRequired,
    missingOptional,
    misconfigured,
    // A misconfigured optional mapper still counts: it reads as covered while it is not.
    healthy: unsupported || !userFacing || (missingRequired.length === 0 && misconfigured.length === 0),
    unsupported,
    userFacing,
  }
}

export async function getAllIdpMapperStatus(admin: KcAdminClient): Promise<IdpMapperStatus[]> {
  const providers = await admin.identityProviders.find()
  return Promise.all(providers.filter((provider) => !!provider.alias).map((provider) => getIdpMapperStatus(admin, provider)))
}

export interface EnsureIdpMappersResult {
  alias: string
  /** Mapper type the provisioned mappers were created with */
  attributeMapperType: string | null
  /** Names of mappers created by this call */
  created: string[]
  /** Names of mappers that existed but were corrected in place by this call */
  repaired: string[]
  /** Names of definitions already served by a correctly configured mapper */
  skipped: string[]
  /** True when the provider supports no attribute-import mapper type */
  unsupported: boolean
  /** False when the provider is a machine trust anchor; nothing is provisioned */
  userFacing: boolean
  errors: string[]
}

/** Create missing mappers and repair drifted ones in place; machine trust anchors are skipped. */
export async function ensureIdpAttributeMappers(
  admin: KcAdminClient,
  alias: string,
  includeOptional = true,
): Promise<EnsureIdpMappersResult> {
  const result: EnsureIdpMappersResult = {
    alias,
    attributeMapperType: null,
    created: [],
    repaired: [],
    skipped: [],
    unsupported: false,
    userFacing: true,
    errors: [],
  }

  const provider = await admin.identityProviders.findOne({ alias }).catch(() => undefined)
  if (provider && !isUserFacingProvider(provider)) {
    result.userFacing = false
    logger.admin.debug('Skipping attribute mappers on a client-assertion IdP', { alias })
    return result
  }

  const attributeType = await resolveAttributeMapperType(admin, alias)
  if (!attributeType) {
    result.unsupported = true
    logger.admin.debug('IdP supports no attribute-import mapper type', { alias })
    return result
  }
  result.attributeMapperType = attributeType.id

  const existing = await admin.identityProviders
    .findMappers({ alias })
    .catch((): IdentityProviderMapperRepresentation[] => [])
  const existingEntries = existing.map(normalizeIdpMapper)

  const definitions = includeOptional
    ? SMART_IDP_ATTRIBUTE_MAPPERS
    : SMART_IDP_ATTRIBUTE_MAPPERS.filter((definition) => definition.required)

  for (const definition of definitions) {
    const current = findMapperFor(definition, existingEntries)
    const differences = current ? mapperDrift(definition, current, attributeType.supportsSyncMode) : []

    if (current && differences.length === 0) {
      result.skipped.push(definition.name)
      continue
    }

    try {
      if (current?.id) {
        // Merge, not rebuild: keep an admin's claim name.
        await admin.identityProviders.updateMapper(
          { alias, id: current.id },
          {
            id: current.id,
            name: current.name || definition.name,
            identityProviderAlias: alias,
            identityProviderMapper: current.identityProviderMapper || attributeType.id,
            config: { ...current.config, syncMode: definition.syncMode },
          },
        )
        result.repaired.push(definition.name)
        logger.admin.info('Repaired IdP attribute mapper', {
          alias,
          mapper: current.name,
          userAttribute: definition.userAttribute,
          differences,
        })
        continue
      }

      await admin.identityProviders.createMapper({
        alias,
        identityProviderMapper: buildAttributeMapper(alias, definition, attributeType),
      })
      result.created.push(definition.name)
      logger.admin.info('Provisioned IdP attribute mapper', {
        alias,
        mapper: definition.name,
        userAttribute: definition.userAttribute,
        type: attributeType.id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.errors.push(`${definition.name}: ${message}`)
      logger.admin.warn('Failed to provision IdP attribute mapper', {
        alias,
        mapper: definition.name,
        error: message,
      })
    }
  }

  return result
}
