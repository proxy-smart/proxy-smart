// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * User-Access Brand Bundle Service
 * SMART App Launch 2.2.0 Section 8
 * 
 * Generates a FHIR Bundle (type: collection) containing:
 * - Organization resource with organization-brand and organization-portal extensions
 * - Endpoint resources for each registered FHIR server
 * 
 * Published at /branding.json and referenced from .well-known/smart-configuration
 */

import { config } from '../config'
import { getAllServers, ensureServersInitialized } from './fhir-server-store'
import { fhirVersionToSemver } from './fhir-utils'
import { getRuntimeBrandConfig } from './runtime-config'
import { getAllOrgBrands } from './org-branding'
import { logger } from './logger'
import type { UserAccessBrandBundleType } from '../schemas'
import type { UserAccessEndpoint, UserAccessBrand, UserAccessBrandsBundle, UserAccessEndpointConnectionType, UserAccessEndpointPayloadTypeCoding, EndpointFhirVersion, OrganizationBrand, OrganizationPortal } from '@max-health-inc/fhir-smart'
import { ValueSetRegistry, validateUserAccessBrandsBundle, validateUserAccessBrand, validateUserAccessEndpoint, validateOrganizationBrand, validateOrganizationPortal, validateEndpointFhirVersion } from '@max-health-inc/fhir-smart'
import type { ContactPointSystemCode } from '@max-health-inc/fhir-smart/valuesets/ValueSet-ContactPointSystem'
import type { BundleTypeCode } from '@max-health-inc/fhir-smart/valuesets/ValueSet-BundleType'
import type { Address, Endpoint } from 'fhir/r4'

interface BrandBundleCache {
  bundle: UserAccessBrandBundleType
  timestamp: number
  etag: string
}

class BrandBundleService {
  private cache: BrandBundleCache | null = null
  private readonly cacheTTL = 60_000 // 1 minute

  /** Get or build the Brand Bundle, with caching */
  async getBrandBundle(): Promise<{ bundle: UserAccessBrandBundleType; etag: string }> {
    const now = Date.now()
    if (this.cache && (now - this.cache.timestamp) < this.cacheTTL) {
      return { bundle: this.cache.bundle, etag: this.cache.etag }
    }

    const bundle = await this.buildBrandBundle()
    const etag = `W/"${bundle.timestamp}"`
    this.cache = { bundle, timestamp: now, etag }
    return { bundle, etag }
  }

  /** Invalidate cache (e.g. after admin updates brand settings) */
  clearCache(): void {
    this.cache = null
  }

  /** Build the full FHIR Brand Bundle from config + registered FHIR servers */
  private async buildBrandBundle(): Promise<UserAccessBrandBundleType> {
    await ensureServersInitialized()
    const servers = await getAllServers()
    const brand = getRuntimeBrandConfig()
    const orgId = 'primary-brand'
    const entries: UserAccessBrandBundleType['entry'] = []

    // Build Endpoint resources from registered FHIR servers
    const endpointRefs: Array<{ reference: string }> = []
    const serverEndpointMap = new Map<string, { ref: { reference: string }; orgIds?: string[] }>()
    for (const server of servers) {
      const endpointId = `endpoint-${server.identifier}`
      const proxyBase = `${config.baseUrl}/${config.name}/${server.identifier}/${server.metadata.fhirVersion}`

      entries.push({
        fullUrl: `${config.baseUrl}/branding/Endpoint/${endpointId}`,
        resource: this.buildEndpoint(endpointId, server.name, proxyBase, server.metadata.fhirVersion, brand)
      })
      const ref = { reference: `Endpoint/${endpointId}` }
      endpointRefs.push(ref)
      serverEndpointMap.set(server.identifier, { ref, orgIds: server.organizationIds })
    }

    // Build Organization resource (the primary Brand) — includes ALL endpoints
    entries.unshift({
      fullUrl: `${config.baseUrl}/branding/Organization/${orgId}`,
      resource: this.buildOrganization(orgId, endpointRefs, brand)
    })

    // Build per-org Organization resources (brand overrides merged with realm defaults)
    // Each org only gets endpoints for servers assigned to it (or unscoped servers available to all)
    const orgBrands = getAllOrgBrands()
    for (const [kcOrgId, overrides] of orgBrands) {
      const merged = { ...brand, ...overrides }
      const orgResourceId = `org-${kcOrgId}`

      // Filter endpoint refs: include servers that either have no org restriction or include this org
      const orgEndpointRefs = Array.from(serverEndpointMap.values())
        .filter(({ orgIds }) => !orgIds || orgIds.length === 0 || orgIds.includes(kcOrgId))
        .map(({ ref }) => ref)

      entries.push({
        fullUrl: `${config.baseUrl}/branding/Organization/${orgResourceId}`,
        resource: this.buildOrganization(orgResourceId, orgEndpointRefs, merged, orgId)
      })
    }

    const bundle: UserAccessBrandBundleType = {
      resourceType: 'Bundle',
      id: 'user-access-brands',
      type: 'collection' satisfies BundleTypeCode,
      timestamp: new Date().toISOString(),
      entry: entries
    }

    // Validate against SMART App Launch IG constraints
    await this.validateBundle(bundle, entries)

    return bundle
  }

