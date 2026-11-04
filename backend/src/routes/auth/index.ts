// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { oauthRoutes } from './oauth'
import { clientRegistrationRoutes } from './client-registration'
import { config } from '@/config'
import { isKeycloakAccessible } from '@/init'
import { AuthConfigResponse } from '@/schemas/auth/config'
import { discoveryHandler } from './discovery-handlers'
import { oauthErrorBoundary } from '@/lib/oauth-errors'

/** OAuth, DCR, and the AS metadata MCP clients find by appending `/.well-known/...` to `/auth`. */
export const authRoutes = new Elysia({ prefix: '/auth', tags: ['authentication'] })
  .use(oauthErrorBoundary)
  .get('/.well-known/openid-configuration', discoveryHandler('openid-configuration'), {
    detail: {
      summary: 'Get OpenID Connect Discovery (MCP path appending)',
      description: 'Returns OpenID Connect Discovery metadata for MCP authorization server discovery',
      tags: ['authentication', 'mcp-authorization']
    }
  })
  .get('/.well-known/oauth-authorization-server', discoveryHandler('oauth-authorization-server'), {
    detail: {
      summary: 'Get OAuth 2.0 Authorization Server Metadata (MCP path appending)',
      description: 'Returns OAuth 2.0 AS Metadata for MCP authorization server discovery',
      tags: ['authentication', 'mcp-authorization']
    }
  })
  .get('/config', () => {
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
