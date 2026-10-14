// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Runtime Configuration Store
 * 
 * In-memory config store backed by Keycloak realm attributes.
 * Settings saved via admin UI are persisted to Keycloak and cached here.
 * Saves keep only the fields that differ from the defaults (access-posture.json, then env vars),
 * so a saved setting never pins the others.
 */

import { config } from '@/config'
import { logger } from '@/lib/logger'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type { ConsentConfig, IalConfig, IdentityAssuranceLevel } from '@/lib/consent/types'
import {
  isValidUserAccessCategoryValueSetCode,
  type BrandConfigType,
  type SmartAccessControlConfigType,
} from '@/schemas'
import { isEnforcementMode } from '@/lib/enforcement-mode'
import { isOneOf, stringEntries } from '@/lib/type-guards'
import { adoptLegacyDicomServers, LEGACY_DICOM_SERVERS_ATTRIBUTE, loadDicomServers } from './dicom-server-config'
import { loadAllOrgBrands } from './org-branding'
import { brandToAttributes, hasBrandAttributes, parseBrandAttributes, parseBrandPortals } from './brand-attributes'

// Module-level cache
let consentOverrides: Partial<ConsentConfig> | null = null
let ialOverrides: Partial<IalConfig> | null = null
let brandOverrides: Partial<BrandConfigType> | null = null
let accessControlOverrides: Partial<SmartAccessControlConfigType> | null = null
let dicomViewerAppClientId: string | null = null
let loaded = false

/** Realm attributes for the fields that are set, under one prefix. */
function prefixed(prefix: string, values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => (value === undefined ? [] : [[`${prefix}${key}`, value]])),
  )
}

/** The fields that differ from the defaults: only these are saved, so a save cannot pin the rest. */
export function changedFrom<T extends object, K extends keyof T>(settings: T, defaults: T, keys: readonly K[]): Partial<T> {
  const changed: Partial<T> = {}
  for (const key of keys) {
    if (JSON.stringify(settings[key]) !== JSON.stringify(defaults[key])) changed[key] = settings[key]
  }
  return changed
}

/** Replace every attribute under `prefix` with `next`, keeping the realm's other attributes. */
async function writeAttributeGroup(admin: KcAdminClient, prefix: string, next: Record<string, string>): Promise<void> {
  const realmName = config.keycloak.realm
  if (!realmName) throw new Error('KEYCLOAK_REALM is not configured')
  const realm = await admin.realms.findOne({ realm: realmName })
  const kept = Object.fromEntries(Object.entries(realm?.attributes ?? {}).filter(([key]) => !key.startsWith(prefix)))
  await admin.realms.update({ realm: realmName }, { attributes: { ...kept, ...next } })
}

const overridesOrNull = <T extends object>(changed: Partial<T>): Partial<T> | null => (Object.keys(changed).length > 0 ? changed : null)

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

function consentToAttributes(settings: Partial<ConsentConfig>): Record<string, string> {
  return prefixed(CONSENT_PREFIX, {
    enabled: settings.enabled?.toString(),
    mode: settings.mode,
    cache_ttl: settings.cacheTtl?.toString(),
    exempt_clients: settings.exemptClients?.join(','),
    required_resource_types: settings.requiredForResourceTypes?.join(','),
    exempt_resource_types: settings.exemptResourceTypes?.join(','),
    app_url: 'appUrl' in settings ? settings.appUrl || '' : undefined,
  })
}

// ─── IAL ─────────────────────────────────────────────────────────────

const IAL_PREFIX = 'ial_settings.'

function parseIalFromAttributes(attrs: Record<string, string>): Partial<IalConfig> | null {
  const hasAny = Object.keys(attrs).some(k => k.startsWith(IAL_PREFIX))
  if (!hasAny) return null

  const get = (key: string) => attrs[`${IAL_PREFIX}${key}`]

  const result: Partial<IalConfig> = {}
  const validLevels: readonly IdentityAssuranceLevel[] = ['level1', 'level2', 'level3', 'level4']

  if (get('enabled') !== undefined) result.enabled = get('enabled') === 'true'
  if (get('minimum_level') !== undefined) {
    const l = get('minimum_level')
    if (isOneOf(validLevels, l)) result.minimumLevel = l
  }
  if (get('sensitive_resource_types') !== undefined) {
    result.sensitiveResourceTypes = get('sensitive_resource_types').split(',').map(s => s.trim()).filter(Boolean)
  }
  if (get('sensitive_minimum_level') !== undefined) {
    const l = get('sensitive_minimum_level')
    if (isOneOf(validLevels, l)) result.sensitiveMinimumLevel = l
  }
  if (get('verify_patient_link') !== undefined) result.verifyPatientLink = get('verify_patient_link') === 'true'
  if (get('allow_on_person_lookup_failure') !== undefined) result.allowOnPersonLookupFailure = get('allow_on_person_lookup_failure') === 'true'
  if (get('cache_ttl') !== undefined) result.cacheTtl = parseInt(get('cache_ttl'), 10)

  return result
}

