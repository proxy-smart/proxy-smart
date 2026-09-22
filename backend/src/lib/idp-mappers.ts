// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type IdentityProviderMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderMapperRepresentation.js'
import type { IdentityProviderMapperTypeRepresentation } from '@keycloak/keycloak-admin-client/lib/defs/identityProviderMapperTypeRepresentation.js'
import type { ConfigPropertyRepresentation } from '@keycloak/keycloak-admin-client/lib/defs/configPropertyRepresentation.js'
import { logger } from './logger'

/**
 * Identity Provider mapper definitions for brokered (federated) logins.
 *
 * A user who authenticates through an external IdP arrives in Keycloak with
 * none of the custom attributes the SMART layer depends on — most importantly
 * `fhirUser`, which the token endpoint, consent service and session resolver
 * all read from the Keycloak user. Without an IdP mapper importing it from the
 * external claim/assertion, brokered users cannot be launched into SMART apps.
 *
 * This module is the IdP counterpart to `smart-scope-mappers.ts`: it declares
 * what must exist, reports whether it does, and provisions what is missing —
 * idempotently.
 */

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

/**
 * Attribute imports every brokered login needs for SMART on FHIR.
 *
 * Attribute names match the realm user-profile attributes declared in
 * `init.ts` (REQUIRED_USER_ATTRIBUTES) — Keycloak silently drops attributes
 * that are not declared there, so the two lists must stay in sync.
 */
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

/**
 * Config-key bindings for the mapper types Keycloak ships for OIDC and SAML.
 * Social/OAuth providers register their own `<provider>-user-attribute-mapper`
 * variants, which are discovered generically from their declared properties.
 */
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

/**
 * Flatten a Keycloak mapper config (values are strings, but the
 * representation is loosely typed) into a plain string record.
 */
export const flattenMapperConfig = (config: unknown): Record<string, string> => {
  if (!config || typeof config !== 'object') return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    result[key] = Array.isArray(value) ? String(value[0] ?? '') : String(value)
  }
  return result
}

/** A Keycloak mapper-type config property, rendered for the admin UI */
export interface MapperTypeProperty {
  name: string
  label?: string
  helpText?: string
  type?: string
  defaultValue?: string
  options?: string[]
  secret?: boolean
  required?: boolean
}

/**
 * Normalize the config properties a Keycloak mapper type declares. Shared by the IdP and
 * user-federation mapper-type endpoints, whose schemas differ but whose properties do not.
 */
export const normalizeMapperTypeProperties = (
  properties: ConfigPropertyRepresentation[] | undefined,
): MapperTypeProperty[] =>
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

/**
 * Ask Keycloak which mapper types the given provider supports and pick the one
 * that imports an external claim into a Keycloak user attribute.
 *
 * Returns null when the provider offers no such type — nothing can then be
 * provisioned, and the provider is reported as unsupported rather than broken.
 */
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

  // Provider-specific variants (google-user-attribute-mapper, etc.): derive the
  // config keys from the properties the type itself declares.
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

/**
 * Build the Keycloak representation for an attribute-import mapper.
 */
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

/**
 * Normalize an arbitrary IdP mapper into a shape the admin UI can render,
 * surfacing claim → attribute regardless of which mapper type produced it.
 */
export function normalizeIdpMapper(mapper: IdentityProviderMapperRepresentation): IdpMapperEntry {
  const config = flattenMapperConfig(mapper.config)
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
  /** True when every required attribute import is present AND correctly configured */
  healthy: boolean
  /** True when the provider supports no attribute-import mapper type */
  unsupported: boolean
  /** False for machine trust anchors, where user attributes do not apply */
  userFacing: boolean
}

/**
 * The mapper serving a definition, matched on the TARGET user attribute.
 *
 * Deliberately not matched on name: an admin who renames a mapper has not removed it, and
 * provisioning a second mapper writing the same attribute would be worse than the rename.
 */
const findMapperFor = (
  definition: IdpAttributeMapperDefinition,
  mappers: IdpMapperEntry[],
): IdpMapperEntry | undefined =>
  mappers.find((mapper) => mapper.userAttribute === definition.userAttribute)

