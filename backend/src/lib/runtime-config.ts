// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Runtime Configuration Store
 * 
 * In-memory config store backed by Keycloak realm attributes.
 * Settings saved via admin UI are persisted to Keycloak and cached here.
 * getConsentConfig() and getIalConfig() read from this store,
 * falling back to env vars (config.ts) when no realm attribute is set.
 */

import { config } from '@/config'
import { logger } from '@/lib/logger'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type { ConsentConfig } from '@/lib/consent/types'
import type { IalConfig, IdentityAssuranceLevel } from '@/lib/consent/types'
import type { BrandConfigType, BrandCategoryType } from '@/schemas'
import { isEnforcementMode } from '@/lib/enforcement-mode'
import type { SmartAccessControlConfigType } from '@/schemas'
import type { DicomServerConfigType } from '@/schemas'
import { loadAllOrgBrands } from './org-branding'
import { brandToAttributes, hasBrandAttributes, parseBrandAttributes } from './brand-attributes'

// Module-level cache
let consentOverrides: Partial<ConsentConfig> | null = null
let ialOverrides: Partial<IalConfig> | null = null
let brandOverrides: Partial<BrandConfigType> | null = null
let accessControlOverrides: Partial<SmartAccessControlConfigType> | null = null
let dicomServersCache: DicomServerConfigType[] | null = null
let dicomViewerAppClientId: string | null = null
let loaded = false

// ─── Consent ─────────────────────────────────────────────────────────

const CONSENT_PREFIX = 'consent_settings.'

function parseConsentFromAttributes(attrs: Record<string, string>): Partial<ConsentConfig> | null {
  // Only return overrides if at least one key exists
  const hasAny = Object.keys(attrs).some(k => k.startsWith(CONSENT_PREFIX))
  if (!hasAny) return null

  const get = (key: string) => attrs[`${CONSENT_PREFIX}${key}`]

  const result: Partial<ConsentConfig> = {}

  if (get('enabled') !== undefined) result.enabled = get('enabled') === 'true'
  if (get('mode') !== undefined) {
    const m = get('mode')
    if (isEnforcementMode(m)) result.mode = m
  }
  if (get('cache_ttl') !== undefined) result.cacheTtl = parseInt(get('cache_ttl'), 10)
  if (get('exempt_clients') !== undefined) {
    result.exemptClients = get('exempt_clients').split(',').map(s => s.trim()).filter(Boolean)
  }
  if (get('required_resource_types') !== undefined) {
    result.requiredForResourceTypes = get('required_resource_types').split(',').map(s => s.trim()).filter(Boolean)
  }
  if (get('exempt_resource_types') !== undefined) {
    result.exemptResourceTypes = get('exempt_resource_types').split(',').map(s => s.trim()).filter(Boolean)
  }
  if (get('app_url') !== undefined) {
    result.appUrl = get('app_url') || null
  }

  return result
}

function consentToAttributes(settings: ConsentConfig): Record<string, string> {
  return {
    [`${CONSENT_PREFIX}enabled`]: settings.enabled.toString(),
    [`${CONSENT_PREFIX}mode`]: settings.mode,
    [`${CONSENT_PREFIX}cache_ttl`]: settings.cacheTtl.toString(),
    [`${CONSENT_PREFIX}exempt_clients`]: settings.exemptClients.join(','),
    [`${CONSENT_PREFIX}required_resource_types`]: settings.requiredForResourceTypes.join(','),
    [`${CONSENT_PREFIX}exempt_resource_types`]: settings.exemptResourceTypes.join(','),
    [`${CONSENT_PREFIX}app_url`]: settings.appUrl || '',
  }
}

// ─── IAL ─────────────────────────────────────────────────────────────

const IAL_PREFIX = 'ial_settings.'

