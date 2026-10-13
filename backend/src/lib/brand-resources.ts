// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** The Organization and Endpoint resources of the User-access Brand Bundle (SMART App Launch 2.2, brands.html). */

import type { Address, Extension, Identifier, Reference } from 'fhir/r4'
import { ValueSetRegistry } from '@max-health-inc/fhir-smart'
import type {
  EndpointFhirVersion,
  OrganizationBrand,
  OrganizationPortal,
  UserAccessBrand,
  UserAccessEndpoint,
} from '@max-health-inc/fhir-smart'
import { config } from '@/config'
import { DEFAULT_BRAND_IDENTIFIER_SYSTEM, type BrandConfigType } from '@/schemas'
import { fhirVersionToSemver } from './fhir-utils'
import { logger } from './logger'

export const PRIMARY_BRAND_ID = 'primary-brand'
export const ORGANIZATION_BRAND_URL = 'http://hl7.org/fhir/StructureDefinition/organization-brand'
export const ORGANIZATION_PORTAL_URL = 'http://hl7.org/fhir/StructureDefinition/organization-portal'
export const ENDPOINT_FHIR_VERSION_URL = 'http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version'
const DEVELOPER_DOCS_PATH = '/docs/admin-ui/smart-apps'

export interface BrandServer {
  identifier: string
  name: string
  fhirVersion: string
  organizationIds?: string[]
}

export type BrandResource = UserAccessBrand | UserAccessEndpoint

export interface BrandBundleEntry {
  fullUrl: string
  resource: BrandResource
}

export interface BrandIdentifier {
  system: string
  value: string
}

/** The identifier `.well-known/smart-configuration` advertises; it names the primary Organization only. */
export function brandIdentifier(brand: BrandConfigType): BrandIdentifier {
  return { system: brand.identifierSystem || DEFAULT_BRAND_IDENTIFIER_SYSTEM, value: brand.identifier }
}

/** Endpoint.contact configuration-url: where app developers configure access. */
export function developerConfigurationUrl(brand: BrandConfigType): string {
  return brand.developerUrl || `${config.baseUrl}${DEVELOPER_DOCS_PATH}`
}

const endpointReference = (server: BrandServer): Reference => ({ reference: `Endpoint/endpoint-${server.identifier}` })
const fullUrl = (resourceType: string, id: string): string => `${config.baseUrl}/branding/${resourceType}/${id}`

export function buildEndpoint(server: BrandServer, brand: BrandConfigType): UserAccessEndpoint {
  const versionExtension: EndpointFhirVersion = {
    url: ENDPOINT_FHIR_VERSION_URL,
    valueCode: fhirVersionToSemver(server.fhirVersion),
  }
  return {
    resourceType: 'Endpoint',
    id: `endpoint-${server.identifier}`,
    status: 'active',
    name: `${server.name}, ${brand.name} (FHIR ${server.fhirVersion})`,
    address: `${config.baseUrl}/${config.name}/${server.identifier}/${server.fhirVersion}`,
    connectionType: {
      system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type',
      code: 'hl7-fhir-rest',
    },
    extension: [versionExtension],
    contact: [{ system: 'url', value: developerConfigurationUrl(brand) }],
    payloadType: [{
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/endpoint-payload-type', code: 'none' }],
    }],
  }
}

interface PortalDetails {
  name?: string | null
  description?: string | null
  url?: string | null
  logoUrl?: string | null
  logoLicenseUrl?: string | null
  endpoints: Reference[]
}

function portalExtension(portal: PortalDetails): OrganizationPortal | null {
  const parts: Extension[] = [
    ...(portal.name ? [{ url: 'portalName', valueString: portal.name }] : []),
    ...(portal.description ? [{ url: 'portalDescription', valueMarkdown: portal.description }] : []),
    ...(portal.url ? [{ url: 'portalUrl', valueUrl: portal.url }] : []),
    ...(portal.logoUrl ? [{ url: 'portalLogo', valueUrl: portal.logoUrl }] : []),
    ...(portal.logoLicenseUrl ? [{ url: 'portalLogoLicense', valueUrl: portal.logoLicenseUrl }] : []),
    ...portal.endpoints.map((reference) => ({ url: 'portalEndpoint', valueReference: reference })),
  ]
  return parts.length > 0 ? { url: ORGANIZATION_PORTAL_URL, extension: parts } : null
}

/** Brand logo and its license. brandBundle is left out: it links to a different bundle, never this one. */
function brandExtension(brand: BrandConfigType): OrganizationBrand | null {
  const parts: Extension[] = [
    ...(brand.logoUrl ? [{ url: 'brandLogo', valueUrl: brand.logoUrl }] : []),
    ...(brand.logoLicenseUrl ? [{ url: 'brandLogoLicense', valueUrl: brand.logoLicenseUrl }] : []),
  ]
  return parts.length > 0 ? { url: ORGANIZATION_BRAND_URL, extension: parts } : null
}

