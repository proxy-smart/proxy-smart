// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Identity Provider Mapper Tests
 *
 * Brokered users only carry the attributes an IdP mapper imports for them, so
 * these tests pin the two behaviours SMART launches depend on: resolving the
 * right Keycloak mapper type per provider, and provisioning idempotently.
 */

import { describe, it, expect, mock } from 'bun:test'
import {
  SMART_IDP_ATTRIBUTE_MAPPERS,
  ensureIdpAttributeMappers,
  getIdpMapperStatus,
  normalizeIdpMapper,
  resolveAttributeMapperType,
} from '@/lib/idp-mappers'

type AdminArg = Parameters<typeof resolveAttributeMapperType>[0]

const OIDC_TYPES = {
  'oidc-user-attribute-idp-mapper': {
    id: 'oidc-user-attribute-idp-mapper',
    name: 'Attribute Importer',
    properties: [
      { name: 'claim', label: 'Claim' },
      { name: 'user.attribute', label: 'User Attribute' },
      { name: 'syncMode', label: 'Sync Mode', options: ['INHERIT', 'IMPORT', 'FORCE'] },
    ],
  },
  'oidc-hardcoded-role-idp-mapper': {
    id: 'oidc-hardcoded-role-idp-mapper',
    name: 'Hardcoded Role',
    properties: [{ name: 'role' }],
  },
}

const SAML_TYPES = {
  'saml-user-attribute-idp-mapper': {
    id: 'saml-user-attribute-idp-mapper',
    name: 'Attribute Importer',
    properties: [
      { name: 'attribute.name' },
      { name: 'attribute.friendly.name' },
      { name: 'user.attribute' },
    ],
  },
}

/** Social providers register their own variant with different config keys */
const SOCIAL_TYPES = {
  'google-user-attribute-mapper': {
    id: 'google-user-attribute-mapper',
    name: 'Attribute Importer',
    properties: [{ name: 'jsonField' }, { name: 'userAttribute' }, { name: 'syncMode' }],
  },
}

const NO_ATTRIBUTE_TYPES = {
  'oidc-hardcoded-role-idp-mapper': {
    id: 'oidc-hardcoded-role-idp-mapper',
    name: 'Hardcoded Role',
    properties: [{ name: 'role' }],
  },
}

interface MockOptions {
  types?: Record<string, unknown>
  mappers?: unknown[]
  typesThrow?: boolean
  createThrows?: boolean
  /** Provider-level config, e.g. supportsClientAssertions for a trust anchor */
  providerConfig?: Record<string, string>
}

interface CreateMapperPayload {
  alias: string
  identityProviderMapper: {
    name?: string
    identityProviderAlias?: string
    identityProviderMapper?: string
    config?: Record<string, string>
  }
}

interface UpdateMapperPayload {
  id?: string
  name?: string
  identityProviderMapper?: string
  config?: Record<string, string>
}

function createMockAdmin({
  types = OIDC_TYPES,
  mappers = [],
  typesThrow = false,
  createThrows = false,
  providerConfig = {},
}: MockOptions = {}) {
  /** Payloads passed to createMapper, in call order */
  const createdPayloads: CreateMapperPayload[] = []
  /** Representations passed to updateMapper, in call order */
  const updatedPayloads: UpdateMapperPayload[] = []

  const identityProviders = {
    findOne: mock(async () => ({ alias: 'hospital-oidc', providerId: 'oidc', config: providerConfig })),
    findMapperTypes: mock(async () => {
      if (typesThrow) throw new Error('not supported')
      return types
    }),
    findMappers: mock(async () => mappers),
    createMapper: mock(async (payload: CreateMapperPayload) => {
      if (createThrows) throw new Error('duplicate mapper name')
      createdPayloads.push(payload)
      return { id: 'created-id' }
    }),
    updateMapper: mock(async (target: { alias: string; id: string }, representation: UpdateMapperPayload) => {
      updatedPayloads.push({ ...representation, id: target.id })
    }),
  }

  return {
    admin: { identityProviders } as unknown as AdminArg,
    identityProviders,
    createdPayloads,
    updatedPayloads,
  }
}

