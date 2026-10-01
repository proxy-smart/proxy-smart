// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Organization Branding Utilities
 * 
 * Reads/writes brand override settings from Keycloak organization attributes.
 * Uses the same `brand_settings.*` prefix as realm-level branding,
 * but stored in the KC organization's attributes map.
 * 
 * All fields are optional (partial overrides). Missing fields cascade to realm defaults.
 */

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type { BrandConfigType } from '@/schemas'
import { logger } from './logger'
import { config } from '@/config'
import { getAdminClient } from './kc-admin-factory'
import { getAttr } from './keycloak-component-config'
import { safeCssColor } from './brand-color'
import { BRAND_PREFIX, brandToAttributes, parseBrandAttributes } from './brand-attributes'

// ─── In-memory cache for org brand overrides ────────────────────────
// Populated by admin save operations and initial load
const orgBrandCache = new Map<string, Partial<BrandConfigType>>()

/** Get all cached org brand overrides (for brand bundle generation) */
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

/**
 * Read org brand overrides from Keycloak and update cache.
 */
export async function getOrgBranding(admin: KcAdminClient, orgId: string): Promise<Partial<BrandConfigType>> {
  const org = await admin.organizations.findOne({ id: orgId })
  if (!org) throw new Error(`Organization ${orgId} not found`)
  const overrides = parseOrgBrandAttributes(org.attributes)
  // Update cache
  if (Object.keys(overrides).length > 0) {
    orgBrandCache.set(orgId, overrides)
  } else {
    orgBrandCache.delete(orgId)
  }
  return overrides
}

/**
 * Save org brand overrides to Keycloak organization attributes and update cache.
 * Merges brand_settings.* keys with existing non-brand attributes.
 */
export async function saveOrgBranding(
  admin: KcAdminClient,
  orgId: string,
  settings: Partial<BrandConfigType>,
): Promise<void> {
  const org = await admin.organizations.findOne({ id: orgId })
  if (!org) throw new Error(`Organization ${orgId} not found`)

  const existingAttrs = org.attributes ?? {}

  // Remove old brand_settings.* keys, then merge new ones
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

  // Update cache
  if (Object.keys(settings).length > 0) {
    orgBrandCache.set(orgId, settings)
  } else {
    orgBrandCache.delete(orgId)
  }

  logger.admin.info('Org branding saved', { orgId, name: settings.name })
}

/**
 * Load all org brand overrides from Keycloak into cache.
 * Called during runtime config initialization when an admin client is available.
 */
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

/**
 * Brand colours for a launching client: the global brand, with the client's organization
 * override applied when one resolves.
 *
 * Best-effort by design. Theming must never decide whether a login or a launch succeeds,
 * so every failure here falls back to the global brand and logs at debug.
 *
 * Colours are validated on the way out as well as on the way in: these end up in a
 * stylesheet, and an attribute written before validation existed (or edited straight onto
 * the Keycloak organization) would otherwise reach the page unchecked.
 */
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
