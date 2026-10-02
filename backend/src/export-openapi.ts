// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { openapiPlugin } from './lib/openapi-spec'
import { cors } from '@elysiajs/cors'
import { config } from './config'
import { keycloakPlugin } from './lib/keycloak-plugin'
import { fhirRoutes } from './routes/fhir'
import { statusRoutes } from './routes/status'
import { serverDiscoveryRoutes } from './routes/fhir-servers'
import { dicomServerDiscoveryRoutes } from './routes/dicom-servers'
import {
  adminAuditMonitoringRoutes,
  authMonitoringRoutes,
  consentMonitoringRoutes,
  emailMonitoringRoutes,
  fhirMonitoringRoutes,
  fhirProxyMonitoringRoutes,
  oauthMonitoringRoutes,
} from './routes/monitoring'
import { oauthWebSocket } from './routes/oauth-websocket'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { apiRoutes } from './routes/api'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Export configuration - uses values from config module (which reads from .env and package.json)
 * No hardcoded values - everything comes from environment or package.json
 */
const exportConfig = {
  name: config.name,
  displayName: config.displayName,
  version: config.version,
  baseUrl: config.baseUrl,
  port: config.port,
  keycloak: {
    serverUrl: config.keycloak.publicUrl || config.keycloak.baseUrl || 'http://localhost:8080',
    realm: config.keycloak.realm || 'proxy-smart',
    jwksUri: config.keycloak.jwksUri,
  },
  fhir: {
    serverBases: config.fhir.serverBases,
  },
  cors: {
    allowedOrigins: config.cors.origins,
  },
}

// Create the same app configuration as the main server
const app = new Elysia({
  name: exportConfig.name,
  serve: {
    idleTimeout: 120
  },
  websocket: {
    idleTimeout: 120
  },
  aot: true,
  sanitize: (value) => Bun.escapeHTML(value)
})
  .use(cors({
    origin: config.cors.origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
  }))
  .use(openapiPlugin())
  .use(keycloakPlugin)
  .use(statusRoutes)
  .use(serverDiscoveryRoutes)
  .use(dicomServerDiscoveryRoutes)
  .use(authRoutes)
  .use(adminRoutes)
  .use(oauthMonitoringRoutes)
  .use(oauthWebSocket)
  .use(fhirMonitoringRoutes)
  .use(fhirProxyMonitoringRoutes)
  .use(consentMonitoringRoutes)
  .use(adminAuditMonitoringRoutes)
  .use(emailMonitoringRoutes)
  .use(authMonitoringRoutes)
  .use(apiRoutes)
  .use(fhirRoutes)

// The OpenAPI plugin doesn't expose the spec directly, so we need to start a server
// However, we can optimize it by fetching immediately with minimal delay (100ms)
let serverInstance: ReturnType<typeof app.listen> | null = null

const exportSpec = async () => {
  try {
    // Small delay to ensure server port is available
    await new Promise(resolve => setTimeout(resolve, 100))
    
    const port = serverInstance?.server?.port as number
    
    if (!port) {
      throw new Error('Failed to get server port')
    }
    
    console.log(`🔄 Fetching OpenAPI spec from port ${port}`)
    
    // Fetch the spec - Bun is fast enough that we don't need extra delays
    // Note: with path: '/swagger', the spec is at /swagger/json
    const response = await fetch(`http://localhost:${port}/swagger/json`)
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const spec = await response.json()

    // TypeBox still emits 3.1 constructs ({type: "null"} in anyOf); sanitize-openapi.ts downgrades them.
    spec.openapi = '3.1.0'
    
    // Add custom OpenAPI extensions for authentication configuration
    spec['x-jwks-uri'] = exportConfig.keycloak.jwksUri || `${exportConfig.baseUrl}/.well-known/jwks.json`
    spec['x-issuer'] = exportConfig.keycloak.serverUrl ? 
      `${exportConfig.keycloak.serverUrl}/realms/${exportConfig.keycloak.realm}` : 
      exportConfig.baseUrl
    spec['x-audience'] = process.env.JWT_AUDIENCE || exportConfig.baseUrl
    spec['x-token-endpoint'] = `${exportConfig.baseUrl}/auth/token`
    spec['x-authorization-endpoint'] = `${exportConfig.baseUrl}/auth/authorize`
    spec['x-userinfo-endpoint'] = `${exportConfig.baseUrl}/auth/userinfo`
    
    console.log('📝 Added custom OpenAPI extensions:')
    console.log(`   x-jwks-uri: ${spec['x-jwks-uri']}`)
    console.log(`   x-issuer: ${spec['x-issuer']}`)
    console.log(`   x-audience: ${spec['x-audience']}`)
    
    // Ensure dist directory exists
    const distDir = join(process.cwd(), 'dist')
    mkdirSync(distDir, { recursive: true })

    // Write to backend dist
    const outputPath = join(distDir, 'openapi.json')
    const specJson = JSON.stringify(spec, null, 2)
    writeFileSync(outputPath, specJson)
    console.log(`✅ OpenAPI spec exported to: ${outputPath}`)
    
    serverInstance?.stop()
    process.exit(0)
  } catch (error) {
    console.error('❌ Failed to export OpenAPI spec:', error)
    serverInstance?.stop()
    process.exit(1)
  }
}

serverInstance = app.listen(0, exportSpec)