describe('resolveAttributeMapperType', () => {
  it('picks the OIDC attribute importer and detects syncMode support', async () => {
    const { admin } = createMockAdmin()

    const resolved = await resolveAttributeMapperType(admin, 'hospital-oidc')

    expect(resolved).toEqual({
      id: 'oidc-user-attribute-idp-mapper',
      sourceKey: 'claim',
      targetKey: 'user.attribute',
      supportsSyncMode: true,
    })
  })

  it('picks the SAML attribute importer with its own config keys', async () => {
    const { admin } = createMockAdmin({ types: SAML_TYPES })

    const resolved = await resolveAttributeMapperType(admin, 'hospital-saml')

    expect(resolved?.id).toBe('saml-user-attribute-idp-mapper')
    expect(resolved?.sourceKey).toBe('attribute.name')
    expect(resolved?.supportsSyncMode).toBe(false)
  })

  it('derives config keys for provider-specific variants from declared properties', async () => {
    const { admin } = createMockAdmin({ types: SOCIAL_TYPES })

    const resolved = await resolveAttributeMapperType(admin, 'google')

    expect(resolved).toEqual({
      id: 'google-user-attribute-mapper',
      sourceKey: 'jsonField',
      targetKey: 'userAttribute',
      supportsSyncMode: true,
    })
  })

  it('returns null when the provider offers no attribute importer', async () => {
    const { admin } = createMockAdmin({ types: NO_ATTRIBUTE_TYPES })

    expect(await resolveAttributeMapperType(admin, 'role-only')).toBeNull()
  })

  it('returns null instead of throwing when Keycloak cannot list types', async () => {
    const { admin } = createMockAdmin({ typesThrow: true })

    expect(await resolveAttributeMapperType(admin, 'broken')).toBeNull()
  })
})

