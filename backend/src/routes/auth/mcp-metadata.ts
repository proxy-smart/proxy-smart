// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { getProxyJwks } from '@/lib/proxy-signing'
import { buildAuthorizationServerMetadata, sanitizeDiscoveryDocument } from '@/lib/oidc-discovery'
import { MCP_SCOPES_SUPPORTED } from '@/lib/oauth-scopes'
import { ProtectedResourceMetadata, JWKSResponse } from '@/schemas'
import { isServedMcpPath } from '@/lib/mcp-resources'

/**
 * OAuth 2.0 Protected Resource Metadata for MCP Authorization
 * 
 * Implements RFC 9728 - OAuth 2.0 Protected Resource Metadata
 * https://datatracker.ietf.org/doc/html/rfc9728
 * 
 * This tells MCP clients (like Claude Desktop) where to find the
 * authorization server and what scopes are supported.
 */


/**
 * MCP OAuth metadata routes
 */
export const mcpMetadataRoutes = new Elysia({ prefix: '/.well-known', tags: ['mcp-authorization'] })
  
  /**
   * Protected Resource Metadata (RFC 9728)
   * 
   * This is the entry point for MCP authorization discovery.
   * MCP clients will:
   * 1. Receive 401 from protected endpoints
   * 2. Fetch this metadata
   * 3. Discover authorization_servers
   * 4. Fetch authorization server metadata
   * 5. Initiate OAuth flow
   */
  .get('/oauth-protected-resource', () => {
    const mcpPath = config.mcp?.path || '/mcp'

    return {
      // RFC 9728: resource MUST match the protected resource URL
      resource: `${config.baseUrl}${mcpPath}`,
      // Point to our own proxy so clients fetch our /.well-known/oauth-authorization-server
      // which has the correct registration_endpoint (Keycloak's native DCR is blocked)
      authorization_servers: [
        config.baseUrl
      ],
      bearer_methods_supported: ['header'],
      resource_documentation: `${config.baseUrl}/docs`,
      // Single source of truth — whatever is advertised here is also granted to every client
      // the backend provisions (see lib/oauth-scopes).
      scopes_supported: [...MCP_SCOPES_SUPPORTED]
    }
  }, {
    detail: {
      summary: 'Get Protected Resource Metadata',
      description: 'Returns OAuth 2.0 Protected Resource Metadata (RFC 9728) for MCP authorization discovery',
      tags: ['mcp-authorization']
    },
    response: {
      200: ProtectedResourceMetadata
    }
  })

  // Path-based resource metadata discovery (RFC 9728 §5.1)
  // Clients may request /.well-known/oauth-protected-resource{path} for path-scoped resources
  .get('/oauth-protected-resource/*', async ({ params, set }) => {
    /*
     * §3.1 inserts the well-known segment between host and resource path, so the wildcard IS
     * the resource's path. This returned the admin MCP for every path instead, which a client
     * validating `resource` against the endpoint it asked about must reject — so no per-server
     * FHIR MCP endpoint could be authorized against at all.
     */
    const resourcePath = `/${params['*'] ?? ''}`.replace(/\/{2,}/g, '/')

    // Only describe a resource that IS one. The wildcard used to answer 200 for any path at
    // all, so a client could discover an authorization server for an endpoint that does not
    // exist, or whose MCP is switched off, and only learn otherwise after signing in.
    if (!(await isServedMcpPath(resourcePath))) {
      set.status = 404
      return { error: 'not_found', message: `No protected resource at '${resourcePath}'` }
    }

    return {
      resource: `${config.baseUrl}${resourcePath}`,
      authorization_servers: [
        config.baseUrl
      ],
      bearer_methods_supported: ['header'],
      resource_documentation: `${config.baseUrl}/docs`,
      // Single source of truth — whatever is advertised here is also granted to every client
      // the backend provisions (see lib/oauth-scopes).
      scopes_supported: [...MCP_SCOPES_SUPPORTED]
    }
  }, {
    detail: {
      summary: 'Get Protected Resource Metadata (path-scoped)',
      description: 'Path-scoped OAuth 2.0 Protected Resource Metadata (RFC 9728 §5.1)',
      tags: ['mcp-authorization']
    }
  })
  
  /**
   * Authorization Server Metadata (RFC 8414)
   * 
   * This provides MCP clients with the OAuth endpoints they need.
   * Points to our proxy's OAuth routes, which forward to Keycloak.
   */
  .get('/oauth-authorization-server', async ({ set }) => {
    try {
      const keycloakBase = config.keycloak.publicUrl || config.keycloak.baseUrl
      const realm = config.keycloak.realm

      // Fetch Keycloak's OIDC config to derive OAuth AS metadata (RFC 8414)
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
      summary: 'Get OAuth 2.0 Authorization Server Metadata',
      description: 'Returns OAuth 2.0 Authorization Server Metadata (RFC 8414) for MCP authorization discovery',
      tags: ['mcp-authorization']
    }
  })
  
  /**
   * OpenID Connect Discovery (Alternative for compatibility)
   * 
   * Proxies directly to Keycloak's OpenID Connect Discovery endpoint.
   * This ensures we always have up-to-date metadata from Keycloak.
   */
  .get('/openid-configuration', async ({ set }) => {
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
      return sanitizeDiscoveryDocument(oidcConfig, config.baseUrl)
    } catch {
      set.status = 500
      return {
        error: 'server_error',
        error_description: 'Internal server error while fetching OpenID Connect configuration'
      }
    }
  }, {
    detail: {
      summary: 'Get OpenID Connect Discovery',
      description: 'Returns OpenID Connect Discovery metadata (proxied from Keycloak)',
      tags: ['mcp-authorization']
    }
  })

  /**
   * OpenID Connect Discovery with Path Insertion (MCP Priority #2)
   * 
   * Per MCP spec, for authorization server URLs with path components like
   * "http://localhost:8445/auth", clients try path insertion:
   * http://localhost:8445/.well-known/openid-configuration/auth
   * 
   * This is the second-priority discovery method after oauth-authorization-server.
   */
  .get('/openid-configuration/auth', async ({ set }) => {
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
      return sanitizeDiscoveryDocument(oidcConfig, config.baseUrl)
    } catch {
      set.status = 500
      return {
        error: 'server_error',
        error_description: 'Internal server error while fetching OpenID Connect configuration'
      }
    }
  }, {
    detail: {
      summary: 'Get OpenID Connect Discovery (MCP path insertion)',
      description: 'Returns OpenID Connect Discovery metadata with path insertion for /auth',
      tags: ['mcp-authorization']
    }
  })

  /**
   * OAuth 2.0 Authorization Server Metadata with Path Insertion (MCP Priority #1)
   * 
   * Per MCP spec, for authorization server URLs with path components like
   * "http://localhost:8445/auth", clients FIRST try path insertion:
   * http://localhost:8445/.well-known/oauth-authorization-server/auth
   * 
   * This is the highest-priority discovery method per RFC 8414.
   */
  .get('/oauth-authorization-server/auth', async ({ set }) => {
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
      summary: 'Get OAuth 2.0 Authorization Server Metadata (MCP path insertion)',
      description: 'Returns OAuth 2.0 AS Metadata with path insertion for /auth (highest priority per MCP spec)',
      tags: ['mcp-authorization']
    }
  })

  /**
   * JWKS Endpoint (JSON Web Key Set) - RFC 8414 Standard Location
   * 
   * Provides the JSON Web Key Set for token signature validation.
   * This is the standard location per RFC 8414 section 3.
   * 
   * Proxies to Keycloak's JWKS endpoint so clients (including MCP servers)
   * can validate tokens without knowing about Keycloak directly.
   */
  .get('/jwks.json', async () => {
    const proxyJwks = getProxyJwks()
    try {
      const keycloakBase = config.keycloak.publicUrl || config.keycloak.baseUrl
      const realm = config.keycloak.realm
      const jwksUrl = `${keycloakBase}/realms/${realm}/protocol/openid-connect/certs`
      
      const response = await fetch(jwksUrl)
      
      if (!response.ok) {
        logger.auth.warn('Failed to fetch JWKS from Keycloak, serving proxy keys only', {
          status: response.status,
          statusText: response.statusText,
          jwksUrl
        })
        return proxyJwks
      }
      
      const kcJwks = await response.json()
      
      // Merge Keycloak keys (token validation) with proxy signing key (federated client auth)
      return { keys: [...(kcJwks.keys || []), ...proxyJwks.keys] }
    } catch (error) {
      logger.auth.warn('Error fetching JWKS from Keycloak, serving proxy keys only', { error })
      return proxyJwks
    }
  }, {
    detail: {
      summary: 'Get JSON Web Key Set',
      description: 'Returns JWKS for token signature validation (RFC 8414 standard location, proxied from Keycloak)',
      tags: ['mcp-authorization']
    },
    response: {
      200: JWKSResponse
    }
  })