/**
 * How an existing mapper differs from what its definition asks for. Empty means it is correct.
 *
 * EXISTENCE USED TO BE THE WHOLE CHECK, and that is how `fhirUser-import` ran in production
 * with syncMode IMPORT while the definition demanded FORCE. IMPORT writes the attribute only
 * when the brokered user is first created, so a member who signed in BEFORE their health
 * record existed never received `fhirUser` — not on that login and not on any later one,
 * which reads to them as "your health record isn't set up yet", permanently. The status
 * endpoint called the provider healthy throughout, because a mapper writing the right
 * attribute was present, and `ensureIdpAttributeMappers` skipped it for the same reason, so
 * running the fix endpoint could never repair it either.
 *
 * Only `syncMode` is compared, and only where the mapper type carries one. The CLAIM is
 * deliberately not: a federated IdP may legitimately publish the reference under its own name
 * — `smart_fhir_user`, say — and an admin who wired that up has configured it correctly, so
 * "correcting" it would break a working provider. What the proxy actually requires is the
 * target attribute (which identifies the mapper) and that the value refreshes on every login.
 * A field the type does not support is skipped, because a check that cannot go green is one
 * people learn to ignore.
 */
function mapperDrift(
  definition: IdpAttributeMapperDefinition,
  mapper: IdpMapperEntry,
  supportsSyncMode: boolean,
): string[] {
  if (!supportsSyncMode || mapper.syncMode === definition.syncMode) return []
  return [`syncMode is ${mapper.syncMode ?? '(unset)'}, expected ${definition.syncMode}`]
}

/**
 * Whether humans are brokered through this provider.
 *
 * An IdP configured for client assertions (`supportsClientAssertions`) is a
 * machine trust anchor — the federated-JWT flow uses it to verify proxy-signed
 * client assertions, and no user ever logs in through it. Expecting user
 * attribute imports there is a permanent false alarm, and a health check that
 * cannot go green is a health check people learn to ignore.
 *
 * Keyed on configuration rather than on an alias, so it holds for any such
 * provider rather than only for `proxy-smart-signing`.
 */
export function isUserFacingProvider(provider: { config?: Record<string, string> | null }): boolean {
  return flattenMapperConfig(provider.config).supportsClientAssertions !== 'true'
}

/**
 * Report the SMART attribute-import status of a single identity provider.
 */
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
    admin.identityProviders.findMappers({ alias }).catch(() => [] as IdentityProviderMapperRepresentation[]),
    resolveAttributeMapperType(admin, alias),
  ])

  const mappers = mapperList.map(normalizeIdpMapper)
  const userFacing = isUserFacingProvider(provider)
  const missingRequired: string[] = []
  const missingOptional: string[] = []
  const misconfigured: IdpMapperStatus['misconfigured'] = []

  // Only providers humans log in through need user attribute imports.
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
    // Neither a machine trust anchor nor a provider that cannot carry attribute
    // mappers at all is "unhealthy" — there is no action an admin could take.
    //
    // A misconfigured mapper counts as unhealthy even when it is optional: it EXISTS, so an
    // admin looking at the list sees the attribute covered, and the whole failure mode here
    // is a wrong mapper reading as a present one.
    healthy: unsupported || !userFacing || (missingRequired.length === 0 && misconfigured.length === 0),
    unsupported,
    userFacing,
  }
}

/**
 * Report attribute-import status for every identity provider in the realm.
 */
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

/**
 * Ensure the SMART attribute-import mappers exist AND are configured correctly.
 *
 * Idempotent: a definition already served by a correct mapper (matched on the target user
 * attribute, so admin-renamed mappers still count) is skipped. One that exists but has
 * drifted is corrected IN PLACE rather than skipped — this used to only ever create missing
 * mappers, which is why the fix endpoint could not repair `fhirUser-import` running on
 * syncMode IMPORT. Repairing in place also avoids the alternative failure, two mappers
 * writing the same user attribute.
 *
 * Machine trust anchors are left alone — see isUserFacingProvider.
 *
 * @param includeOptional also provision definitions marked optional
 */
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
    .catch(() => [] as IdentityProviderMapperRepresentation[])
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
        // Merge rather than rebuild. buildAttributeMapper would rewrite the claim to the
        // definition's, discarding an admin's deliberate mapping from a provider that
        // publishes the reference under another name. Only the drifted keys move.
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
