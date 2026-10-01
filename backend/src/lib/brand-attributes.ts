// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isValidUserAccessCategoryValueSetCode } from '@max-health-inc/fhir-smart/valuesets/ValueSet-UserAccessCategoryValueSet'
import type { BrandConfigType } from '@/schemas'
import { logger } from './logger'

export const BRAND_PREFIX = 'brand_settings.'

type FieldKeys = readonly (readonly [keyof BrandConfigType, string])[]

const TEXT_FIELDS = [
  ['name', 'name'],
  ['website', 'website'],
  ['identifier', 'identifier'],
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
  ['addressCity', 'address_city'],
  ['addressState', 'address_state'],
  ['addressPostalCode', 'address_postal_code'],
  ['addressCountry', 'address_country'],
  ['appStoreUrl', 'app_store_url'],
] as const satisfies FieldKeys

const ALIASES_KEY = 'aliases'
const CATEGORY_KEY = 'category'

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

  return attrs
}