describe('ensureIdpAttributeMappers', () => {
  it('creates every expected mapper with the resolved type and FORCE sync', async () => {
    const { admin, createdPayloads } = createMockAdmin()

    const result = await ensureIdpAttributeMappers(admin, 'hospital-oidc')

    expect(result.created).toEqual(SMART_IDP_ATTRIBUTE_MAPPERS.map(definition => definition.name))
    expect(result.skipped).toEqual([])
    expect(result.unsupported).toBe(false)
    expect(result.errors).toEqual([])

    expect(createdPayloads[0]?.alias).toBe('hospital-oidc')
    expect(createdPayloads[0]?.identityProviderMapper.identityProviderMapper).toBe('oidc-user-attribute-idp-mapper')
    expect(createdPayloads[0]?.identityProviderMapper.config).toEqual({
      claim: 'fhirUser',
      'user.attribute': 'fhirUser',
      syncMode: 'FORCE',
    })
  })

  it('omits syncMode for types that do not declare it', async () => {
    const { admin, createdPayloads } = createMockAdmin({ types: SAML_TYPES })

    await ensureIdpAttributeMappers(admin, 'hospital-saml')

    expect(createdPayloads[0]?.identityProviderMapper.config).toEqual({
      'attribute.name': 'fhirUser',
      'user.attribute': 'fhirUser',
    })
  })

  it('is idempotent: a correct mapper for the attribute is skipped even when renamed', async () => {
    const { admin, identityProviders } = createMockAdmin({
      mappers: [{
        id: 'existing',
        name: 'our-own-fhiruser-mapping',
        identityProviderMapper: 'oidc-user-attribute-idp-mapper',
        config: { claim: 'smart_fhir_user', 'user.attribute': 'fhirUser', syncMode: 'FORCE' },
      }],
    })

    const result = await ensureIdpAttributeMappers(admin, 'hospital-oidc')

    expect(result.skipped).toContain('fhirUser-import')
    expect(result.created).not.toContain('fhirUser-import')
    expect(identityProviders.updateMapper).not.toHaveBeenCalled()
    expect(identityProviders.createMapper).toHaveBeenCalledTimes(SMART_IDP_ATTRIBUTE_MAPPERS.length - 1)
  })

  it('repairs a mapper stuck on IMPORT instead of skipping it', async () => {
    // The production failure: fhirUser-import existed, so every check called the provider
    // healthy and every fix skipped it, while IMPORT meant the attribute was written once at
    // user creation and never refreshed. A member who signed in before their record existed
    // stayed without a fhirUser for good.
    const { admin, updatedPayloads } = createMockAdmin({
      mappers: [{
        id: 'stuck',
        name: 'fhirUser-import',
        identityProviderMapper: 'oidc-user-attribute-idp-mapper',
        config: { claim: 'fhirUser', 'user.attribute': 'fhirUser', syncMode: 'IMPORT' },
      }],
    })

    const result = await ensureIdpAttributeMappers(admin, 'hospital-oidc')

    expect(result.repaired).toContain('fhirUser-import')
    expect(result.skipped).not.toContain('fhirUser-import')
    expect(updatedPayloads[0]?.id).toBe('stuck')
    expect(updatedPayloads[0]?.config?.syncMode).toBe('FORCE')
  })

  it('keeps the admin-configured claim when repairing', async () => {
    // A provider may publish the reference under its own name. Rebuilding the mapper from the
    // definition would rewrite that to `fhirUser` and break a working federation, so only the
    // drifted key moves.
    const { admin, updatedPayloads } = createMockAdmin({
      mappers: [{
        id: 'renamed',
        name: 'our-own-fhiruser-mapping',
        identityProviderMapper: 'oidc-user-attribute-idp-mapper',
        config: { claim: 'smart_fhir_user', 'user.attribute': 'fhirUser', syncMode: 'IMPORT' },
      }],
    })

    await ensureIdpAttributeMappers(admin, 'hospital-oidc')

    expect(updatedPayloads[0]?.config?.claim).toBe('smart_fhir_user')
    expect(updatedPayloads[0]?.config?.syncMode).toBe('FORCE')
    expect(updatedPayloads[0]?.name).toBe('our-own-fhiruser-mapping')
  })

  it('leaves syncMode alone on a provider type that has none', async () => {
    // SAML's importer declares no syncMode, so demanding one would be a permanent false alarm.
    const { admin, identityProviders } = createMockAdmin({
      types: SAML_TYPES,
      mappers: [{
        id: 'saml-existing',
        name: 'fhirUser-import',
        identityProviderMapper: 'saml-user-attribute-idp-mapper',
        config: { 'attribute.name': 'fhirUser', 'user.attribute': 'fhirUser' },
      }],
    })

    const result = await ensureIdpAttributeMappers(admin, 'hospital-saml')

    expect(result.skipped).toContain('fhirUser-import')
    expect(identityProviders.updateMapper).not.toHaveBeenCalled()
  })

  it('provisions only required mappers when optional ones are excluded', async () => {
    const { admin } = createMockAdmin()

    const result = await ensureIdpAttributeMappers(admin, 'hospital-oidc', false)

    expect(result.created).toEqual(
      SMART_IDP_ATTRIBUTE_MAPPERS.filter(definition => definition.required).map(definition => definition.name),
    )
  })

  it('reports unsupported providers without creating anything', async () => {
    const { admin, identityProviders } = createMockAdmin({ types: NO_ATTRIBUTE_TYPES })

    const result = await ensureIdpAttributeMappers(admin, 'role-only')

    expect(result.unsupported).toBe(true)
    expect(result.created).toEqual([])
    expect(identityProviders.createMapper).not.toHaveBeenCalled()
  })

  it('provisions nothing on a client-assertion trust anchor', async () => {
    const { admin, identityProviders } = createMockAdmin({
      providerConfig: { supportsClientAssertions: 'true' },
    })

    const result = await ensureIdpAttributeMappers(admin, 'proxy-smart-signing')

    expect(result.userFacing).toBe(false)
    expect(result.created).toEqual([])
    expect(identityProviders.createMapper).not.toHaveBeenCalled()
  })

  it('collects per-mapper failures instead of aborting', async () => {
    const { admin } = createMockAdmin({ createThrows: true })

    const result = await ensureIdpAttributeMappers(admin, 'hospital-oidc')

    expect(result.created).toEqual([])
    expect(result.errors).toHaveLength(SMART_IDP_ATTRIBUTE_MAPPERS.length)
    expect(result.errors[0]).toContain('duplicate mapper name')
  })
})