function parseIalFromAttributes(attrs: Record<string, string>): Partial<IalConfig> | null {
  const hasAny = Object.keys(attrs).some(k => k.startsWith(IAL_PREFIX))
  if (!hasAny) return null

  const get = (key: string) => attrs[`${IAL_PREFIX}${key}`]

  const result: Partial<IalConfig> = {}
  const validLevels = ['level1', 'level2', 'level3', 'level4']

  if (get('enabled') !== undefined) result.enabled = get('enabled') === 'true'
  if (get('minimum_level') !== undefined) {
    const l = get('minimum_level')
    if (validLevels.includes(l)) result.minimumLevel = l as IdentityAssuranceLevel
  }
  if (get('sensitive_resource_types') !== undefined) {
    result.sensitiveResourceTypes = get('sensitive_resource_types').split(',').map(s => s.trim()).filter(Boolean)
  }
  if (get('sensitive_minimum_level') !== undefined) {
    const l = get('sensitive_minimum_level')
    if (validLevels.includes(l)) result.sensitiveMinimumLevel = l as IdentityAssuranceLevel
  }
  if (get('verify_patient_link') !== undefined) result.verifyPatientLink = get('verify_patient_link') === 'true'
  if (get('allow_on_person_lookup_failure') !== undefined) result.allowOnPersonLookupFailure = get('allow_on_person_lookup_failure') === 'true'
  if (get('cache_ttl') !== undefined) result.cacheTtl = parseInt(get('cache_ttl'), 10)

  return result
}

function ialToAttributes(settings: IalConfig): Record<string, string> {
  return {
    [`${IAL_PREFIX}enabled`]: settings.enabled.toString(),
    [`${IAL_PREFIX}minimum_level`]: settings.minimumLevel,
    [`${IAL_PREFIX}sensitive_resource_types`]: settings.sensitiveResourceTypes.join(','),
    [`${IAL_PREFIX}sensitive_minimum_level`]: settings.sensitiveMinimumLevel,
    [`${IAL_PREFIX}verify_patient_link`]: settings.verifyPatientLink.toString(),
    [`${IAL_PREFIX}allow_on_person_lookup_failure`]: settings.allowOnPersonLookupFailure.toString(),
    [`${IAL_PREFIX}cache_ttl`]: settings.cacheTtl.toString(),
  }
}

// ─── Access Control ──────────────────────────────────────────────────

const AC_PREFIX = 'access_control.'

function parseAccessControlFromAttributes(attrs: Record<string, string>): Partial<SmartAccessControlConfigType> | null {
  const hasAny = Object.keys(attrs).some(k => k.startsWith(AC_PREFIX))
  if (!hasAny) return null

  const get = (key: string) => attrs[`${AC_PREFIX}${key}`]
  const result: Partial<SmartAccessControlConfigType> = {}

  if (get('scope_enforcement') !== undefined) {
    const m = get('scope_enforcement')
    if (isEnforcementMode(m)) result.scopeEnforcement = m
  }
  if (get('role_based_filtering') !== undefined) {
    const m = get('role_based_filtering')
    if (isEnforcementMode(m)) result.roleBasedFiltering = m
  }
  if (get('patient_scoped_resources') !== undefined) {
    result.patientScopedResources = get('patient_scoped_resources').split(',').map(s => s.trim()).filter(Boolean)
  }
  if (get('external_audiences') !== undefined) {
    result.externalAudiences = get('external_audiences').split(',').map(s => s.trim()).filter(Boolean)
  }

  return result
}

