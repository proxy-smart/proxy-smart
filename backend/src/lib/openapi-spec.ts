// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { openapi, fromTypes } from '@elysiajs/openapi'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from '@/config'

/** The api-client generator consumes 3.0 `nullable`; @elysiajs/openapi defaults to 3.1 since 1.4.16. */
export const OPENAPI_VERSION = '3.0.3'

const TAGS = [
  { name: 'authentication', description: 'Authentication and authorization endpoints' },
  { name: 'users', description: 'Healthcare user management' },
  { name: 'admin', description: 'Administrative operations' },
  { name: 'fhir', description: 'FHIR resource proxy endpoints' },
  { name: 'servers', description: 'FHIR server discovery endpoints' },
  { name: 'identity-providers', description: 'Identity provider management' },
  { name: 'smart-apps', description: 'SMART on FHIR configuration endpoints' },
  { name: 'oauth-ws-monitoring', description: 'OAuth monitoring via WebSocket' },
  { name: 'oauth-sse-monitoring', description: 'OAuth monitoring via Server-Sent Events' },
  { name: 'ai', description: 'AI assistant endpoints with unified internal and MCP tools' },
  { name: 'mcp-management', description: 'MCP server management endpoints' },
  { name: 'mcp-endpoint', description: 'Built-in MCP Streamable HTTP server endpoint' },
  { name: 'consent-monitoring', description: 'Consent decision monitoring and analytics' },
  { name: 'fhir-monitoring', description: 'FHIR server uptime monitoring' },
  { name: 'fhir-proxy-monitoring', description: 'FHIR proxy request metrics and error tracking' },
  { name: 'admin-audit-monitoring', description: 'Admin action audit trail and analytics' },
  { name: 'email-monitoring', description: 'Email event monitoring (password resets, verifications)' },
  { name: 'auth-monitoring', description: 'Auth event monitoring (logins, logouts, registrations, token exchanges)' },
  { name: 'dicomweb', description: 'DICOMweb proxy for WADO-RS and QIDO-RS imaging services' },
  { name: 'shl', description: 'SMART Health Links for QR-based patient data sharing' },
]

const BASE_SCOPES = {
  'openid': 'OpenID Connect authentication',
  'profile': 'User profile information',
  'email': 'User email address',
}

function securitySchemes(baseUrl: string) {
  const tokenUrl = `${baseUrl}/auth/token`
  return {
    BearerAuth: {
      type: 'http' as const,
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'JWT Bearer token from OAuth2 flow',
    },
    OAuth2: {
      type: 'oauth2' as const,
      description: 'OAuth2 authentication via Keycloak with SMART on FHIR support',
      flows: {
        authorizationCode: {
          authorizationUrl: `${baseUrl}/auth/authorize`,
          tokenUrl,
          refreshUrl: tokenUrl,
          scopes: {
            ...BASE_SCOPES,
            'patient/*.read': 'Read all patient data',
            'patient/*.write': 'Write all patient data',
            'user/*.read': 'Read all data for current user',
            'user/*.write': 'Write all data for current user',
            'launch': 'SMART launch context',
            'launch/patient': 'SMART launch with patient context',
            'launch/encounter': 'SMART launch with encounter context',
            'offline_access': 'Offline access via refresh token',
          },
        },
        password: { tokenUrl, refreshUrl: tokenUrl, scopes: BASE_SCOPES },
        clientCredentials: {
          tokenUrl,
          scopes: {
            'system/*.read': 'System-level read access to FHIR resources',
            'system/*.write': 'System-level write access to FHIR resources',
          },
        },
      },
    },
    MutualTLS: {
      type: 'http' as const,
      scheme: 'mutual-tls',
      description: 'Mutual TLS authentication for secure API communication between proxy and FHIR servers. Submit a request to the infrastructure team with full information about your application to obtain a client certificate.',
    },
  }
}

/** One definition for the served /swagger and the exported spec, so the two cannot drift. */
export function openapiPlugin() {
  return openapi({
    path: '/swagger',
    openapiVersion: OPENAPI_VERSION,
    references: fromTypes(
      process.env.NODE_ENV === 'production' ? 'dist/index.d.ts' : 'src/index.ts',
      // Per process: the generator wipes its tmp dir, so a shared one breaks concurrent exports.
      { projectRoot: join(import.meta.dir, '..', '..'), tmpRoot: join(tmpdir(), `.ElysiaAutoOpenAPI-${process.pid}`) },
    ),
    documentation: {
      info: {
        title: config.displayName,
        version: config.version,
        description: 'SMART on FHIR Proxy + Healthcare Administration API using Keycloak and Elysia',
      },
      tags: TAGS,
      components: { securitySchemes: securitySchemes(config.baseUrl) },
      security: [
        { OAuth2: ['openid', 'profile', 'email'] },
        { BearerAuth: [] },
      ],
      servers: [{ url: config.baseUrl, description: 'Development server' }],
    },
  })
}
