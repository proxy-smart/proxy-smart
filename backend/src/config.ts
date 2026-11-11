// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { existsSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { loadMcpEndpointConfig } from './lib/mcp-endpoint-config'
import { basicAuthHeader } from './lib/http-auth'
import { ENFORCEMENT_DEFAULTS, parseAssuranceLevel, parseEnforcementMode, parseSecurityFlag, type EnforcementMode } from './lib/enforcement-mode'
import type { IdentityAssuranceLevel } from './lib/consent/types'

export interface UploadAdmissionConfig {
  url: string
  secret?: string
  timeoutMs: number
  onError: 'allow' | 'deny'
}

// Seeded by keycloak/realm-export.json and public in this repo; index.ts refuses it in production.
export const DEV_FIXTURE_ADMIN_CLIENT_SECRET = 'admin-service-secret'

let packageJson: { name: string; displayName?: string; version: string }
try {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const packageJsonPath = join(__dirname, '..', 'package.json')
  packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
} catch {
  try {
    const packageJsonPath = resolve(process.cwd(), 'package.json')
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
  } catch {
    packageJson = {
      name: 'proxy-smart-backend',
      displayName: 'Proxy Smart Backend',
      version: '0.0.1-alpha'
    }
  }
}

// The build commit comes from the builder, so develop, test and main never conflict on a stamped version.
function versionWithBuildSha(base: string): string {
  const sha = (process.env.BUILD_SHA || process.env.GITHUB_SHA || '').trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return base
  return base.includes(sha) ? base : `${base}+${sha}`
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const value = raw?.trim()
  return value && /^\d+$/.test(value) ? Number(value) : fallback
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = nonNegativeInt(process.env[name], fallback)
  return value > 0 ? value : fallback
}

const pemFiles = new Map<string, string>()

/** A PEM from a mounted file (read once), or else one injected inline. */
export function pemEnv(fileVar: string, inlineVar: string): string | null {
  const file = process.env[fileVar]
  if (!file) return process.env[inlineVar] || null
  const cached = pemFiles.get(file)
  if (cached !== undefined) return cached
  if (!existsSync(file)) throw new Error(`${fileVar} not found: ${file}`)
  const pem = readFileSync(file, 'utf-8').trim()
  pemFiles.set(file, pem)
  return pem
}

