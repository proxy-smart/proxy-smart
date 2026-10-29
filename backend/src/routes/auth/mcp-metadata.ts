// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { getProxyJwks } from '@/lib/proxy-signing'
import { discoveryHandler } from './discovery-handlers'
import { MCP_SCOPES_SUPPORTED } from '@/lib/oauth-scopes'
import { ProtectedResourceMetadata, JWKSResponse } from '@/schemas'
import { isServedMcpPath } from '@/lib/mcp-resources'
import { Value } from '@sinclair/typebox/value'

/** MCP authorization discovery: RFC 9728 protected resource metadata and RFC 8414 AS metadata. */
export const mcpMetadataRoutes = new Elysia({ prefix: '/.well-known', tags: ['mcp-authorization'] })

  .get('/oauth-protected-resource', () => {
    const mcpPath = config.mcp?.path || '/mcp'

    return {
      // RFC 9728: resource MUST match the protected resource URL
      resource: `${config.baseUrl}${mcpPath}`,
      // Our own AS metadata carries the registration_endpoint; Keycloak's native DCR is blocked.
      authorization_servers: [
        config.baseUrl
      ],
      bearer_methods_supported: ['header'],
      resource_documentation: `${config.baseUrl}/docs`,
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

  // RFC 9728 §3.1: the well-known segment precedes the resource path, so the wildcard is that path.
  .get('/oauth-protected-resource/*', async ({ params, set }) => {
    const resourcePath = `/${params['*'] ?? ''}`.replace(/\/{2,}/g, '/')

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
      scopes_supported: [...MCP_SCOPES_SUPPORTED]
    }
  }, {
    detail: {
      summary: 'Get Protected Resource Metadata (path-scoped)',
      description: 'Path-scoped OAuth 2.0 Protected Resource Metadata (RFC 9728 §5.1)',
      tags: ['mcp-authorization']
    }
  })

  .get('/oauth-authorization-server', discoveryHandler('oauth-authorization-server'), {
    detail: {
      summary: 'Get OAuth 2.0 Authorization Server Metadata',
      description: 'Returns OAuth 2.0 Authorization Server Metadata (RFC 8414) for MCP authorization discovery',
      tags: ['mcp-authorization']
    }
  })

  .get('/openid-configuration', discoveryHandler('openid-configuration'), {
    detail: {
      summary: 'Get OpenID Connect Discovery',
      description: 'Returns OpenID Connect Discovery metadata (proxied from Keycloak)',
      tags: ['mcp-authorization']
    }
  })

  // MCP spec path insertion for an issuer with a path component (second priority).
  .get('/openid-configuration/auth', discoveryHandler('openid-configuration'), {
    detail: {
      summary: 'Get OpenID Connect Discovery (MCP path insertion)',
      description: 'Returns OpenID Connect Discovery metadata with path insertion for /auth',
      tags: ['mcp-authorization']
    }
  })

  // RFC 8414 path insertion; the first discovery URL MCP clients try.
  .get('/oauth-authorization-server/auth', discoveryHandler('oauth-authorization-server'), {
    detail: {
      summary: 'Get OAuth 2.0 Authorization Server Metadata (MCP path insertion)',
      description: 'Returns OAuth 2.0 AS Metadata with path insertion for /auth (highest priority per MCP spec)',
      tags: ['mcp-authorization']
    }
  })

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
      
      const kcJwks: unknown = await response.json()
      
      // Merge Keycloak keys (token validation) with proxy signing key (federated client auth)
      return { keys: [...(Value.Check(JWKSResponse, kcJwks) ? kcJwks.keys : []), ...proxyJwks.keys] }
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
