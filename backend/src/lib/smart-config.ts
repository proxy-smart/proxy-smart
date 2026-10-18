// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART Configuration Service
 *
 * Builds `.well-known/smart-configuration` (SMART App Launch 2.2.0) from Keycloak's OpenID
 * configuration: the proxy's endpoints, Keycloak's issuer and JWKS for id_token validation, and
 * only the grants, client authentication and scopes that work through the proxy.
 */

import { logger } from './logger'
import { config } from '../config'
import { getRuntimeBrandConfig, getRuntimeConsentConfig } from './runtime-config'
import { proxyOAuthCapabilities, proxyOAuthEndpoints } from './oidc-discovery'
import { brandIdentifier } from './brand-resources'
import { requireRecord } from './type-guards'
import { APP_STATE_CAPABILITY, appStateAssociatedEndpoint } from './app-state/endpoint'
import type { SmartConfigurationResponseType } from '../schemas'

/** SMART capability that obliges `issuer` and `jwks_uri` (SMART 2.2 conformance). */
const SSO_OPENID_CONNECT = 'sso-openid-connect'

/** The scopes the proxy prefers to advertise, where Keycloak has them; SMART_SCOPES_SUPPORTED overrides. */
const DEFAULT_SMART_SCOPES = [
  'openid',
  'profile',
  'fhirUser',
  'launch',
  'launch/patient',
  'launch/encounter',
  'online_access',
  'offline_access',
  // SMART v2 wildcards, the requests the spec's examples make
  'patient/*.cruds',
  'patient/*.rs',
  'user/*.cruds',
  'user/*.rs',
  'system/*.cruds',
  'system/*.rs',
  // SMART v1 compatibility (permission-v1)
  'patient/*.read',
  'patient/*.write',
  'patient/*.*',
  'user/*.read',
  'user/*.write',
  'user/*.*',
  'system/*.read',
  'system/*.write',
  'system/*.*',
] as const

const DEFAULT_SMART_CAPABILITIES = [
  'launch-ehr',
  'launch-standalone',
  'authorize-post',
  'client-public',
  'client-confidential-symmetric',
  'client-confidential-asymmetric',
  SSO_OPENID_CONNECT,
  'context-standalone-patient',
  'context-standalone-encounter',
  'context-ehr-patient',
  'context-ehr-encounter',
  // need_patient_banner and smart_style_url, carried from the EHR launch
  'context-banner',
  'context-style',
  'permission-offline',
  'permission-online',
  'permission-patient',
  'permission-user',
  'permission-v2',
  'permission-v1',
  APP_STATE_CAPABILITY,
] as const

/** The SMART scopes this deployment advertises and keeps provisioned in Keycloak. */
export function smartScopesSupported(): string[] {
  return config.smart.scopesSupported ?? [...DEFAULT_SMART_SCOPES]
}

export function smartCapabilities(): string[] {
  return config.smart.capabilities ?? [...DEFAULT_SMART_CAPABILITIES]
}

/** Keycloak's discovery could not be read, so neither can the SMART configuration be built. */
export class SmartConfigurationUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SmartConfigurationUnavailableError'
  }
}

interface CachedConfig {
    config: SmartConfigurationResponseType
    timestamp: number
}

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

class SmartConfigService {
    private cachedConfig: CachedConfig | null = null

    private get keycloakDiscoveryUrl(): string {
        return `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/.well-known/openid-configuration`
    }

    /** SMART configuration, from cache while it is fresh. */
    async getSmartConfiguration(): Promise<SmartConfigurationResponseType> {
        const now = Date.now()
        if (this.cachedConfig && (now - this.cachedConfig.timestamp) < config.smart.configCacheTtl) {
            return this.cachedConfig.config
        }

        const freshConfig = this.buildSmartConfigFromOpenID(await this.fetchOpenIdConfiguration())
        this.cachedConfig = { config: freshConfig, timestamp: now }
        return freshConfig
    }

    private async fetchOpenIdConfiguration(): Promise<Record<string, unknown>> {
        try {
            const response = await fetch(this.keycloakDiscoveryUrl, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'proxy-smart/1.0' },
                signal: AbortSignal.timeout(10000),
            })
            if (!response.ok) {
                throw new Error(`Failed to fetch OpenID configuration: ${response.status} ${response.statusText}`)
            }
            return requireRecord(await response.json(), 'OpenID configuration')
        } catch (error) {
            logger.keycloak.error('Failed to fetch Keycloak OpenID configuration', { error })
            throw new SmartConfigurationUnavailableError(
                `SMART configuration unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
                { cause: error },
            )
        }
    }

    private buildSmartConfigFromOpenID(openidConfig: Record<string, unknown>): SmartConfigurationResponseType {
        const endpoints = proxyOAuthEndpoints(config.baseUrl)
        const capabilities = smartCapabilities()
        const managementEndpoint = this.getManagementEndpoint()
        const issuer = stringOf(openidConfig.issuer)
        const jwksUri = stringOf(openidConfig.jwks_uri)
        const appStoreUrl = getRuntimeBrandConfig().appStoreUrl

        return {
            // The realm issuer, which id_tokens carry; omitted unless sso-openid-connect is offered.
            ...(issuer && capabilities.includes(SSO_OPENID_CONNECT) ? { issuer } : {}),
            authorization_endpoint: endpoints.authorization_endpoint,
            token_endpoint: endpoints.token_endpoint,
            introspection_endpoint: endpoints.introspection_endpoint,
            registration_endpoint: endpoints.registration_endpoint,
            revocation_endpoint: endpoints.revocation_endpoint,
            ...(managementEndpoint ? { management_endpoint: managementEndpoint } : {}),
            ...(openidConfig.end_session_endpoint ? { end_session_endpoint: endpoints.end_session_endpoint } : {}),
            // Keycloak's JWKS, which verifies the id_tokens it signs
            ...(jwksUri ? { jwks_uri: jwksUri } : {}),
            ...proxyOAuthCapabilities(openidConfig, smartScopesSupported()),
            capabilities,
            ...(capabilities.includes(APP_STATE_CAPABILITY) ? { associated_endpoints: [appStateAssociatedEndpoint()] } : {}),
            // User-Access Brands (SMART 2.2.0 Section 8)
            user_access_brand_bundle: `${config.baseUrl}/branding.json`,
            user_access_brand_identifier: brandIdentifier(getRuntimeBrandConfig()),
            // App Store discovery (vendor extension)
            ...(appStoreUrl ? { app_store_url: appStoreUrl } : {}),
        }
    }

    /** Where a user sees and revokes the apps they authorized: the consent app, else Keycloak's account console. */
    private getManagementEndpoint(): string | null {
        return getRuntimeConsentConfig().appUrl || config.keycloak.accountApplicationsUrl
    }

    clearCache(): void {
        this.cachedConfig = null
    }
}

export const smartConfigService = new SmartConfigService()