function brandAddress(brand: BrandConfigType): Address[] {
  const line = (brand.addressLine ?? '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean)
  const address: Address = {
    ...(line.length > 0 && { line }),
    ...(brand.addressCity && { city: brand.addressCity }),
    ...(brand.addressState && { state: brand.addressState }),
    ...(brand.addressPostalCode && { postalCode: brand.addressPostalCode }),
    ...(brand.addressCountry && { country: brand.addressCountry }),
  }
  return Object.keys(address).length > 0 ? [address] : []
}

/** The primary portal plus every additional one; each additional portal may narrow to its own servers. */
function brandPortals(brand: BrandConfigType, servers: BrandServer[]): OrganizationPortal[] {
  const primary: PortalDetails = {
    name: brand.portalName,
    description: brand.portalDescription,
    url: brand.portalUrl,
    logoUrl: brand.portalLogoUrl,
    logoLicenseUrl: brand.portalLogoLicenseUrl,
    endpoints: servers.map(endpointReference),
  }
  const additional = (brand.additionalPortals ?? []).map((portal): PortalDetails => ({
    ...portal,
    endpoints: servers
      .filter((server) => !portal.serverIds || portal.serverIds.includes(server.identifier))
      .map(endpointReference),
  }))
  return [primary, ...additional].flatMap((portal) => portalExtension(portal) ?? [])
}

interface OrganizationInput {
  id: string
  brand: BrandConfigType
  servers: BrandServer[]
  identifiers: Identifier[]
  partOfId?: string
}

export function buildOrganization({ id, brand, servers, identifiers, partOfId }: OrganizationInput): UserAccessBrand {
  const category = ValueSetRegistry.UserAccessCategoryValueSet.getUserAccessCategoryValueSetConcept(brand.category)
  const address = brandAddress(brand)
  const logo = brandExtension(brand)
  return {
    resourceType: 'Organization',
    id,
    active: true,
    name: brand.name,
    ...(brand.aliases.length > 0 && { alias: brand.aliases }),
    type: [{
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/organization-type',
        code: brand.category,
        display: category?.display || brand.category,
      }],
    }],
    extension: [...(logo ? [logo] : []), ...brandPortals(brand, servers)],
    ...(identifiers.length > 0 && { identifier: identifiers }),
    telecom: [{ system: 'url', value: brand.website }],
    ...(address.length > 0 && { address }),
    ...(partOfId && { partOf: { reference: `Organization/${partOfId}` } }),
    endpoint: servers.map(endpointReference),
  }
}

const identifierKey = (identifier: BrandIdentifier): string => `${identifier.system}|${identifier.value}`

/**
 * An organization brand never inherits the primary identifier: it is identified by its own
 * identifier or website, or not at all, so the advertised identifier matches exactly one Organization.
 */
function organizationIdentifiers(
  orgId: string,
  brand: BrandConfigType,
  overrides: Partial<BrandConfigType>,
  taken: Set<string>,
): Identifier[] {
  const value = overrides.identifier || overrides.website
  if (!value) return []
  const identifier = { system: overrides.identifierSystem || brandIdentifier(brand).system, value }
  if (taken.has(identifierKey(identifier))) {
    logger.warn('brand-bundle', `Organization brand ${orgId} repeats an identifier already used in the bundle; omitting it`)
    return []
  }
  taken.add(identifierKey(identifier))
  return [identifier]
}

export interface BrandSources {
  brand: BrandConfigType
  servers: BrandServer[]
  orgBrands: ReadonlyMap<string, Partial<BrandConfigType>>
}

export function buildBrandEntries({ brand, servers, orgBrands }: BrandSources): BrandBundleEntry[] {
  const primaryIdentifier = brandIdentifier(brand)
  const taken = new Set([identifierKey(primaryIdentifier)])
  const entries: BrandBundleEntry[] = [
    {
      fullUrl: fullUrl('Organization', PRIMARY_BRAND_ID),
      resource: buildOrganization({ id: PRIMARY_BRAND_ID, brand, servers, identifiers: [primaryIdentifier] }),
    },
    ...servers.map((server) => ({
      fullUrl: fullUrl('Endpoint', `endpoint-${server.identifier}`),
      resource: buildEndpoint(server, brand),
    })),
  ]

  for (const [orgId, overrides] of orgBrands) {
    const id = `org-${orgId}`
    const orgServers = servers.filter((server) => !server.organizationIds?.length || server.organizationIds.includes(orgId))
    entries.push({
      fullUrl: fullUrl('Organization', id),
      resource: buildOrganization({
        id,
        brand: { ...brand, ...overrides },
        servers: orgServers,
        identifiers: organizationIdentifiers(orgId, brand, overrides, taken),
        partOfId: PRIMARY_BRAND_ID,
      }),
    })
  }
  return entries
}
