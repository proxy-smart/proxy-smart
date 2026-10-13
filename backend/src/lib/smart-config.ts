// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART Configuration Service
 * Dynamically builds SMART configuration from Keycloak's OpenID configuration
 * 
 * Implements SMART App Launch Framework 2.2.0 (STU 2.2)
 * - Supports both SMART 2.0 scopes (.cruds format) and v1 backwards compatibility
 * - Provides comprehensive launch context and identity management
 * - Integrates with Keycloak for OAuth2/OIDC authorization
 */

import { logger } from './logger'
import { config } from '../config'
import { getRuntimeBrandConfig } from './runtime-config'
import { APP_STATE_CAPABILITY, appStateAssociatedEndpoint } from './app-state/endpoint'
import type { SmartConfigurationResponseType } from '../schemas'

interface OpenIDConfiguration {
    issuer: string
    jwks_uri?: string
    authorization_endpoint: string
    token_endpoint: string
    introspection_endpoint?: string
    end_session_endpoint?: string
    grant_types_supported: string[]
    response_types_supported: string[]
    code_challenge_methods_supported: string[]
    token_endpoint_auth_methods_supported: string[]
    token_endpoint_auth_signing_alg_values_supported?: string[]
    scopes_supported?: string[]
}

interface CachedConfig {
    config: SmartConfigurationResponseType
    timestamp: number
    ttl: number
}

class SmartConfigService {
    private cachedConfig: CachedConfig | null = null
    private readonly cacheTTL = parseInt(process.env.SMART_CONFIG_CACHE_TTL || '300000') // 5 minutes default
    private readonly keycloakDiscoveryUrl = `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/.well-known/openid-configuration`

    /**
     * Get SMART configuration, using cache if available and valid
     */
    async getSmartConfiguration(): Promise<SmartConfigurationResponseType> {
        const now = Date.now()

        // Check if we have valid cached config
        if (this.cachedConfig && (now - this.cachedConfig.timestamp) < this.cachedConfig.ttl) {
            return this.cachedConfig.config
        }

        // Fetch fresh config from Keycloak
        const freshConfig = await this.fetchAndBuildSmartConfig()

        // Cache the result
        this.cachedConfig = {
            config: freshConfig,
            timestamp: now,
            ttl: this.cacheTTL
        }

        return freshConfig
    }

    /**
     * Fetch OpenID configuration from Keycloak and build SMART config
     */
    private async fetchAndBuildSmartConfig(): Promise<SmartConfigurationResponseType> {
        try {
            const response = await fetch(this.keycloakDiscoveryUrl, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'proxy-smart/1.0'
                },
                // Add timeout to prevent hanging
                signal: AbortSignal.timeout(10000) // 10 second timeout
            })

            if (!response.ok) {
                throw new Error(`Failed to fetch OpenID configuration: ${response.status} ${response.statusText}`)
            }

