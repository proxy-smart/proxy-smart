// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Branding Schemas
 * 
 * TypeBox schemas for User-Access Brand admin configuration (SMART App Launch 2.2.0 Section 8).
 */

import { t, type Static } from 'elysia'
import { ValueSetRegistry } from '@max-health-inc/fhir-smart'
import { isValidUserAccessCategoryValueSetCode } from '@max-health-inc/fhir-smart/valuesets/ValueSet-UserAccessCategoryValueSet'
import type { UserAccessCategoryValueSetCode } from '@max-health-inc/fhir-smart/valuesets/ValueSet-UserAccessCategoryValueSet'
export { isValidUserAccessCategoryValueSetCode }

const { UserAccessCategoryValueSetCodes } = ValueSetRegistry.UserAccessCategoryValueSet

/**
 * Brand category (organization type) — codes from SMART App Launch IG 2.2.0 UserAccessCategory ValueSet
 */
export const BrandCategory = t.Union(
  UserAccessCategoryValueSetCodes.map(code => t.Literal(code)) as [ReturnType<typeof t.Literal>, ...ReturnType<typeof t.Literal>[]],
  { description: 'Organization category per FHIR organization-type CodeSystem (SMART App Launch IG 2.2.0)' }
)

export type BrandCategoryType = UserAccessCategoryValueSetCode

/** A further patient portal of the brand, published as its own organization-portal extension. */
export const BrandPortal = t.Object({
  name: t.String({ minLength: 1, description: 'Name users know the portal by' }),
  url: t.String({ pattern: '^https?://', description: 'Where users go to see their data and manage access' }),
  description: t.Optional(t.Union([t.String(), t.Null()], { description: 'Portal description (Markdown)' })),
  logoUrl: t.Optional(t.Union([t.String(), t.Null()], { description: 'Portal logo URL' })),
  logoLicenseUrl: t.Optional(t.Union([t.String(), t.Null()], { description: 'Portal logo license URL' })),
  serverIds: t.Optional(t.Array(t.String(), { description: 'FHIR server identifiers this portal serves. Omitted means every endpoint of the brand.' })),
}, { title: 'BrandPortal' })

export type BrandPortalType = Static<typeof BrandPortal>

export const DEFAULT_BRAND_IDENTIFIER_SYSTEM = 'urn:ietf:rfc:3986'

/**
 * Brand configuration (admin-editable settings)
 */
export const BrandConfig = t.Object({
  name: t.String({ description: 'Brand display name' }),
  website: t.String({ description: 'Brand website URL' }),
  logoUrl: t.Union([t.String(), t.Null()], { description: 'Brand logo URL (SVG or 1024px PNG, transparent background)' }),
  logoLicenseUrl: t.Union([t.String(), t.Null()], { description: 'Logo license URL' }),
  aliases: t.Array(t.String(), { description: 'Alternative brand names' }),
  category: BrandCategory,
  portalName: t.Union([t.String(), t.Null()], { description: 'Patient-facing portal name' }),
  portalUrl: t.Union([t.String(), t.Null()], { description: 'Patient-facing portal URL' }),
  portalDescription: t.Union([t.String(), t.Null()], { description: 'Patient-facing portal description (Markdown)' }),
  portalLogoUrl: t.Union([t.String(), t.Null()], { description: 'Patient-facing portal logo URL' }),
  portalLogoLicenseUrl: t.Union([t.String(), t.Null()], { description: 'Portal logo license URL' }),
  addressLine: t.Optional(t.Union([t.String(), t.Null()], { description: 'Street address; one line per address line' })),
  addressCity: t.Union([t.String(), t.Null()], { description: 'Organization city' }),
  addressState: t.Union([t.String(), t.Null()], { description: 'Organization state/province' }),
  addressPostalCode: t.Union([t.String(), t.Null()], { description: 'Organization postal code' }),
  addressCountry: t.Union([t.String(), t.Null()], { description: 'Organization country' }),
  identifier: t.String({ description: 'Brand identifier value, advertised as user_access_brand_identifier (typically the brand website URL)' }),
  identifierSystem: t.Optional(t.String({ minLength: 1, description: `Brand identifier system. Defaults to ${DEFAULT_BRAND_IDENTIFIER_SYSTEM}.` })),
  developerUrl: t.Optional(t.Union([t.String({ pattern: '^https://' }), t.Null()], { description: 'https URL where app developers configure access to the endpoints (Endpoint.contact). Defaults to the proxy app registration docs.' })),
  additionalPortals: t.Optional(t.Array(BrandPortal, { description: 'Further patient portals, each published as its own organization-portal extension' })),
  loginTheme: t.Union([t.String(), t.Null()], { description: 'Keycloak login theme name (e.g. keycloak, keycloak.v2)' }),
  appStoreUrl: t.Union([t.String(), t.Null()], { description: 'External App Store URL (e.g. https://apps.example.com). When set, /apps redirects here instead of serving locally.' }),
  // UI-theming extension (NOT part of the SMART User-access Brand / branding.json).
  // A CSS colour (hex or any CSS <color>) used to theme auth surfaces (login, patient
  // picker) via a runtime --primary/--maxhealth override on the brandc contract.
  primaryColor: t.Optional(t.Union([t.String(), t.Null()], { description: 'Brand primary colour (CSS <color>, e.g. #00d294) for theming auth surfaces. Not published in branding.json.' })),
  accentColor: t.Optional(t.Union([t.String(), t.Null()], { description: 'Optional brand accent colour (CSS <color>). Not published in branding.json.' })),
}, { title: 'BrandConfig' })

export type BrandConfigType = Omit<Static<typeof BrandConfig>, 'category'> & { category: BrandCategoryType }

/**
 * Brand config update response
 */
export const BrandConfigUpdateResponse = t.Object({
  message: t.String(),
  config: BrandConfig,
  timestamp: t.String(),
}, { title: 'BrandConfigUpdateResponse' })

export type BrandConfigUpdateResponseType = Static<typeof BrandConfigUpdateResponse>

/**
 * Partial brand config for per-organization overrides.
 * Every field is optional — unset fields cascade to realm-level defaults.
 */
export const OrgBrandConfig = t.Partial(BrandConfig, { title: 'OrgBrandConfig' })
export type OrgBrandConfigType = Partial<BrandConfigType>

export const OrgBrandConfigResponse = t.Object({
  message: t.String(),
  orgId: t.String(),
  config: OrgBrandConfig,
  timestamp: t.String(),
}, { title: 'OrgBrandConfigResponse' })

export type OrgBrandConfigResponseType = Static<typeof OrgBrandConfigResponse>