export const config = {
  // Normalized here so the ~90 `${config.baseUrl}/path` call sites cannot emit a double slash.
  baseUrl: (process.env.BASE_URL || 'http://localhost:8445').replace(/\/+$/, ''),
  get siteUrl(): string {
    return (process.env.SITE_URL || this.baseUrl).replace(/\/+$/, '')
  },
  port: process.env.PORT || 8445,

  // Where Keycloak fetches our JWKS; required where the compose host `backend` does not resolve (ECS),
  // or every private_key_jwt client fails with invalid_client.
  proxySigningJwksUrl: process.env.PROXY_SIGNING_JWKS_URL || null,
  
  name: packageJson.name,
  displayName: packageJson.displayName || packageJson.name,
  version: versionWithBuildSha(packageJson.version),
  
  keycloak: {
    get baseUrl() {
      return process.env.KEYCLOAK_BASE_URL || null
    },
    
    get realm() {
      return process.env.KEYCLOAK_REALM || null
    },
    
    get adminClientId() {
      return process.env.KEYCLOAK_ADMIN_CLIENT_ID || null
    },

    get adminClientSecret() {
      return process.env.KEYCLOAK_ADMIN_CLIENT_SECRET || null
    },

    /** How long the admin connection test waits for each URL an identity provider is configured with. */
    get idpConnectionTestTimeoutMs(): number {
      return positiveIntEnv('IDP_CONNECTION_TEST_TIMEOUT_MS', 5_000)
    },

    // The admin webapp's browser client, distinct from the adminClientId service account;
    // validateAdminToken binds admin tokens to it via aud/azp.
    get adminUiClientId() {
      return process.env.KEYCLOAK_ADMIN_UI_CLIENT_ID || 'admin-ui'
    },
    
    get isConfigured() {
      return !!(this.baseUrl && this.realm)
    },
    
    get publicUrl() {
      if (process.env.KEYCLOAK_PUBLIC_URL) return process.env.KEYCLOAK_PUBLIC_URL
      if (!this.baseUrl) return null
      const domain = process.env.KEYCLOAK_DOMAIN;
      if (!domain) return this.baseUrl
      return this.baseUrl.replace(/\/\/([^:/]+)(:[0-9]+)?/, `//${domain}$2`)
    },
    
    get jwksUri() {
      if (!this.baseUrl || !this.realm) return null
      return `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/certs`
    },

    get expectedIssuer() {
      const base = this.publicUrl || this.baseUrl
      if (!base || !this.realm) return null
      return `${base}/realms/${this.realm}`
    },

    get accountApplicationsUrl() {
      const realmUrl = this.expectedIssuer
      return realmUrl ? `${realmUrl}/account/applications` : null
    },
  },

  // SHL token-exchange client (RFC 8693). Keycloak is reconciled to this secret at startup
  // (ensureShlExchangeClient), so it never belongs in realm-export; no secret disables SHL.
  shlExchange: {
    get clientId() {
      return process.env.SHL_EXCHANGE_CLIENT_ID || 'shl-exchange'
    },
    get clientSecret() {
      return process.env.SHL_EXCHANGE_CLIENT_SECRET || null
    },
    get isConfigured() {
      return !!this.clientSecret
    },
  },

  fhir: {
    serverBases: (process.env.FHIR_SERVER_BASE ?? 'http://localhost:8081/fhir').split(',').map(s => s.trim()),
    supportedVersions: process.env.FHIR_SUPPORTED_VERSIONS?.split(',').map(s => s.trim()) || ['R4'],
    // Upper bound on entries in a batch or transaction Bundle; each entry is authorised separately.
    get maxBundleEntries(): number {
      return positiveIntEnv('FHIR_BUNDLE_MAX_ENTRIES', 100)
    },
    get pagingCursorTtlMs(): number {
      return positiveIntEnv('FHIR_PAGING_CURSOR_TTL_MS', 3_600_000)
    },
    // Least time between metadata retries that a request for an unknown server name may trigger.
    get unknownServerRetryMs(): number {
      return nonNegativeInt(process.env.FHIR_UNKNOWN_SERVER_RETRY_MS, 10_000)
    },
  },

  smart: {
    configCacheTtl: parseInt(process.env.SMART_CONFIG_CACHE_TTL || '300000'),
    get scopesSupported(): string[] | undefined {
      return process.env.SMART_SCOPES_SUPPORTED?.split(',').map(s => s.trim()).filter(Boolean)
    },
    get capabilities(): string[] | undefined {
      return process.env.SMART_CAPABILITIES?.split(',').map(s => s.trim()).filter(Boolean)
    },
    // Scope a SMART bearer token needs to call /auth/introspect (SMART 2.2 Token Introspection).
    get introspectionScope(): string {
      return process.env.SMART_INTROSPECTION_SCOPE?.trim() || 'token-introspection'
    },
    get launchCodeTtlSeconds(): number {
      return parseInt(process.env.SMART_LAUNCH_CODE_TTL || '300', 10)
    },
    /** Backend Services: expires_in SHOULD NOT exceed 300. Default for client_credentials clients. */
    get backendServiceTokenLifespanSeconds(): number {
      return positiveIntEnv('BACKEND_SERVICE_TOKEN_LIFESPAN', 300)
    },
    /** JWS algorithms accepted on private_key_jwt client assertions. */
    get clientAssertionAlgorithms(): string[] {
      const listed = process.env.CLIENT_ASSERTION_ALGORITHMS?.split(',').map(s => s.trim()).filter(Boolean)
      return listed && listed.length > 0 ? listed : ['RS384', 'ES384']
    },
    jwks: {
      /** Lifetime of a client JWKS whose response carries no Cache-Control. */
      get defaultCacheTtlMs(): number {
        return nonNegativeInt(process.env.JWKS_CACHE_TTL_MS, 60_000)
      },
      get maxCacheTtlMs(): number {
        return positiveIntEnv('JWKS_CACHE_MAX_TTL_MS', 3_600_000)
      },
      get fetchTimeoutMs(): number {
        return positiveIntEnv('JWKS_FETCH_TIMEOUT_MS', 5_000)
      },
      /** Minimum gap between forced refetches of one client's keys after an unknown kid. */
      get refetchMinIntervalMs(): number {
        return positiveIntEnv('JWKS_REFETCH_MIN_INTERVAL_MS', 30_000)
      },
    },
  },

  network: {
    /** Reverse proxies in front of the backend that append to X-Forwarded-For. 0 trusts none. */
    get trustedProxyHops(): number {
      return nonNegativeInt(process.env.TRUSTED_PROXY_HOPS, 0)
    },
  },

  rateLimit: {
    /** Requests per minute per client IP on each OAuth credential endpoint. 0 turns it off. */
    get authPerMinute(): number {
      return nonNegativeInt(process.env.AUTH_RATE_LIMIT_PER_MINUTE, 0)
    },
  },

  // User-Access Brands (SMART App Launch 2.2.0 Section 8)
  brand: {
    get name() { return process.env.BRAND_NAME || packageJson.displayName || packageJson.name },
    get website() { return process.env.BRAND_WEBSITE || process.env.BASE_URL || 'http://localhost:8445' },
    get logoUrl() { return process.env.BRAND_LOGO_URL || null },
    get logoLicenseUrl() { return process.env.BRAND_LOGO_LICENSE_URL || null },
    get aliases(): string[] {
      return process.env.BRAND_ALIASES?.split(',').map(s => s.trim()).filter(Boolean) || []
    },
    get category() { return process.env.BRAND_CATEGORY || 'prov' },
    get portalName() { return process.env.BRAND_PORTAL_NAME || null },
    get portalUrl() { return process.env.BRAND_PORTAL_URL || null },
    get portalDescription() { return process.env.BRAND_PORTAL_DESCRIPTION || null },
    get portalLogoUrl() { return process.env.BRAND_PORTAL_LOGO_URL || null },
    get portalLogoLicenseUrl() { return process.env.BRAND_PORTAL_LOGO_LICENSE_URL || null },
    get addressLine() { return process.env.BRAND_ADDRESS_LINE || null },
    get addressCity() { return process.env.BRAND_ADDRESS_CITY || null },
    get addressState() { return process.env.BRAND_ADDRESS_STATE || null },
    get addressPostalCode() { return process.env.BRAND_ADDRESS_POSTAL_CODE || null },
    get addressCountry() { return process.env.BRAND_ADDRESS_COUNTRY || null },
    get identifier() { return process.env.BRAND_IDENTIFIER || process.env.BRAND_WEBSITE || process.env.BASE_URL || 'http://localhost:8445' },
    get identifierSystem() { return process.env.BRAND_IDENTIFIER_SYSTEM || 'urn:ietf:rfc:3986' },
    /** Endpoint.contact: where developers configure access. Unset falls back to the app registration docs. */
    get developerUrl(): string | null { return process.env.BRAND_DEVELOPER_URL || null },
    /** JSON array of BrandPortal objects. */
    get additionalPortals(): string | undefined { return process.env.BRAND_ADDITIONAL_PORTALS || undefined },
    get loginTheme(): string | null { return process.env.BRAND_LOGIN_THEME || null },
    get appStoreUrl(): string | null { return process.env.BRAND_APP_STORE_URL || null },
    get primaryColor(): string | null { return process.env.BRAND_PRIMARY_COLOR || null },
    get accentColor(): string | null { return process.env.BRAND_ACCENT_COLOR || null },
  },

  consent: {
    get enabled() {
      return parseSecurityFlag(process.env.CONSENT_ENABLED, ENFORCEMENT_DEFAULTS.consent !== 'disabled')
    },
    get mode(): EnforcementMode {
      return parseEnforcementMode(process.env.CONSENT_MODE, ENFORCEMENT_DEFAULTS.consent)
    },
    get cacheTtl() {
      return nonNegativeInt(process.env.CONSENT_CACHE_TTL, 60_000)
    },
    get exemptClients(): string[] {
      return process.env.CONSENT_EXEMPT_CLIENTS?.split(',').map(s => s.trim()).filter(Boolean) || []
    },
    get requiredForResourceTypes(): string[] {
      return process.env.CONSENT_REQUIRED_RESOURCE_TYPES?.split(',').map(s => s.trim()).filter(Boolean) || []
    },
    get exemptResourceTypes(): string[] {
      const defaults = ['CapabilityStatement', 'metadata']
      const env = process.env.CONSENT_EXEMPT_RESOURCE_TYPES?.split(',').map(s => s.trim()).filter(Boolean) || []
      return [...new Set([...defaults, ...env])]
    },
    /** URL to the consent management app (shown in 403 responses when consent is denied) */
    get appUrl(): string | null {
      return process.env.CONSENT_APP_URL || null
    }
  },

  ial: {
    get enabled() {
      return parseSecurityFlag(process.env.IAL_ENABLED, false)
    },
    get minimumLevel(): IdentityAssuranceLevel {
      return parseAssuranceLevel(process.env.IAL_MINIMUM_LEVEL, 'level1')
    },
    get sensitiveResourceTypes(): string[] {
      return process.env.IAL_SENSITIVE_RESOURCE_TYPES?.split(',').map(s => s.trim()).filter(Boolean) || []
    },
    get sensitiveMinimumLevel(): IdentityAssuranceLevel {
      return parseAssuranceLevel(process.env.IAL_SENSITIVE_MINIMUM_LEVEL, 'level3')
    },
    get verifyPatientLink() {
      return parseSecurityFlag(process.env.IAL_VERIFY_PATIENT_LINK, true)
    },
    get allowOnPersonLookupFailure() {
      return process.env.IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE === 'true'
    },
    get cacheTtl() {
      return nonNegativeInt(process.env.IAL_CACHE_TTL, 300_000)
    },
    /** Default for where a user links their account to a patient record; admins override it at runtime. */
    get onboardingUrl(): string | null {
      return process.env.PATIENT_ONBOARDING_URL || null
    }
  },

  accessControl: {
    get scopeEnforcement(): EnforcementMode {
      return parseEnforcementMode(process.env.SCOPE_ENFORCEMENT_MODE, ENFORCEMENT_DEFAULTS.scopeEnforcement)
    },
    get roleBasedFiltering(): EnforcementMode {
      return parseEnforcementMode(process.env.ROLE_BASED_FILTERING_MODE, ENFORCEMENT_DEFAULTS.roleBasedFiltering)
    },
    // Whether a FHIR request's token must carry this server's FHIR base (or its resource client) in aud
    get fhirAudienceEnforcement(): EnforcementMode {
      return parseEnforcementMode(process.env.FHIR_AUDIENCE_ENFORCEMENT, ENFORCEMENT_DEFAULTS.fhirAudience)
    },
    // External resource servers allowed as aud/resource in authorize requests.
    // Entries starting with '.' match all subdomains (e.g. '.maxhealth.tech').
    get externalAudiences(): string[] {
      return (process.env.ALLOWED_EXTERNAL_AUDIENCES || '').split(',').map(s => s.trim()).filter(Boolean)
    },
  },

  appState: {
    // SMART App State: the spec requires accepting resources up to 256KB, so the limit can only be raised.
    get maxResourceBytes(): number {
      const configured = parseInt(process.env.APP_STATE_MAX_RESOURCE_BYTES || '', 10)
      return Math.max(256 * 1024, Number.isFinite(configured) ? configured : 0)
    },
    get maxPerSubject(): number {
      const configured = parseInt(process.env.APP_STATE_MAX_PER_SUBJECT || '', 10)
      return Number.isFinite(configured) && configured > 0 ? configured : 20
    },
  },

  mcp: {
    get enabled(): boolean {
      return loadMcpEndpointConfig().enabled
    },
    get path() {
      return process.env.MCP_ENDPOINT_PATH || '/mcp'
    },
    // Off by default: prefab UIs move structuredContent into the view, so tools drop their outputSchema.
    get ui(): boolean {
      return process.env.MCP_PREFAB_UI === 'true'
    },
  },

  dicomweb: {
    get enabled() {
      return !!this.baseUrl
    },
    get baseUrl() {
      return process.env.DICOMWEB_BASE_URL || null
    },
    get wadoRoot() {
      return process.env.DICOMWEB_WADO_ROOT || this.baseUrl
    },
    get qidoRoot() {
      return process.env.DICOMWEB_QIDO_ROOT || this.baseUrl
    },
    get upstreamAuth() {
      if (process.env.DICOMWEB_UPSTREAM_AUTH) return process.env.DICOMWEB_UPSTREAM_AUTH
      const username = process.env.DICOMWEB_USERNAME
      const password = process.env.DICOMWEB_PASSWORD
      if (username && password) {
        return basicAuthHeader(username, password)
      }
      return null
    },
    get timeoutMs() {
      return positiveIntEnv('DICOMWEB_TIMEOUT_MS', 30_000)
    },
    get uploadAdmission(): UploadAdmissionConfig | null {
      const url = process.env.DICOM_UPLOAD_ADMISSION_URL?.trim()
      if (!url) return null
      return {
        url,
        secret: process.env.DICOM_UPLOAD_ADMISSION_SECRET || undefined,
        timeoutMs: positiveIntEnv('DICOM_UPLOAD_ADMISSION_TIMEOUT_MS', 3_000),
        onError: process.env.DICOM_UPLOAD_ADMISSION_ON_ERROR?.trim() === 'deny' ? 'deny' : 'allow',
      }
    },
  },

  // Client identity the proxy presents to its own FHIR and DICOMweb upstreams; an admin's per-server mTLS wins.
  upstreamTls: {
    get cert() { return pemEnv('UPSTREAM_MTLS_CERT_FILE', 'UPSTREAM_MTLS_CERT_PEM') },
    get key() { return pemEnv('UPSTREAM_MTLS_KEY_FILE', 'UPSTREAM_MTLS_KEY_PEM') },
    get ca() { return pemEnv('UPSTREAM_MTLS_CA_FILE', 'UPSTREAM_MTLS_CA_PEM') },
    /** Upstream hosts that get this identity; a leading '.' covers every subdomain. */
    get hosts(): string[] {
      return process.env.UPSTREAM_MTLS_HOSTS?.split(',').map(s => s.trim()).filter(Boolean) || []
    },
  },

  urlShortener: {
    get baseUrl() {
      return process.env.URL_SHORTENER_BASE || 'https://go.maxhealth.tech'
    },
    get enabled() {
      return process.env.URL_SHORTENER_ENABLED !== 'false'
    },
  },

  appStore: {
    get showAdminLink(): boolean {
      return process.env.APP_STORE_SHOW_ADMIN === 'true'
    },
  },

  // AGPL section 13 source offer, served by /source and /.well-known/agpl-source.
  source: {
    get repositoryUrl() {
      return process.env.SOURCE_REPOSITORY_URL || 'https://github.com/proxy-smart/proxy-smart'
    },
    // Mirrors REUSE.toml and package.json.
    get license() {
      return process.env.SOURCE_LICENSE || 'AGPL-3.0-or-later OR LicenseRef-Commercial'
    },
    get commercialContact() {
      return process.env.SOURCE_COMMERCIAL_CONTACT || 'hello@maxhealth.tech'
    },
  },

  cors: {
    get origins() {
      const defaultOrigins = [
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
        'http://localhost:5176',
        'http://localhost:3000',
        'http://localhost:4567',
        'http://localhost:8445',
        config.baseUrl
      ];

      // Deployed origins come from CORS_ORIGINS plus registered SMART apps' webOrigins (lib/cors-origins).
      const envOrigins = process.env.CORS_ORIGINS?.split(',').map(s => s.trim()) || [];

      if (process.env.NODE_ENV === 'production') {
        return [...new Set(envOrigins)].filter(Boolean);
      }

      return [...new Set([...defaultOrigins, ...envOrigins])].filter(Boolean);
    }
  }
} as const
