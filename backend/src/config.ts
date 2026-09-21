// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'
import { loadMcpEndpointConfig } from './lib/mcp-endpoint-config'

// Per-process fallback secret for EHR Launch codes when SMART_LAUNCH_SECRET is not set.
// WARNING: This is NOT safe for multi-node deployments — set SMART_LAUNCH_SECRET env var.
const _defaultLaunchSecret = randomBytes(32).toString('hex')

// The admin-service secret seeded by keycloak/realm-export.json, the dev/CI fixture
// realm. It is published in this repo, so it must never authenticate production
// (enforced by the startup guard in index.ts).
export const DEV_FIXTURE_ADMIN_CLIENT_SECRET = 'admin-service-secret'

// Get package.json path - try multiple strategies for robustness
let packageJson: { name: string; displayName?: string; version: string }
try {
  // Strategy 1: Use import.meta.url (works in ES modules)
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const packageJsonPath = join(__dirname, '..', 'package.json')
  packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
} catch {
  // Strategy 2: Use process.cwd() (works in Bun)
  try {
    const packageJsonPath = resolve(process.cwd(), 'package.json')
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
  } catch {
    // Strategy 3: Fallback defaults
    packageJson = {
      name: 'proxy-smart-backend',
      displayName: 'Proxy Smart Backend',
      version: '0.0.1-alpha'
    }
  }
}

/**
 * The commit this build was made from, supplied by the builder rather than the repository.
 *
 * Lets the deployed version name its own source without the tree carrying a stamped
 * version — which is what makes develop, test and main rewrite the same manifest lines and
 * conflict. Absent (a local run), the version is the base one and nothing changes.
 */
function versionWithBuildSha(base: string): string {
  const sha = (process.env.BUILD_SHA || process.env.GITHUB_SHA || '').trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return base
  // A version the release automation already stamped carries the commit; do not say it twice.
  return base.includes(sha) ? base : `${base}+${sha}`
}

/**
 * Application configuration from environment variables
 */