            const openidConfig: OpenIDConfiguration = await response.json()
            return this.buildSmartConfigFromOpenID(openidConfig)

        } catch (error) {
            logger.keycloak.error('Failed to fetch Keycloak OpenID configuration', { error })
            throw new Error(`SMART configuration unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error })
        }
    }

    /**
     * Build SMART configuration from OpenID configuration
     */
    private buildSmartConfigFromOpenID(openidConfig: OpenIDConfiguration): SmartConfigurationResponseType {
        // Build scopes - combine OpenID scopes with SMART-specific scopes
        const baseScopes = openidConfig.scopes_supported || ['openid', 'profile']
        const smartScopes = this.getSmartScopes()
        const allScopes = [...new Set([...baseScopes, ...smartScopes])]

        // SMART 2.2.0 spec: code_challenge_methods_supported SHALL include S256, SHALL NOT include plain
        // Filter out 'plain' from Keycloak's response to comply with SMART spec
        const codeChallengeMethodsFromKeycloak = openidConfig.code_challenge_methods_supported || ['S256']
        const smartCompliantCodeChallengeMethods = codeChallengeMethodsFromKeycloak.filter(
            (method: string) => method !== 'plain'
        )
        // Ensure S256 is included (required by SMART spec)
        if (!smartCompliantCodeChallengeMethods.includes('S256')) {
            smartCompliantCodeChallengeMethods.push('S256')
        }

        return {
            // Use our proxy endpoints, not Keycloak's direct endpoints
            issuer: openidConfig.issuer,
            authorization_endpoint: `${config.baseUrl}/auth/authorize`,
            token_endpoint: `${config.baseUrl}/auth/token`,
            introspection_endpoint: `${config.baseUrl}/auth/introspect`,
            registration_endpoint: `${config.baseUrl}/auth/register`, // RFC 7591 Dynamic Client Registration

            // RP-Initiated Logout (OpenID Connect RP-Initiated Logout 1.0)
            ...(openidConfig.end_session_endpoint ? { end_session_endpoint: `${config.baseUrl}/auth/logout` } : {}),

            // JWKS URI - required when sso-openid-connect capability is supported
            // Use Keycloak's JWKS endpoint directly for token validation
            jwks_uri: openidConfig.jwks_uri,

            // Use SMART-compliant code challenge methods (no 'plain')
            code_challenge_methods_supported: smartCompliantCodeChallengeMethods,
            grant_types_supported: openidConfig.grant_types_supported,
            response_types_supported: openidConfig.response_types_supported,
            token_endpoint_auth_methods_supported: openidConfig.token_endpoint_auth_methods_supported,
            token_endpoint_auth_signing_alg_values_supported: openidConfig.token_endpoint_auth_signing_alg_values_supported || ['RS256', 'RS384', 'ES384'],

            // Combine discovered and SMART-specific scopes
            scopes_supported: allScopes,

            // SMART capabilities based on what we support
            capabilities: this.getSmartCapabilities(),
            associated_endpoints: [appStateAssociatedEndpoint()],

            // User-Access Brands (SMART 2.2.0 Section 8) — RECOMMENDED
            user_access_brand_bundle: `${config.baseUrl}/branding.json`,
            user_access_brand_identifier: {
                system: 'urn:ietf:rfc:3986',
                value: config.brand.identifier
            },

            // App Store discovery (vendor extension)
            ...(() => { const url = getRuntimeBrandConfig().appStoreUrl; return url ? { app_store_url: url } : {} })(),
        }
    }

    /**
     * Get SMART-specific scopes based on SMART App Launch 2.2.0 specification
     */
    private getSmartScopes(): string[] {
        const envScopes = process.env.SMART_SCOPES_SUPPORTED?.split(',').map(s => s.trim())

        return envScopes || [
            // OpenID Connect scopes
            'openid',
            'profile',
            'fhirUser',

            // Launch context scopes
            'launch',
            'launch/patient',
            'launch/encounter',

            // Session management scopes
            'online_access',
            'offline_access',

            // Patient-level resource access (SMART 2.0 format)
            'patient/*.cruds',     // Full CRUDS access (create, read, update, delete, search)
            'patient/*.rs',        // Read and search access (SMART standard)
            'patient/*.read',      // v1 compatibility - mapped to .rs in v2
            'patient/*.write',     // v1 compatibility - mapped to .cud in v2
            'patient/*.*',         // v1 compatibility - mapped to .cruds in v2

            // User-level resource access (SMART 2.0 format)
            'user/*.cruds',        // Full CRUDS access
            'user/*.rs',           // Read and search access
            'user/*.read',         // v1 compatibility
            'user/*.write',        // v1 compatibility
            'user/*.*',            // v1 compatibility

            // System-level resource access (SMART 2.0 format)
            'system/*.cruds',      // Full CRUDS access
            'system/*.rs',         // Read and search access
            'system/*.read',       // v1 compatibility
            'system/*.write',      // v1 compatibility
            'system/*.*'           // v1 compatibility
        ]
    }

    /**
     * Get SMART capabilities based on SMART App Launch 2.2.0 specification
     */
    private getSmartCapabilities(): string[] {
        const envCapabilities = process.env.SMART_CAPABILITIES?.split(',').map(s => s.trim())

        return envCapabilities || [
            // Launch flows
            'launch-ehr',
            'launch-standalone',

            // Client types
            'client-public',
            'client-confidential-symmetric',
            'client-confidential-asymmetric',

            // Authentication & SSO
            'sso-openid-connect',

            // Context capabilities
            'context-standalone-patient',
            'context-ehr-patient',
            'context-ehr-encounter',

            // SMART 2.0 features
            'permission-offline',
            'permission-online',
            'permission-patient',
            'permission-user',
            'permission-v2',      // Indicates support for SMART 2.0 scopes (.cruds format)
            'permission-v1',      // Indicates backwards compatibility with SMART 1.0 scopes
            APP_STATE_CAPABILITY
        ]
    }

    /**
     * Clear cache - useful for testing or manual refresh
     */
    clearCache(): void {
        this.cachedConfig = null
    }
}

// Export singleton instance
export const smartConfigService = new SmartConfigService()