  /** Validate the brand bundle and its entries against SMART App Launch IG FHIRPath constraints */
  private async validateBundle(bundle: UserAccessBrandBundleType, entries: UserAccessBrandBundleType['entry']): Promise<void> {
    const { errors, warnings } = await validateUserAccessBrandsBundle(bundle as unknown as UserAccessBrandsBundle)
    for (const w of warnings) logger.debug('brand-bundle', `validation warning: ${w}`)
    if (errors.length > 0) {
      logger.warn('brand-bundle', `bundle validation errors: ${errors.join('; ')}`)
    }

    for (const entry of entries) {
      const resource = entry.resource as Record<string, unknown>
      if (resource.resourceType === 'Endpoint') {
        const result = await validateUserAccessEndpoint(resource as unknown as UserAccessEndpoint)
        for (const w of result.warnings) logger.debug('brand-bundle', `Endpoint validation warning: ${w}`)
        if (result.errors.length > 0) {
          logger.warn('brand-bundle', `Endpoint ${resource.id} validation errors: ${result.errors.join('; ')}`)
        }
        // Validate extension sub-resources
        const extensions = (resource as unknown as UserAccessEndpoint).extension
        if (extensions) {
          for (const ext of extensions) {
            if (ext.url === 'http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version') {
              const extResult = await validateEndpointFhirVersion(ext as EndpointFhirVersion)
              if (extResult.errors.length > 0) {
                logger.warn('brand-bundle', `EndpointFhirVersion validation errors: ${extResult.errors.join('; ')}`)
              }
            }
          }
        }
      } else if (resource.resourceType === 'Organization') {
        const result = await validateUserAccessBrand(resource as unknown as UserAccessBrand)
        for (const w of result.warnings) logger.debug('brand-bundle', `Organization validation warning: ${w}`)
        if (result.errors.length > 0) {
          logger.warn('brand-bundle', `Organization ${resource.id} validation errors: ${result.errors.join('; ')}`)
        }
        // Validate extension sub-resources
        const extensions = (resource as unknown as UserAccessBrand).extension
        if (extensions) {
          for (const ext of extensions) {
            if (ext.url === 'http://hl7.org/fhir/StructureDefinition/organization-brand') {
              const extResult = await validateOrganizationBrand(ext as OrganizationBrand)
              if (extResult.errors.length > 0) {
                logger.warn('brand-bundle', `OrganizationBrand validation errors: ${extResult.errors.join('; ')}`)
              }
            } else if (ext.url === 'http://hl7.org/fhir/StructureDefinition/organization-portal') {
              const extResult = await validateOrganizationPortal(ext as OrganizationPortal)
              if (extResult.errors.length > 0) {
                logger.warn('brand-bundle', `OrganizationPortal validation errors: ${extResult.errors.join('; ')}`)
              }
            }
          }
        }
      }
    }
  }