function ialToAttributes(settings: Partial<IalConfig>): Record<string, string> {
  return prefixed(IAL_PREFIX, {
    enabled: settings.enabled?.toString(),
    minimum_level: settings.minimumLevel,
    sensitive_resource_types: settings.sensitiveResourceTypes?.join(','),
    sensitive_minimum_level: settings.sensitiveMinimumLevel,
    verify_patient_link: settings.verifyPatientLink?.toString(),
    allow_on_person_lookup_failure: settings.allowOnPersonLookupFailure?.toString(),
    cache_ttl: settings.cacheTtl?.toString(),
  })
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
  const audienceMode = get('fhir_audience_enforcement')
  if (isEnforcementMode(audienceMode)) result.fhirAudienceEnforcement = audienceMode
  if (get('external_audiences') !== undefined) {
    result.externalAudiences = get('external_audiences').split(',').map(s => s.trim()).filter(Boolean)
  }

  return result
}

function accessControlToAttributes(settings: Partial<SmartAccessControlConfigType>): Record<string, string> {
  return prefixed(AC_PREFIX, {
    scope_enforcement: settings.scopeEnforcement,
    role_based_filtering: settings.roleBasedFiltering,
    fhir_audience_enforcement: settings.fhirAudienceEnforcement,
    external_audiences: settings.externalAudiences?.join(','),
  })
}

// ─── Public API ──────────────────────────────────────────────────────

/** Move servers out of the legacy realm attribute, drop the attribute once stored durably, preload. */
async function settleDicomServers(admin: KcAdminClient, legacyAttribute: string | undefined): Promise<void> {
  try {
    if (legacyAttribute && await adoptLegacyDicomServers(legacyAttribute)) {
      const realm = await admin.realms.findOne({ realm: process.env.KEYCLOAK_REALM! })
      const attributes = Object.fromEntries(
        Object.entries(realm?.attributes ?? {}).filter(([key]) => key !== LEGACY_DICOM_SERVERS_ATTRIBUTE),
      )
      await admin.realms.update({ realm: process.env.KEYCLOAK_REALM! }, { attributes })
      logger.admin.info('Removed the legacy dicom_servers realm attribute')
    }
    await loadDicomServers()
  } catch (error) {
    logger.admin.warn('Could not settle DICOM server config', { error })
  }
}

/**
 * Load consent + IAL + access control settings from Keycloak realm attributes into memory.
 * Called at startup and after saves.
 */
export async function loadRuntimeConfig(admin: KcAdminClient): Promise<void> {
  try {
    const realm = await admin.realms.findOne({ realm: process.env.KEYCLOAK_REALM! })
    const attrs = stringEntries(realm?.attributes)

    consentOverrides = parseConsentFromAttributes(attrs)
    ialOverrides = parseIalFromAttributes(attrs)
    brandOverrides = parseBrandFromAttributes(attrs)
    accessControlOverrides = parseAccessControlFromAttributes(attrs)
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
    await settleDicomServers(admin, attrs[LEGACY_DICOM_SERVERS_ATTRIBUTE])

    logger.admin.info('Runtime config loaded from Keycloak', {
      consentOverrides: !!consentOverrides,
      ialOverrides: !!ialOverrides,
      brandOverrides: !!brandOverrides,
      accessControlOverrides: !!accessControlOverrides,
      dicomViewerApp: dicomViewerAppClientId,
    })
  } catch (error) {
    logger.admin.warn('Failed to load runtime config from Keycloak, using env var defaults', { error })
  }
}

function consentDefaults(): ConsentConfig {
  return {
    enabled: config.consent.enabled,
    mode: config.consent.mode,
    cacheTtl: config.consent.cacheTtl,
    exemptClients: config.consent.exemptClients,
    requiredForResourceTypes: config.consent.requiredForResourceTypes,
    exemptResourceTypes: config.consent.exemptResourceTypes,
    appUrl: config.consent.appUrl,
  }
}

const CONSENT_KEYS = ['enabled', 'mode', 'cacheTtl', 'exemptClients', 'requiredForResourceTypes', 'exemptResourceTypes', 'appUrl'] as const

/** Effective consent config: saved overrides over the defaults (access-posture.json, then env). */
export function getRuntimeConsentConfig(): ConsentConfig {
  return { ...consentDefaults(), ...consentOverrides }
}

export async function saveConsentConfig(admin: KcAdminClient, settings: ConsentConfig): Promise<void> {
  const changed = changedFrom(settings, consentDefaults(), CONSENT_KEYS)
  await writeAttributeGroup(admin, CONSENT_PREFIX, consentToAttributes(changed))
  consentOverrides = overridesOrNull(changed)
  logger.admin.info('Consent config saved to Keycloak realm attributes', { overrides: changed })
}

