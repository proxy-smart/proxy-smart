// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { oauthRoutes } from './oauth'
import { clientRegistrationRoutes } from './client-registration'
import { config } from '@/config'
import { checkKeycloakConnection, isKeycloakAccessible } from '@/init'
import { AuthConfigResponse } from '@/schemas/auth/config'
import { rateLimit } from '@/lib/rate-limit'
import { buildAuthorizationServerMetadata, sanitizeDiscoveryDocument } from '@/lib/oidc-discovery'

/**
 * Authentication routes - OAuth2 and Dynamic Client Registration
 * 
 * This includes OAuth discovery endpoints under /auth per MCP spec:
 * - /auth/.well-known/openid-configuration (path appending)
 * These endpoints are accessed by MCP clients after discovering the
 * authorization server URL from the Protected Resource Metadata.
 */
export const authRoutes = new Elysia({ prefix: '/auth', tags: ['authentication'] })
  // Rate limit auth endpoints: 30 requests per minute per IP
  .use(rateLimit({ windowMs: 60_000, max: 30, message: 'Too many auth requests, please try again later' }))
  /**
   * OpenID Connect Discovery under /auth (MCP path appending)
   * 
   * Per MCP spec, for authorization server URLs with path components,
   * clients try: {auth_server_url}/.well-known/openid-configuration
   * 
   * So for auth server "http://localhost:8445/auth", clients will try:
   * http://localhost:8445/auth/.well-known/openid-configuration
   */
  .get('/.well-known/openid-configuration', async ({ set }) => {
    try {
      const keycloakBase = config.keycloak.publicUrl || config.keycloak.baseUrl
      const realm = config.keycloak.realm
      const oidcUrl = `${keycloakBase}/realms/${realm}/.well-known/openid-configuration`
      
      const response = await fetch(oidcUrl)
      
      if (!response.ok) {
        set.status = 502
        return {
          error: 'bad_gateway',
          error_description: 'Failed to fetch OpenID Connect configuration from authorization server'
        }
      }
      
      const oidcConfig = await response.json()

      // Rewrite proxy-fronted endpoints, strip mtls_endpoint_aliases, and drop
      // every remaining Keycloak-direct URL so nothing bypasses the proxy.
      return {
        ...sanitizeDiscoveryDocument(oidcConfig, config.baseUrl),
        client_id_metadata_document_supported: true,
      }
    } catch {
      set.status = 500
      return {
        error: 'server_error',
        error_description: 'Internal server error while fetching OpenID Connect configuration'
      }
    }
  }, {
    detail: {
      summary: 'Get OpenID Connect Discovery (MCP path appending)',
      description: 'Returns OpenID Connect Discovery metadata for MCP authorization server discovery',
      tags: ['authentication', 'mcp-authorization']
    }
  })
  
  /**
   * OAuth 2.0 Authorization Server Metadata under /auth (MCP path appending)
   * 
   * Alternative to OpenID Connect Discovery for OAuth 2.0 AS Metadata
   */
  .get('/.well-known/oauth-authorization-server', async ({ set }) => {
    try {
      const keycloakBase = config.keycloak.publicUrl || config.keycloak.baseUrl
      const realm = config.keycloak.realm
      
      // Fetch Keycloak's OIDC config to get accurate metadata
      const oidcUrl = `${keycloakBase}/realms/${realm}/.well-known/openid-configuration`
      const response = await fetch(oidcUrl)
      
      if (!response.ok) {
        set.status = 502
        return {
          error: 'bad_gateway',
          error_description: 'Failed to fetch authorization server metadata'
        }
      }
      
      const oidcConfig = await response.json()

      return buildAuthorizationServerMetadata(oidcConfig, config.baseUrl)
    } catch {
      set.status = 500
      return {
        error: 'server_error',
        error_description: 'Internal server error while fetching authorization server metadata'
      }
    }
  }, {
    detail: {
      summary: 'Get OAuth 2.0 Authorization Server Metadata (MCP path appending)',
      description: 'Returns OAuth 2.0 AS Metadata for MCP authorization server discovery',
      tags: ['authentication', 'mcp-authorization']
    }
  })
  
  .get('/config', async () => {
    // Test Keycloak connection and update global state
    try {
      await checkKeycloakConnection(1);
    } catch (error) {
      // checkKeycloakConnection() throws on failure, but we want to continue
      // and return the current state (which will be false)
      console.warn('Keycloak connection check failed:', error);
    }
    
    const keycloakAvailable = isKeycloakAccessible()
    return {
      keycloak: {
        isConfigured: keycloakAvailable,
        baseUrl: keycloakAvailable ? config.keycloak.baseUrl : null,
        realm: keycloakAvailable ? config.keycloak.realm : null,
        authorizationEndpoint: keycloakAvailable 
          ? `${config.keycloak.publicUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/auth`
          : null,
        tokenEndpoint: keycloakAvailable
          ? `${config.keycloak.publicUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/token`
          : null
      }
    }
  }, {
    detail: {
      summary: 'Get authentication configuration',
      description: 'Returns the current authentication configuration status',
      tags: ['authentication']
    },
    response: {
      200: AuthConfigResponse
    }
  })
  .use(oauthRoutes)
  .use(clientRegistrationRoutes)