export const config = {
  // Normalized here so the ~90 `${config.baseUrl}/path` call sites cannot emit a double slash.
  baseUrl: (process.env.BASE_URL || 'http://localhost:8445').replace(/\/+$/, ''),
  port: process.env.PORT || 8445,

  /**
   * Where a user finishes linking their account to a patient record.
   *
   * Shown as the way out when a launch is refused because the account carries no
   * `fhirUser` — an unfinished sign-up rather than a permission failure. Deployment-level
   * because only the deployment knows where its members sign up; unset simply drops the
   * link and the page still explains the situation.
   */
  patientOnboardingUrl: process.env.PATIENT_ONBOARDING_URL || '',

  /**
   * Where KEYCLOAK fetches this backend's JWKS to verify proxy-signed assertions.
   *
   * Set it whenever Keycloak cannot reach us at the docker-compose service name `backend` — on ECS
   * there is no such host, and the derived URL silently breaks every private_key_jwt client with
   * `invalid_client`. The public base URL works there, since Keycloak has egress to the load balancer.
   */
  proxySigningJwksUrl: process.env.PROXY_SIGNING_JWKS_URL || null,
  
  // Application name and version from package.json
  name: packageJson.name,
  displayName: packageJson.displayName || packageJson.name,
  version: versionWithBuildSha(packageJson.version),
  
  keycloak: {
    // Dynamic getters that read from process.env for real-time updates
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

    // The browser client the admin WEBAPP signs in with (see
    // frontend/ui/src/service/openid-service.ts). This is DISTINCT from
    // adminClientId, which is the backend's Keycloak admin-REST service account
    // (e.g. admin-service). validateAdminToken binds admin-user tokens to THIS
    // client's id (matched on aud/azp). Defaults to 'admin-ui'.
    get adminUiClientId() {
      return process.env.KEYCLOAK_ADMIN_UI_CLIENT_ID || 'admin-ui'
    },
    
    // Check if Keycloak is configured
    get isConfigured() {
      return !!(this.baseUrl && this.realm)
    },
    
    // Public URL for browser redirects (defaults to baseUrl if not specified)
    get publicUrl() {
      if (process.env.KEYCLOAK_PUBLIC_URL) return process.env.KEYCLOAK_PUBLIC_URL
      if (!this.baseUrl) return null
      const domain = process.env.KEYCLOAK_DOMAIN;
      if (!domain) return this.baseUrl
      // Use regex to replace the hostname in the URL, preserving protocol and port
      return this.baseUrl.replace(/\/\/([^:/]+)(:[0-9]+)?/, `//${domain}$2`)
    },
    
    // Dynamically construct JWKS URI from base URL and realm
    get jwksUri() {
      if (!this.baseUrl || !this.realm) return null
      return `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/certs`
    },

    // Expected token issuer — used for JWT issuer validation
    // Tokens from Keycloak have iss = <publicUrl>/realms/<realm>
    get expectedIssuer() {
      const base = this.publicUrl || this.baseUrl
      if (!base || !this.realm) return null
      return `${base}/realms/${this.realm}`
    },
  },

  // SMART Health Link token-exchange client (RFC 8693). Confidential Keycloak
  // service-account client the SHL flow authenticates as to mint scoped,
  // short-lived tokens. The secret is the single source of truth — Keycloak is
  // reconciled to it at startup (see ensureShlExchangeClient), so it must never
  // be hardcoded in realm-export. Fails closed: no secret ⇒ SHL disabled.
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
    // Support multiple FHIR servers - can be a single URL or comma-separated list
    serverBases: (process.env.FHIR_SERVER_BASE ?? 'http://localhost:8081/fhir').split(',').map(s => s.trim()),
    supportedVersions: process.env.FHIR_SUPPORTED_VERSIONS?.split(',').map(s => s.trim()) || ['R4'],
  },

  smart: {
    configCacheTtl: parseInt(process.env.SMART_CONFIG_CACHE_TTL || '300000'), // 5 minutes
    scopesSupported: process.env.SMART_SCOPES_SUPPORTED?.split(',').map(s => s.trim()),
    capabilities: process.env.SMART_CAPABILITIES?.split(',').map(s => s.trim()),
    // HMAC secret for signing EHR Launch codes (stateless JWT).
    // Auto-generated per process if not set — multi-node deployments MUST set this.
    get launchSecret(): string {
      return process.env.SMART_LAUNCH_SECRET || _defaultLaunchSecret
    },
    // Launch code TTL in seconds (default 5 minutes)
    get launchCodeTtlSeconds(): number {
      return parseInt(process.env.SMART_LAUNCH_CODE_TTL || '300', 10)
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
    get category() { return process.env.BRAND_CATEGORY || 'prov' }, // prov, pay, laboratory, etc.
    get portalName() { return process.env.BRAND_PORTAL_NAME || null },
    get portalUrl() { return process.env.BRAND_PORTAL_URL || null },
    get portalDescription() { return process.env.BRAND_PORTAL_DESCRIPTION || null },
    get portalLogoUrl() { return process.env.BRAND_PORTAL_LOGO_URL || null },
    get portalLogoLicenseUrl() { return process.env.BRAND_PORTAL_LOGO_LICENSE_URL || null },
    get addressCity() { return process.env.BRAND_ADDRESS_CITY || null },
    get addressState() { return process.env.BRAND_ADDRESS_STATE || null },
    get addressPostalCode() { return process.env.BRAND_ADDRESS_POSTAL_CODE || null },
    get addressCountry() { return process.env.BRAND_ADDRESS_COUNTRY || null },
    get identifier() { return process.env.BRAND_IDENTIFIER || process.env.BRAND_WEBSITE || process.env.BASE_URL || 'http://localhost:8445' },
    get loginTheme(): string | null { return process.env.BRAND_LOGIN_THEME || null },
    get appStoreUrl(): string | null { return process.env.BRAND_APP_STORE_URL || null },
    get primaryColor(): string | null { return process.env.BRAND_PRIMARY_COLOR || null },
    get accentColor(): string | null { return process.env.BRAND_ACCENT_COLOR || null },
  },

  ai: {
    /** True when SOME model is reachable — the gateway, or a direct provider key. */
    get enabled() {
      return this.gateway.isConfigured || !!this.openaiApiKey;
    },
    /** Direct provider key. The fallback when no gateway is configured. */
    get openaiApiKey() {
      return process.env.OPENAI_API_KEY || null;
    },
    get timeoutMs() {
      return Number.parseInt(process.env.AI_TIMEOUT_MS || '30000', 10);
    },
    /** Model id for document import and the scribe. */
    get model() {
      return process.env.AI_MODEL || 'gpt-5.4';
    },
    /**
     * LLM Gateway — an OpenAI-compatible proxy that meters usage, holds the
     * provider keys, and bills them. Preferred over a direct provider key
     * because a direct call is invisible to the ledger.
     */
    gateway: {
      get url() {
        return process.env.AI_GATEWAY_URL || null;
      },
      /**
       * Keycloak client the proxy authenticates to the gateway AS.
       *
       * A SERVICE ACCOUNT, deliberately, not the calling user: the gateway
       * meters against the token's `sub`, so forwarding a patient's SMART token
       * would make every patient a separate tenant with a separate wallet to
       * fund before their first import could run.
       */
      get clientId() {
        return process.env.AI_GATEWAY_CLIENT_ID || 'llm-gateway';
      },
      get clientSecret() {
        return process.env.AI_GATEWAY_CLIENT_SECRET || null;
      },
      get scope() {
        return process.env.AI_GATEWAY_SCOPE || 'openid';
      },
      get isConfigured() {
        return !!this.url && !!this.clientSecret;
      },
    },
  },

  consent: {
    // Consent enforcement configuration
    get enabled() {
      return process.env.CONSENT_ENABLED === 'true'
    },
    get mode(): 'enforce' | 'audit-only' | 'disabled' {
      const mode = process.env.CONSENT_MODE || 'audit-only'
      if (mode === 'enforce' || mode === 'audit-only' || mode === 'disabled') {
        return mode
      }
      return 'audit-only'
    },
    get cacheTtl() {
      return parseInt(process.env.CONSENT_CACHE_TTL || '60000', 10) // 1 minute default
    },
    get exemptClients(): string[] {
      return process.env.CONSENT_EXEMPT_CLIENTS?.split(',').map(s => s.trim()).filter(Boolean) || []
    },
    get requiredForResourceTypes(): string[] {
      return process.env.CONSENT_REQUIRED_RESOURCE_TYPES?.split(',').map(s => s.trim()).filter(Boolean) || []
    },
    get exemptResourceTypes(): string[] {
      // By default, exempt metadata and capability statement
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
    // Identity Assurance Level (IAL) configuration for Person→Patient linking
    get enabled() {
      return process.env.IAL_ENABLED === 'true'
    },
    get minimumLevel(): 'level1' | 'level2' | 'level3' | 'level4' {
      const level = process.env.IAL_MINIMUM_LEVEL || 'level1'
      if (['level1', 'level2', 'level3', 'level4'].includes(level)) {
        return level as 'level1' | 'level2' | 'level3' | 'level4'
      }
      return 'level1'
    },
    get sensitiveResourceTypes(): string[] {
      // Resources requiring elevated IAL (e.g., MedicationRequest, DiagnosticReport)
      return process.env.IAL_SENSITIVE_RESOURCE_TYPES?.split(',').map(s => s.trim()).filter(Boolean) || []
    },
    get sensitiveMinimumLevel(): 'level1' | 'level2' | 'level3' | 'level4' {
      const level = process.env.IAL_SENSITIVE_MINIMUM_LEVEL || 'level3'
      if (['level1', 'level2', 'level3', 'level4'].includes(level)) {
        return level as 'level1' | 'level2' | 'level3' | 'level4'
      }
      return 'level3'
    },
    get verifyPatientLink() {
      // Verify that token's patient claim matches Person.link[]. Default true.
      return process.env.IAL_VERIFY_PATIENT_LINK !== 'false'
    },
    get allowOnPersonLookupFailure() {
      // Whether to allow access if Person lookup fails. Default false (deny).
      return process.env.IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE === 'true'
    },
    get cacheTtl() {
      // Cache TTL for Person resources (5 minutes default)
      return parseInt(process.env.IAL_CACHE_TTL || '300000', 10)
    }
  },

  accessControl: {
    // SMART scope enforcement — validates token scopes against requested FHIR resources
    get scopeEnforcement(): 'enforce' | 'audit-only' | 'disabled' {
      const mode = process.env.SCOPE_ENFORCEMENT_MODE || 'enforce'
      if (mode === 'enforce' || mode === 'audit-only' || mode === 'disabled') return mode
      return 'enforce'
    },
    // Role-based filtering using fhirUser claim (e.g. generalPractitioner-based isolation)
    get roleBasedFiltering(): 'enforce' | 'audit-only' | 'disabled' {
      const mode = process.env.ROLE_BASED_FILTERING_MODE || 'audit-only'
      if (mode === 'enforce' || mode === 'audit-only' || mode === 'disabled') return mode
      return 'audit-only'
    },
    // Clinical resource types subject to patient-scoped filtering
    get patientScopedResources(): string[] {
      const defaults = ['Observation', 'Condition', 'Procedure', 'MedicationRequest', 'MedicationStatement', 'DiagnosticReport', 'Encounter', 'AllergyIntolerance', 'ImagingStudy', 'CarePlan', 'Consent']
      const env = process.env.PATIENT_SCOPED_RESOURCES?.split(',').map(s => s.trim()).filter(Boolean)
      return env && env.length > 0 ? env : defaults
    },
    // External resource servers allowed as aud/resource in authorize requests.
    // Entries starting with '.' match all subdomains (e.g. '.maxhealth.tech').
    get externalAudiences(): string[] {
      return (process.env.ALLOWED_EXTERNAL_AUDIENCES || '').split(',').map(s => s.trim()).filter(Boolean)
    },
  },

  kisi: {
    // Kisi Access Control integration
    get apiKey() {
      return process.env.KISI_API_KEY || null
    },
    get baseUrl() {
      return process.env.KISI_BASE_URL || 'https://api.kisi.io'
    },
    get timeout() {
      return Number.parseInt(process.env.KISI_TIMEOUT_MS || '10000', 10)
    },
    get isConfigured() {
      return !!this.apiKey
    },
  },

  unifiAccess: {
    // UniFi Access local controller integration
    get host() {
      return process.env.UNIFI_ACCESS_HOST || null
    },
    get username() {
      return process.env.UNIFI_ACCESS_USERNAME || null
    },
    get password() {
      return process.env.UNIFI_ACCESS_PASSWORD || null
    },
    get isConfigured() {
      return !!(this.host && this.username && this.password)
    },
  },

  mcp: {
    // MCP endpoint configuration — exposes backend tools as a Streamable HTTP MCP server.
    // The file-backed config (mcp-endpoint.json, managed via the admin UI) is the single
    // source of truth for whether the endpoint is enabled. Enabled by default.
    get enabled(): boolean {
      return loadMcpEndpointConfig().enabled
    },
    get path() {
      return process.env.MCP_ENDPOINT_PATH || '/mcp'
    },
    // Render tool results as prefab UIs for MCP Apps hosts (VS Code, Claude
    // Desktop, ChatGPT). Off by default: it moves structuredContent from the
    // route payload to the rendered view, so tools stop advertising an
    // outputSchema — see mcp-endpoint.ts.
    get ui(): boolean {
      return process.env.MCP_PREFAB_UI === 'true'
    },
  },

  dicomweb: {
    // DICOMweb proxy configuration — proxies WADO-RS / QIDO-RS requests to a PACS
    get enabled() {
      return !!this.baseUrl
    },
    get baseUrl() {
      return process.env.DICOMWEB_BASE_URL || null // e.g. http://orthanc:8042/dicom-web
    },
    get wadoRoot() {
      return process.env.DICOMWEB_WADO_ROOT || this.baseUrl // WADO-RS root, defaults to baseUrl
    },
    get qidoRoot() {
      return process.env.DICOMWEB_QIDO_ROOT || this.baseUrl // QIDO-RS root, defaults to baseUrl
    },
    // Optional auth for upstream PACS (e.g. Basic auth for Orthanc)
    // Supports explicit DICOMWEB_UPSTREAM_AUTH header, or auto-builds from DICOMWEB_USERNAME/PASSWORD
    get upstreamAuth() {
      if (process.env.DICOMWEB_UPSTREAM_AUTH) return process.env.DICOMWEB_UPSTREAM_AUTH
      const username = process.env.DICOMWEB_USERNAME
      const password = process.env.DICOMWEB_PASSWORD
      if (username && password) {
        return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      }
      return null
    },
    get timeoutMs() {
      return Number.parseInt(process.env.DICOMWEB_TIMEOUT_MS || '30000', 10)
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

  // AGPL section 13 source offer. This software is dual-licensed
  // (AGPL-3.0-or-later OR a commercial license); when it runs as a network
  // service under the AGPL, users interacting with it over the network must be
  // offered the corresponding source for the exact version deployed. The
  // /source route and /.well-known/agpl-source discharge that obligation using
  // these values (env-overridable for downstream self-hosters/forks).
  source: {
    get repositoryUrl() {
      return process.env.SOURCE_REPOSITORY_URL || 'https://github.com/proxy-smart/proxy-smart'
    },
    // SPDX expression — single source of truth, mirrors REUSE.toml / package.json.
    get license() {
      return process.env.SOURCE_LICENSE || 'AGPL-3.0-or-later OR LicenseRef-Commercial'
    },
    get commercialContact() {
      return process.env.SOURCE_COMMERCIAL_CONTACT || 'hello@maxhealth.tech'
    },
  },

  cors: {
    // Support multiple origins - can be a single URL or comma-separated list
    // Defaults to common development origins
    get origins() {
      const defaultOrigins = [
        'http://localhost:5173', // Vite dev server (admin UI)
        'http://localhost:5174', // Vite dev server (consent app)
        'http://localhost:5175', // Vite dev server (DTR app)
        'http://localhost:5176', // Vite dev server (patient picker)
        'http://localhost:3000', // React dev server  
        'http://localhost:4567', // Inferno SMART compliance test runner
        'http://localhost:8445', // App server
        config.baseUrl // Fallback to base URL
      ];

      // Deployed origins come from CORS_ORIGINS, or from the webOrigins of the
      // SMART apps registered in Keycloak (see lib/cors-origins). A hardcoded
      // per-app list used to live here as a "fallback if Keycloak refresh
      // fails"; it silently became the real mechanism, so registering an app's
      // origin did nothing and every new app or environment needed a code
      // change. That is how dicom.beta.maxhealth.tech ended up blocked while
      // dicom.maxhealth.tech worked.
      const envOrigins = process.env.CORS_ORIGINS?.split(',').map(s => s.trim()) || [];

      // Localhost defaults are for development only: shipping them in a
      // deployed environment widens the policy for no one's benefit.
      if (process.env.NODE_ENV === 'production') {
        return [...new Set(envOrigins)].filter(Boolean);
      }

      return [...new Set([...defaultOrigins, ...envOrigins])].filter(Boolean);
    }
  }
} as const