  /** Build a User Access Endpoint FHIR resource */
  private buildEndpoint(
    id: string,
    name: string,
    address: string,
    fhirVersion: string,
    brand: ReturnType<typeof getRuntimeBrandConfig>
  ): UserAccessEndpoint {
    return {
      resourceType: 'Endpoint',
      id,
      status: 'active' as Endpoint['status'],
      name: `${name}, ${brand.name} (FHIR ${fhirVersion})`,
      address,
      connectionType: {
        system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type',
        code: 'hl7-fhir-rest'
      } satisfies UserAccessEndpointConnectionType,
      extension: [{
        url: 'http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version',
        valueCode: fhirVersionToSemver(fhirVersion)
      } satisfies EndpointFhirVersion],
      contact: [{
        system: 'url' as ContactPointSystemCode,
        value: brand.website
      }],
      payloadType: [{
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/endpoint-payload-type',
          code: 'none'
        } satisfies UserAccessEndpointPayloadTypeCoding]
      }]
    }
  }

  /** Build the User Access Brand (Organization) FHIR resource */
  private buildOrganization(
    id: string,
    endpointRefs: Array<{ reference: string }>,
    brand: ReturnType<typeof getRuntimeBrandConfig>,
    partOfId?: string,
  ): UserAccessBrand {
    const extensions: UserAccessBrand['extension'] = []

    // organization-brand extension (OrganizationBrand profile)
    const brandExtParts: OrganizationBrand['extension'] = []
    if (brand.logoUrl) {
      brandExtParts.push({ url: 'brandLogo', valueUrl: brand.logoUrl })
    }
    if (brand.logoLicenseUrl) {
      brandExtParts.push({ url: 'brandLogoLicense', valueUrl: brand.logoLicenseUrl })
    }
    brandExtParts.push({ url: 'brandBundle', valueUrl: `${config.baseUrl}/branding.json` })

    const brandExt: OrganizationBrand = {
      url: 'http://hl7.org/fhir/StructureDefinition/organization-brand',
      extension: brandExtParts
    }
    extensions.push(brandExt)

    // organization-portal extension (OrganizationPortal profile)
    const portalExtParts: OrganizationPortal['extension'] = []
    if (brand.portalName) {
      portalExtParts.push({ url: 'portalName', valueString: brand.portalName })
    }
    if (brand.portalDescription) {
      portalExtParts.push({ url: 'portalDescription', valueMarkdown: brand.portalDescription })
    }
    if (brand.portalUrl) {
      portalExtParts.push({ url: 'portalUrl', valueUrl: brand.portalUrl })
    }
    if (brand.portalLogoUrl) {
      portalExtParts.push({ url: 'portalLogo', valueUrl: brand.portalLogoUrl })
    }
    if (brand.portalLogoLicenseUrl) {
      portalExtParts.push({ url: 'portalLogoLicense', valueUrl: brand.portalLogoLicenseUrl })
    }
    for (const ref of endpointRefs) {
      portalExtParts.push({ url: 'portalEndpoint', valueReference: ref })
    }

    if (portalExtParts.length > 0) {
      const portalExt: OrganizationPortal = {
        url: 'http://hl7.org/fhir/StructureDefinition/organization-portal',
        extension: portalExtParts
      }
      extensions.push(portalExt)
    }

    // Build address if any address fields configured
    const address: Address[] = []
    if (brand.addressCity || brand.addressState || brand.addressPostalCode) {
      const addr: Address = {}
      if (brand.addressCity) addr.city = brand.addressCity
      if (brand.addressState) addr.state = brand.addressState
      if (brand.addressPostalCode) addr.postalCode = brand.addressPostalCode
      if (brand.addressCountry) addr.country = brand.addressCountry
      address.push(addr)
    }

    // Look up display name from the IG ValueSet
    const categoryConcept = ValueSetRegistry.UserAccessCategoryValueSet.getUserAccessCategoryValueSetConcept(brand.category)

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
          display: categoryConcept?.display || brand.category
        }]
      }],
      extension: extensions,
      identifier: [{
        system: 'urn:ietf:rfc:3986',
        value: brand.identifier
      }],
      telecom: [{
        system: 'url',
        value: brand.website
      }],
      ...(address.length > 0 && { address }),
      ...(partOfId && { partOf: { reference: `Organization/${partOfId}` } }),
      endpoint: endpointRefs
    }
  }

}

export const brandBundleService = new BrandBundleService()