describe('getIdpMapperStatus', () => {
  const provider = { alias: 'hospital-oidc', providerId: 'oidc', displayName: 'Hospital', enabled: true }

  it('flags a provider with no mappers as unhealthy and lists what is missing', async () => {
    const { admin } = createMockAdmin()

    const status = await getIdpMapperStatus(admin, provider)

    expect(status.healthy).toBe(false)
    expect(status.missingRequired).toEqual(['fhirUser-import'])
    expect(status.missingOptional).toEqual(['organization-import'])
    expect(status.attributeMapperType).toBe('oidc-user-attribute-idp-mapper')
    expect(status.unsupported).toBe(false)
  })

  it('is healthy once the required attribute is imported, optional gaps aside', async () => {
    const { admin } = createMockAdmin({
      mappers: [{
        id: 'm1',
        name: 'fhirUser-import',
        identityProviderMapper: 'oidc-user-attribute-idp-mapper',
        config: { claim: 'fhirUser', 'user.attribute': 'fhirUser', syncMode: 'FORCE' },
      }],
    })

    const status = await getIdpMapperStatus(admin, provider)

    expect(status.healthy).toBe(true)
    expect(status.missingRequired).toEqual([])
    expect(status.missingOptional).toEqual(['organization-import'])
    expect(status.mappers[0]?.externalName).toBe('fhirUser')
    expect(status.mappers[0]?.userAttribute).toBe('fhirUser')
    expect(status.misconfigured).toEqual([])
  })

  it('is UNHEALTHY when the required mapper exists but will not refresh', async () => {
    // Existence was once the whole check, so this exact provider reported healthy while
    // brokered users silently never had their fhirUser updated after first login.
    const { admin } = createMockAdmin({
      mappers: [{
        id: 'm1',
        name: 'fhirUser-import',
        identityProviderMapper: 'oidc-user-attribute-idp-mapper',
        config: { claim: 'fhirUser', 'user.attribute': 'fhirUser', syncMode: 'IMPORT' },
      }],
    })

    const status = await getIdpMapperStatus(admin, provider)

    expect(status.missingRequired).toEqual([])
    expect(status.healthy).toBe(false)
    expect(status.misconfigured).toEqual([
      { name: 'fhirUser-import', mapper: 'fhirUser-import', differences: ['syncMode is IMPORT, expected FORCE'] },
    ])
  })

  it('does not mark providers unhealthy when no attribute importer exists', async () => {
    const { admin } = createMockAdmin({ types: NO_ATTRIBUTE_TYPES })

    const status = await getIdpMapperStatus(admin, provider)

    expect(status.unsupported).toBe(true)
    expect(status.healthy).toBe(true)
  })

  it('exempts client-assertion trust anchors: no human logs in through them', async () => {
    const { admin } = createMockAdmin()

    const status = await getIdpMapperStatus(admin, {
      alias: 'proxy-smart-signing',
      providerId: 'oidc',
      enabled: true,
      config: { supportsClientAssertions: 'true' },
    })

    expect(status.userFacing).toBe(false)
    expect(status.healthy).toBe(true)
    expect(status.missingRequired).toEqual([])
    expect(status.missingOptional).toEqual([])
  })

  it('still expects imports on a hidden provider that is not a trust anchor', async () => {
    const { admin } = createMockAdmin()

    const status = await getIdpMapperStatus(admin, {
      ...provider,
      config: { hideOnLoginPage: 'true' },
    })

    expect(status.userFacing).toBe(true)
    expect(status.missingRequired).toEqual(['fhirUser-import'])
  })
})

describe('normalizeIdpMapper', () => {
  it('surfaces claim and attribute regardless of the mapper type config keys', () => {
    const normalized = normalizeIdpMapper({
      id: 'm1',
      name: 'social-import',
      identityProviderMapper: 'google-user-attribute-mapper',
      config: { jsonField: 'fhir_user', userAttribute: 'fhirUser', syncMode: 'IMPORT' },
    })

    expect(normalized.externalName).toBe('fhir_user')
    expect(normalized.userAttribute).toBe('fhirUser')
    expect(normalized.syncMode).toBe('IMPORT')
  })

  it('tolerates array-valued config entries and missing fields', () => {
    const normalized = normalizeIdpMapper({ config: { claim: ['fhirUser'] } })

    expect(normalized.name).toBe('')
    expect(normalized.identityProviderMapper).toBe('')
    expect(normalized.externalName).toBe('fhirUser')
    expect(normalized.userAttribute).toBeUndefined()
  })
})