function accessControlToAttributes(settings: SmartAccessControlConfigType): Record<string, string> {
  return {
    [`${AC_PREFIX}scope_enforcement`]: settings.scopeEnforcement,
    [`${AC_PREFIX}role_based_filtering`]: settings.roleBasedFiltering,
    [`${AC_PREFIX}patient_scoped_resources`]: settings.patientScopedResources.join(','),
    [`${AC_PREFIX}external_audiences`]: settings.externalAudiences.join(','),
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Load consent + IAL + access control settings from Keycloak realm attributes into memory.
 * Called at startup and after saves.
 */
export async function loadRuntimeConfig(admin: KcAdminClient): Promise<void> {
  try {
    const realm = await admin.realms.findOne({ realm: process.env.KEYCLOAK_REALM! })
    const attrs = (realm?.attributes || {}) as Record<string, string>

    consentOverrides = parseConsentFromAttributes(attrs)
    ialOverrides = parseIalFromAttributes(attrs)
    brandOverrides = parseBrandFromAttributes(attrs)
    accessControlOverrides = parseAccessControlFromAttributes(attrs)
    dicomServersCache = parseDicomServersFromAttributes(attrs)
    dicomViewerAppClientId = attrs['dicom_viewer_app'] || null
    // loginTheme is a top-level realm property, not an attribute
    if (brandOverrides) {
      brandOverrides.loginTheme = realm?.loginTheme || null
    } else if (realm?.loginTheme) {
      brandOverrides = { loginTheme: realm.loginTheme }
    }
    loaded = true

    // Load per-org brand overrides into cache
    await loadAllOrgBrands(admin)

    logger.admin.info('Runtime config loaded from Keycloak', {
      consentOverrides: !!consentOverrides,
      ialOverrides: !!ialOverrides,
      brandOverrides: !!brandOverrides,
      accessControlOverrides: !!accessControlOverrides,
      dicomServers: dicomServersCache?.length ?? 0,
      dicomViewerApp: dicomViewerAppClientId,
    })
  } catch (error) {
    logger.admin.warn('Failed to load runtime config from Keycloak, using env var defaults', { error })
  }
}

/**
 * Get effective consent config: realm attribute overrides merged over env vars.
 */
export function getRuntimeConsentConfig(): ConsentConfig {
  const envDefaults: ConsentConfig = {
    enabled: config.consent.enabled,
    mode: config.consent.mode,
    cacheTtl: config.consent.cacheTtl,
    exemptClients: config.consent.exemptClients,
    requiredForResourceTypes: config.consent.requiredForResourceTypes,
    exemptResourceTypes: config.consent.exemptResourceTypes,
    appUrl: config.consent.appUrl,
  }

  if (!consentOverrides) return envDefaults

  return { ...envDefaults, ...consentOverrides }
}

/**
 * Get effective IAL config: realm attribute overrides merged over env vars.
 */
export function getRuntimeIalConfig(): IalConfig {
  const envDefaults: IalConfig = {
    enabled: config.ial.enabled,
    minimumLevel: config.ial.minimumLevel,
    sensitiveResourceTypes: config.ial.sensitiveResourceTypes,
    sensitiveMinimumLevel: config.ial.sensitiveMinimumLevel,
    verifyPatientLink: config.ial.verifyPatientLink,
    allowOnPersonLookupFailure: config.ial.allowOnPersonLookupFailure,
    cacheTtl: config.ial.cacheTtl,
  }

  if (!ialOverrides) return envDefaults

  return { ...envDefaults, ...ialOverrides }
}

/**
 * Save consent config to Keycloak realm attributes and update in-memory cache.
 */
export async function saveConsentConfig(admin: KcAdminClient, settings: ConsentConfig): Promise<void> {
  const realm = await admin.realms.findOne({ realm: process.env.KEYCLOAK_REALM! })
  const existingAttrs = (realm?.attributes || {}) as Record<string, string>

  const attributes = {
    ...existingAttrs,
    ...consentToAttributes(settings),
  }

  await admin.realms.update(
    { realm: process.env.KEYCLOAK_REALM! },
    { attributes }
  )

  // Update in-memory cache
  consentOverrides = { ...settings }
  logger.admin.info('Consent config saved to Keycloak realm attributes', { settings })
}

/**
 * Save IAL config to Keycloak realm attributes and update in-memory cache.
 */
export async function saveIalConfig(admin: KcAdminClient, settings: IalConfig): Promise<void> {
  const realm = await admin.realms.findOne({ realm: process.env.KEYCLOAK_REALM! })
  const existingAttrs = (realm?.attributes || {}) as Record<string, string>

  const attributes = {
    ...existingAttrs,
    ...ialToAttributes(settings),
  }

  await admin.realms.update(
    { realm: process.env.KEYCLOAK_REALM! },
    { attributes }
  )

  // Update in-memory cache
  ialOverrides = { ...settings }
  logger.admin.info('IAL config saved to Keycloak realm attributes', { settings })
}

/**
 * Get effective SMART access control config: realm attribute overrides merged over env vars.
 */
export function getRuntimeAccessControlConfig(): SmartAccessControlConfigType {
  const envDefaults: SmartAccessControlConfigType = {
    scopeEnforcement: config.accessControl.scopeEnforcement,
    roleBasedFiltering: config.accessControl.roleBasedFiltering,
    patientScopedResources: config.accessControl.patientScopedResources,
    externalAudiences: config.accessControl.externalAudiences,
  }

  if (!accessControlOverrides) return envDefaults

  return { ...envDefaults, ...accessControlOverrides }
}

/**
 * Save SMART access control config to Keycloak realm attributes and update in-memory cache.
 */
export async function saveAccessControlConfig(admin: KcAdminClient, settings: SmartAccessControlConfigType): Promise<void> {
  const realm = await admin.realms.findOne({ realm: process.env.KEYCLOAK_REALM! })
  const existingAttrs = (realm?.attributes || {}) as Record<string, string>

  const attributes = {
    ...existingAttrs,
    ...accessControlToAttributes(settings),
  }

  await admin.realms.update(
    { realm: process.env.KEYCLOAK_REALM! },
    { attributes }
  )

  // Update in-memory cache
  accessControlOverrides = { ...settings }
  logger.admin.info('Access control config saved to Keycloak realm attributes', { settings })
}

// ─── DICOM Servers ───────────────────────────────────────────────────

const DICOM_SERVERS_KEY = 'dicom_servers'

function parseDicomServersFromAttributes(attrs: Record<string, string>): DicomServerConfigType[] | null {
  const raw = attrs[DICOM_SERVERS_KEY]
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    logger.warn('runtime-config', 'Failed to parse dicom_servers realm attribute')
    return null
  }
}

/**
 * Build effective DICOM servers list: runtime overrides + env var fallback.
 * If servers were configured via admin UI, those are returned.
 * Otherwise, if DICOMWEB_BASE_URL env var is set, a single server is synthesized.
 */
export function getRuntimeDicomServers(): DicomServerConfigType[] {
  if (dicomServersCache && dicomServersCache.length > 0) return dicomServersCache

  // Fallback: synthesize a server from env vars
  if (config.dicomweb.enabled && config.dicomweb.baseUrl) {
    return [{
      id: 'env-default',
      name: 'Default PACS',
      baseUrl: config.dicomweb.baseUrl,
      wadoRoot: config.dicomweb.wadoRoot || undefined,
      qidoRoot: config.dicomweb.qidoRoot || undefined,
      authType: config.dicomweb.upstreamAuth ? 'header' : 'none',
      authHeader: config.dicomweb.upstreamAuth || undefined,
      timeoutMs: config.dicomweb.timeoutMs,
      isDefault: true,
    }]
  }
  return []
}

/** The server flagged default, else the first one: where unscoped /dicomweb requests go */
export function pickDefaultDicomServer(servers: readonly DicomServerConfigType[]): DicomServerConfigType | null {
  return servers.find(s => s.isDefault) ?? servers[0] ?? null
}

export function getDefaultDicomServer(): DicomServerConfigType | null {
  return pickDefaultDicomServer(getRuntimeDicomServers())
}

/** Look up a specific DICOM server by its config ID (e.g. for /dicomweb/servers/:serverId routes) */
export function getDicomServerById(id: string): DicomServerConfigType | null {
  const servers = getRuntimeDicomServers()
  return servers.find(s => s.id === id) ?? null
}

/** Save DICOM servers list to Keycloak realm attributes */
export async function saveDicomServers(admin: KcAdminClient, servers: DicomServerConfigType[]): Promise<void> {
  const realm = await admin.realms.findOne({ realm: process.env.KEYCLOAK_REALM! })
  const existingAttrs = (realm?.attributes || {}) as Record<string, string>

  const attributes = {
    ...existingAttrs,
    [DICOM_SERVERS_KEY]: JSON.stringify(servers),
  }

  await admin.realms.update(
    { realm: process.env.KEYCLOAK_REALM! },
    { attributes }
  )

  dicomServersCache = [...servers]
  logger.admin.info('DICOM servers config saved to Keycloak realm attributes', { count: servers.length })
}

// ─── DICOM Viewer App ────────────────────────────────────────────────

/** Get the globally configured DICOM viewer SMART app client ID */
export function getDicomViewerAppClientId(): string | null {
  return dicomViewerAppClientId
}

/** Save the global DICOM viewer app client ID to Keycloak realm attributes */
export async function saveDicomViewerApp(admin: KcAdminClient, clientId: string | null): Promise<void> {
  const realm = await admin.realms.findOne({ realm: process.env.KEYCLOAK_REALM! })
  const existingAttrs = (realm?.attributes || {}) as Record<string, string>

  const attributes = { ...existingAttrs }
  if (clientId) {
    attributes['dicom_viewer_app'] = clientId
  } else {
    delete attributes['dicom_viewer_app']
  }

  await admin.realms.update(
    { realm: process.env.KEYCLOAK_REALM! },
    { attributes }
  )

  dicomViewerAppClientId = clientId
  logger.admin.info('DICOM viewer app setting saved', { clientId })
}

/** Whether runtime config has been loaded from Keycloak at least once */
export function isRuntimeConfigLoaded(): boolean {
  return loaded
}

/**
 * Set consent overrides directly (for testing).
 * Bypasses env var getters which are unreliable in concurrent test environments.
 */
export function __setConsentOverridesForTesting(overrides: Partial<ConsentConfig> | null): void {
  consentOverrides = overrides
}

// ─── Brand ───────────────────────────────────────────────────────────

function parseBrandFromAttributes(attrs: Record<string, string>): Partial<BrandConfigType> | null {
  return hasBrandAttributes(Object.keys(attrs)) ? parseBrandAttributes((key) => attrs[key]) : null
}

/**
 * Auto-detect patient portal metadata from the deployed patient-portal app.
 * Reads public/apps/patient-portal/smart-manifest.json if present and derives
 * portalName, portalUrl, and portalDescription for brand configuration.
 */
let patientPortalCache: { portalName: string; portalUrl: string; portalDescription: string } | null | undefined

function detectPatientPortal() {
  if (patientPortalCache !== undefined) return patientPortalCache
  try {
    const manifestPath = join(process.cwd(), 'public', 'apps', 'patient-portal', 'smart-manifest.json')
    if (!existsSync(manifestPath)) { patientPortalCache = null; return null }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    patientPortalCache = {
      portalName: manifest.client_name || 'Patient Portal',
      portalUrl: `${config.baseUrl}/apps/patient-portal/`,
      portalDescription: manifest.description || null,
    }
    return patientPortalCache
  } catch {
    patientPortalCache = null
    return null
  }
}

/**
 * Get effective brand config: realm attribute overrides merged over env vars.
 * Portal fields auto-populate from the deployed patient-portal app when unset.
 */
export function getRuntimeBrandConfig(): BrandConfigType {
  const envDefaults: BrandConfigType = {
    name: config.brand.name,
    website: config.brand.website,
    logoUrl: config.brand.logoUrl,
    logoLicenseUrl: config.brand.logoLicenseUrl,
    aliases: config.brand.aliases,
    category: config.brand.category as BrandCategoryType,
    portalName: config.brand.portalName,
    portalUrl: config.brand.portalUrl,
    portalDescription: config.brand.portalDescription,
    portalLogoUrl: config.brand.portalLogoUrl,
    portalLogoLicenseUrl: config.brand.portalLogoLicenseUrl,
    addressCity: config.brand.addressCity,
    addressState: config.brand.addressState,
    addressPostalCode: config.brand.addressPostalCode,
    addressCountry: config.brand.addressCountry,
    identifier: config.brand.identifier,
    loginTheme: config.brand.loginTheme,
    appStoreUrl: config.brand.appStoreUrl,
    primaryColor: config.brand.primaryColor,
    accentColor: config.brand.accentColor,
  }

  const merged = !brandOverrides ? envDefaults : { ...envDefaults, ...brandOverrides }

  // Auto-fill portal fields from deployed patient-portal app when unset
  if (!merged.portalName && !merged.portalUrl) {
    const portal = detectPatientPortal()
    if (portal) {
      merged.portalName = merged.portalName || portal.portalName
      merged.portalUrl = merged.portalUrl || portal.portalUrl
      merged.portalDescription = merged.portalDescription || portal.portalDescription
    }
  }

  return merged
}

/**
 * Save brand config to Keycloak realm attributes and update in-memory cache.
 */
export async function saveBrandConfig(admin: KcAdminClient, settings: BrandConfigType): Promise<void> {
  const realm = await admin.realms.findOne({ realm: process.env.KEYCLOAK_REALM! })
  const existingAttrs = (realm?.attributes || {}) as Record<string, string>

  const attributes = {
    ...existingAttrs,
    ...brandToAttributes(settings),
  }

  const realmUpdate: Record<string, unknown> = { attributes }

  // Sync brand name → Keycloak login page heading (displayName + displayNameHtml)
  // Note: kcSanitize() in keycloak.v2 template.ftl strips <img>/<svg> tags,
  // so we only use plain text. The login theme CSS handles visual branding.
  if (settings.name) {
    realmUpdate.displayName = settings.name
    realmUpdate.displayNameHtml = settings.name
  }

  // Sync loginTheme → Keycloak realm login theme
  if (settings.loginTheme !== undefined) {
    realmUpdate.loginTheme = settings.loginTheme || ''
  }

  await admin.realms.update(
    { realm: process.env.KEYCLOAK_REALM! },
    realmUpdate
  )

  // Update in-memory cache
  brandOverrides = { ...settings }
  logger.admin.info('Brand config saved to Keycloak realm attributes', { name: settings.name })
}
