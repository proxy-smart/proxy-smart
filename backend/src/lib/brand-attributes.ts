// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isValidUserAccessCategoryValueSetCode } from '@max-health-inc/fhir-smart/valuesets/ValueSet-UserAccessCategoryValueSet'
import { Value } from '@sinclair/typebox/value'
import { t } from 'elysia'
import { BrandPortal, type BrandConfigType, type BrandPortalType } from '@/schemas'
import { logger } from './logger'

export const BRAND_PREFIX = 'brand_settings.'

type FieldKeys = readonly (readonly [keyof BrandConfigType, string])[]

const TEXT_FIELDS = [
  ['name', 'name'],
  ['website', 'website'],
  ['identifier', 'identifier'],
  ['identifierSystem', 'identifier_system'],
] as const satisfies FieldKeys

const NULLABLE_FIELDS = [
  ['logoUrl', 'logo_url'],
  ['logoLicenseUrl', 'logo_license_url'],
  ['primaryColor', 'primary_color'],
  ['accentColor', 'accent_color'],
  ['portalName', 'portal_name'],
  ['portalUrl', 'portal_url'],
  ['portalDescription', 'portal_description'],
  ['portalLogoUrl', 'portal_logo_url'],
  ['portalLogoLicenseUrl', 'portal_logo_license_url'],
  ['addressLine', 'address_line'],
  ['addressCity', 'address_city'],
  ['addressState', 'address_state'],
  ['addressPostalCode', 'address_postal_code'],
  ['addressCountry', 'address_country'],
  ['appStoreUrl', 'app_store_url'],
  ['developerUrl', 'developer_url'],
] as const satisfies FieldKeys

const ALIASES_KEY = 'aliases'
const CATEGORY_KEY = 'category'
const PORTALS_KEY = 'additional_portals'

const BrandPortals = t.Array(BrandPortal)

/** Additional portals stored as JSON; anything that does not match the schema is ignored with a warning. */
export function parseBrandPortals(raw: string | undefined): BrandPortalType[] | undefined {
  if (raw === undefined || raw.trim() === '') return raw === undefined ? undefined : []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (Value.Check(BrandPortals, parsed)) return parsed
  logger.warn('branding', 'Ignoring additional portals that are not a valid BrandPortal array')
  return undefined
}

export function hasBrandAttributes(keys: Iterable<string>): boolean {
  for (const key of keys) if (key.startsWith(BRAND_PREFIX)) return true
  return false
}

/** Parse partial brand config from Keycloak attributes, given a reader for one attribute's value. */
export function parseBrandAttributes(read: (key: string) => string | undefined): Partial<BrandConfigType> {
  const get = (key: string) => read(`${BRAND_PREFIX}${key}`)
  const result: Partial<BrandConfigType> = {}

  for (const [field, key] of TEXT_FIELDS) {
    const value = get(key)
    if (value !== undefined) result[field] = value
  }
  for (const [field, key] of NULLABLE_FIELDS) {
    const value = get(key)
    if (value !== undefined) result[field] = value || null
  }

  const aliases = get(ALIASES_KEY)
  if (aliases !== undefined) result.aliases = aliases.split(',').map((s) => s.trim()).filter(Boolean)

  const portals = parseBrandPortals(get(PORTALS_KEY))
  if (portals !== undefined) result.additionalPortals = portals

  const category = get(CATEGORY_KEY)
  if (category !== undefined) {
    if (isValidUserAccessCategoryValueSetCode(category)) result.category = category
    else logger.warn('branding', `Invalid brand category '${category}', ignoring`)
  }

  return result
}

/** Convert partial brand config to flat Keycloak attributes; undefined fields are omitted. */
export function brandToAttributes(settings: Partial<BrandConfigType>): Record<string, string> {
  const attrs: Record<string, string> = {}
  const set = (key: string, value: string) => { attrs[`${BRAND_PREFIX}${key}`] = value }

  for (const [field, key] of TEXT_FIELDS) {
    const value = settings[field]
    if (value !== undefined) set(key, value)
  }
  for (const [field, key] of NULLABLE_FIELDS) {
    const value = settings[field]
    if (value !== undefined) set(key, value ?? '')
  }
  if (settings.aliases !== undefined) set(ALIASES_KEY, settings.aliases.join(','))
  if (settings.category !== undefined) set(CATEGORY_KEY, settings.category)
  if (settings.additionalPortals !== undefined) set(PORTALS_KEY, JSON.stringify(settings.additionalPortals))

  return attrs
}