function ialDefaults(): IalConfig {
  return {
    enabled: config.ial.enabled,
    minimumLevel: config.ial.minimumLevel,
    sensitiveResourceTypes: config.ial.sensitiveResourceTypes,
    sensitiveMinimumLevel: config.ial.sensitiveMinimumLevel,
    verifyPatientLink: config.ial.verifyPatientLink,
    allowOnPersonLookupFailure: config.ial.allowOnPersonLookupFailure,
    cacheTtl: config.ial.cacheTtl,
  }
}

const IAL_KEYS = ['enabled', 'minimumLevel', 'sensitiveResourceTypes', 'sensitiveMinimumLevel', 'verifyPatientLink', 'allowOnPersonLookupFailure', 'cacheTtl'] as const

/** Effective IAL config: saved overrides over the env defaults. */
export function getRuntimeIalConfig(): IalConfig {
  return { ...ialDefaults(), ...ialOverrides }
}

export async function saveIalConfig(admin: KcAdminClient, settings: IalConfig): Promise<void> {
  const changed = changedFrom(settings, ialDefaults(), IAL_KEYS)
  await writeAttributeGroup(admin, IAL_PREFIX, ialToAttributes(changed))
  ialOverrides = overridesOrNull(changed)
  logger.admin.info('IAL config saved to Keycloak realm attributes', { overrides: changed })
}

function accessControlDefaults(): Required<SmartAccessControlConfigType> {
  return {
    scopeEnforcement: config.accessControl.scopeEnforcement,
    roleBasedFiltering: config.accessControl.roleBasedFiltering,
    fhirAudienceEnforcement: config.accessControl.fhirAudienceEnforcement,
    externalAudiences: config.accessControl.externalAudiences,
  }
}

const ACCESS_CONTROL_KEYS = ['scopeEnforcement', 'roleBasedFiltering', 'fhirAudienceEnforcement', 'externalAudiences'] as const

/** Effective SMART access control config: saved overrides over the defaults (access-posture.json, then env). */
export function getRuntimeAccessControlConfig(): Required<SmartAccessControlConfigType> {
  return { ...accessControlDefaults(), ...accessControlOverrides }
}

export async function saveAccessControlConfig(admin: KcAdminClient, settings: SmartAccessControlConfigType): Promise<void> {
  const changed = changedFrom({ ...getRuntimeAccessControlConfig(), ...settings }, accessControlDefaults(), ACCESS_CONTROL_KEYS)
  await writeAttributeGroup(admin, AC_PREFIX, accessControlToAttributes(changed))
  accessControlOverrides = overridesOrNull(changed)
  logger.admin.info('Access control config saved to Keycloak realm attributes', { overrides: changed })
}

// ─── DICOM Viewer App ────────────────────────────────────────────────

/** Get the globally configured DICOM viewer SMART app client ID */
export function getDicomViewerAppClientId(): string | null {
  return dicomViewerAppClientId
}

/** Save the global DICOM viewer app client ID to Keycloak realm attributes */
export async function saveDicomViewerApp(admin: KcAdminClient, clientId: string | null): Promise<void> {
  const realmName = config.keycloak.realm
  if (!realmName) throw new Error('KEYCLOAK_REALM is not configured')
  const realm = await admin.realms.findOne({ realm: realmName })
  const existingAttrs = realm?.attributes ?? {}

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
    category: isValidUserAccessCategoryValueSetCode(config.brand.category) ? config.brand.category : 'prov',
    portalName: config.brand.portalName,
    portalUrl: config.brand.portalUrl,
    portalDescription: config.brand.portalDescription,
    portalLogoUrl: config.brand.portalLogoUrl,
    portalLogoLicenseUrl: config.brand.portalLogoLicenseUrl,
    addressLine: config.brand.addressLine,
    addressCity: config.brand.addressCity,
    addressState: config.brand.addressState,
    addressPostalCode: config.brand.addressPostalCode,
    addressCountry: config.brand.addressCountry,
    identifier: config.brand.identifier,
    identifierSystem: config.brand.identifierSystem,
    developerUrl: config.brand.developerUrl,
    additionalPortals: parseBrandPortals(config.brand.additionalPortals) ?? [],
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
  const realmName = config.keycloak.realm
  if (!realmName) throw new Error('KEYCLOAK_REALM is not configured')
  const realm = await admin.realms.findOne({ realm: realmName })
  const existingAttrs = realm?.attributes ?? {}

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

  await admin.realms.update({ realm: realmName }, realmUpdate)

  // Re-read from the merged attributes so fields this request left out keep their stored values.
  brandOverrides = { ...parseBrandFromAttributes(attributes), loginTheme: settings.loginTheme }
  logger.admin.info('Brand config saved to Keycloak realm attributes', { name: settings.name })
}
