// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Partial per-organization brand overrides, stored as `brand_settings.*` Keycloak organization attributes. */

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type { BrandConfigType } from '@/schemas'
import { logger } from './logger'
import { config } from '@/config'
import { getAdminClient } from './kc-admin-factory'
import { getAttr } from './keycloak-component-config'
import { safeCssColor } from './brand-color'
import { BRAND_PREFIX, brandToAttributes, parseBrandAttributes } from './brand-attributes'

const orgBrandCache = new Map<string, Partial<BrandConfigType>>()

export function getAllOrgBrands(): Map<string, Partial<BrandConfigType>> {
  return orgBrandCache
}

/** Parse partial brand config from KC org attributes (`Record<string, string[]>`). */
export function parseOrgBrandAttributes(attrs: Record<string, unknown> | undefined): Partial<BrandConfigType> {
  return parseBrandAttributes((key) => getAttr(attrs, key))
}

/** Convert partial brand config to KC org attributes format (`Record<string, string[]>`). */
export function brandToOrgAttributes(settings: Partial<BrandConfigType>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(brandToAttributes(settings)).map(([key, value]) => [key, [value]]))
}

export async function getOrgBranding(admin: KcAdminClient, orgId: string): Promise<Partial<BrandConfigType>> {
  const org = await admin.organizations.findOne({ id: orgId })
  if (!org) throw new Error(`Organization ${orgId} not found`)
  const overrides = parseOrgBrandAttributes(org.attributes)
  if (Object.keys(overrides).length > 0) {
    orgBrandCache.set(orgId, overrides)
  } else {
    orgBrandCache.delete(orgId)
  }
  return overrides
}

/** Replaces every `brand_settings.*` attribute and keeps the organization's other attributes. */
export async function saveOrgBranding(
  admin: KcAdminClient,
  orgId: string,
  settings: Partial<BrandConfigType>,
): Promise<void> {
  const org = await admin.organizations.findOne({ id: orgId })
  if (!org) throw new Error(`Organization ${orgId} not found`)

  const existingAttrs = org.attributes ?? {}

  const cleaned: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(existingAttrs)) {
    if (!k.startsWith(BRAND_PREFIX)) cleaned[k] = v
  }

  const brandAttrs = brandToOrgAttributes(settings)
  const merged = { ...cleaned, ...brandAttrs }

  await admin.organizations.updateById(
    { id: orgId },
    { ...org, attributes: merged },
  )

  if (Object.keys(settings).length > 0) {
    orgBrandCache.set(orgId, settings)
  } else {
    orgBrandCache.delete(orgId)
  }

  logger.admin.info('Org branding saved', { orgId, name: settings.name })
}

export async function loadAllOrgBrands(admin: KcAdminClient): Promise<void> {
  try {
    const orgs = await admin.organizations.find({ max: 500 })
    orgBrandCache.clear()
    for (const org of orgs) {
      if (!org.id || !org.attributes) continue
      const overrides = parseOrgBrandAttributes(org.attributes)
      if (Object.keys(overrides).length > 0) {
        orgBrandCache.set(org.id, overrides)
      }
    }
    logger.admin.info('Org brand overrides loaded', { count: orgBrandCache.size })
  } catch (error) {
    logger.admin.warn('Failed to load org brand overrides', { error })
  }
}

/** Global brand colours with the client's first organization override; never throws, and re-validates stored colours. */
export async function resolveClientBrandColors(
  clientId: string | undefined,
): Promise<{ primaryColor: string | null; accentColor: string | null }> {
  const colours = {
    primaryColor: safeCssColor(config.brand.primaryColor),
    accentColor: safeCssColor(config.brand.accentColor),
  }
  if (!clientId) return colours

  try {
    const admin = await getAdminClient()
    if (!admin) return colours
    const clients = await admin.clients.find({ clientId })
    const orgIds = getAttr(clients[0]?.attributes, 'organization_ids')?.split(',').filter(Boolean)
    if (!orgIds || orgIds.length === 0) return colours

    const orgBrand = await getOrgBranding(admin, orgIds[0])
    const primary = safeCssColor(orgBrand.primaryColor)
    const accent = safeCssColor(orgBrand.accentColor)
    if (primary) colours.primaryColor = primary
    if (accent) colours.accentColor = accent
  } catch (err) {
    logger.auth.debug('brand colours: per-org resolution failed, using global brand', {
      clientId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return colours
}
