// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { logger } from '@/lib/logger'
import { config } from '@/config'
import { extractBearerToken } from '@/lib/admin-utils'
import { validateAdminToken } from '@/lib/auth'
import { handleAdminError } from '@/lib/admin-error-handler'
import { createAdminClient } from '@/lib/keycloak-plugin'
import { pickSessionSettings, validateSessionSettings } from '@/lib/session-settings'
import fs from 'fs'
import path from 'path'
import {
  TestKeycloakConnectionRequest,
  TestKeycloakConnectionResponse,
  SaveKeycloakConfigRequest,
  SaveKeycloakConfigResponse,
  KeycloakConfigResponse,
  type SaveKeycloakConfigRequestType
} from '@/schemas/admin/keycloak'
import { ErrorResponse, CommonErrorResponses } from '@/schemas'
import { SessionSettings, type SessionSettingsType } from '@/schemas/admin/keycloak'
import type RealmRepresentation from '@keycloak/keycloak-admin-client/lib/defs/realmRepresentation.js'

function realmSessionSettings(realm: RealmRepresentation | undefined): SessionSettingsType {
  return pickSessionSettings({
    ssoSessionIdleTimeout: realm?.ssoSessionIdleTimeout,
    ssoSessionMaxLifespan: realm?.ssoSessionMaxLifespan,
    offlineSessionIdleTimeout: realm?.offlineSessionIdleTimeout,
    offlineSessionMaxLifespan: realm?.offlineSessionMaxLifespan,
    offlineSessionMaxLifespanEnabled: realm?.offlineSessionMaxLifespanEnabled,
  })
}

/**
 * Keycloak Configuration Management
 * Allows manual configuration of Keycloak connection when startup fails
 */

const ENV_FILE_PATH = path.join(process.cwd(), '.env')

/**
 * Update environment variables in .env file and process.env
 */
function updateConfiguration(keycloakConfig: SaveKeycloakConfigRequestType): void {
  let envContent = ''
  
  // Read existing .env file if it exists
  if (fs.existsSync(ENV_FILE_PATH)) {
    envContent = fs.readFileSync(ENV_FILE_PATH, 'utf-8')
  }
  
  // Parse existing env vars
  const envVars = new Map<string, string>()
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=')
      if (key && valueParts.length > 0) {
        envVars.set(key.trim(), valueParts.join('=').trim())
      }
    }
  })
  
  // Update Keycloak configuration in both .env file and process.env
  envVars.set('KEYCLOAK_BASE_URL', keycloakConfig.baseUrl)
  envVars.set('KEYCLOAK_REALM', keycloakConfig.realm)
  process.env.KEYCLOAK_BASE_URL = keycloakConfig.baseUrl
  process.env.KEYCLOAK_REALM = keycloakConfig.realm
  
  // Set admin client credentials if provided
  if (keycloakConfig.adminClientId) {
    envVars.set('KEYCLOAK_ADMIN_CLIENT_ID', keycloakConfig.adminClientId)
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = keycloakConfig.adminClientId
  }
  if (keycloakConfig.adminClientSecret) {
    envVars.set('KEYCLOAK_ADMIN_CLIENT_SECRET', keycloakConfig.adminClientSecret)
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = keycloakConfig.adminClientSecret
  }
  
  // Rebuild .env file content
  const lines: string[] = []
  
  // Add header comment
  lines.push('# Base URL for the proxy')
  if (envVars.has('BASE_URL')) {
    lines.push(`BASE_URL=${envVars.get('BASE_URL')}`)
  }
  lines.push('')
  
  // Keycloak section
  lines.push('# Keycloak configuration')
  lines.push(`KEYCLOAK_BASE_URL=${keycloakConfig.baseUrl}`)
  if (envVars.has('KEYCLOAK_DOMAIN')) {
    lines.push(`KEYCLOAK_DOMAIN=${envVars.get('KEYCLOAK_DOMAIN')}`)
  }
  lines.push(`KEYCLOAK_REALM=${keycloakConfig.realm}`)
  
  // Admin client credentials for dynamic registration
  if (keycloakConfig.adminClientId || keycloakConfig.adminClientSecret) {
    lines.push('')
    lines.push('# Admin client for dynamic client registration')
    if (keycloakConfig.adminClientId) {
      lines.push(`KEYCLOAK_ADMIN_CLIENT_ID=${keycloakConfig.adminClientId}`)
    }
    if (keycloakConfig.adminClientSecret) {
      lines.push(`KEYCLOAK_ADMIN_CLIENT_SECRET=${keycloakConfig.adminClientSecret}`)
    }
  }
  
  lines.push('')
  
  // FHIR section
  lines.push('# FHIR server configuration')
  if (envVars.has('FHIR_SERVER_BASE')) {
    lines.push(`FHIR_SERVER_BASE=${envVars.get('FHIR_SERVER_BASE')}`)
  }
  if (envVars.has('FHIR_SUPPORTED_VERSIONS')) {
    lines.push(`FHIR_SUPPORTED_VERSIONS=${envVars.get('FHIR_SUPPORTED_VERSIONS')}`)
  }
  lines.push('')
  
  // Port section
  lines.push('# Optional: Custom port (defaults to 8445)')
  if (envVars.has('PORT')) {
    lines.push(`PORT=${envVars.get('PORT')}`)
  }
  
  // Write back to file
  fs.writeFileSync(ENV_FILE_PATH, lines.join('\n'))
}

/**
 * Test Keycloak connection
 */
async function testKeycloakConnection(baseUrl: string, realm: string): Promise<boolean> {
  try {
    const realmUrl = `${baseUrl}/realms/${realm}`
    const response = await fetch(realmUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000) // 10 second timeout
    })
    
    if (!response.ok) {
      throw new Error(`Realm endpoint returned ${response.status}: ${response.statusText}`)
    }
    
    const realmInfo = await response.json()
    return !!(realmInfo.realm === realm)
  } catch (error) {
    logger.admin.error('Keycloak connection test failed', { error, baseUrl, realm })
    return false
  }
}

export const keycloakConfigRoutes = new Elysia({ prefix: '/keycloak-config', tags: ['admin'] })
  
  // Get current Keycloak configuration status
  .get('/status', async ({ headers, set }) => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Unauthorized', details: 'Bearer token required' } }
      await validateAdminToken(token)
      return {
        baseUrl: config.keycloak.baseUrl,
        realm: config.keycloak.realm,
        hasAdminClient: !!(config.keycloak.adminClientId && config.keycloak.adminClientSecret),
        adminClientId: config.keycloak.adminClientId || null
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    detail: {
      summary: 'Get Keycloak Admin Configuration',
      description: 'Get current Keycloak settings for administrative purposes. Use /auth/config for public availability check.',
      tags: ['admin']
    },
    response: {
      200: KeycloakConfigResponse,
      401: ErrorResponse
    }
  })
  
  // ─── Realm session lifetimes ────────────────────────────────────────────────
  //
  // A realm export applies only at realm CREATION; a running realm lives in Postgres. So every
  // lifetime change used to split into "edit the export" plus "somebody opens the Keycloak
  // console", and the second half quietly did not happen — which is how
  // `offlineSessionMaxLifespanEnabled` stayed false on a live deployment while the export said
  // otherwise, leaving offline sessions with no ceiling at all.

  .get('/session-settings', async ({ headers, set }) => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Unauthorized', details: 'Bearer token required' } }
      const admin = await createAdminClient(token)
      const realm = await admin.realms.findOne({ realm: config.keycloak.realm! })
      return realmSessionSettings(realm)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: { 200: SessionSettings, ...CommonErrorResponses },
    detail: {
      summary: 'Get Realm Session Lifetimes',
      description:
        'The SSO and offline session lifetimes currently in force on the running realm — which may differ from realm-export.json, since an export only applies at realm creation.',
      tags: ['admin'],
    },
  })

  .put('/session-settings', async ({ body, headers, set }) => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Unauthorized', details: 'Bearer token required' } }

      // Only the lifetime fields, never a whole-realm passthrough: a RealmRepresentation has ~200
      // fields and an extra key riding along would be applied to the realm silently.
      const requested = pickSessionSettings(body)
      const problem = validateSessionSettings(requested)
      if (problem) {
        set.status = 400
        return { error: 'Bad Request', details: problem }
      }

      const admin = await createAdminClient(token)
      // Merge onto the CURRENT realm rather than sending the partial alone — Keycloak's realm
      // update replaces the representation, so posting only these keys would blank the rest.
      const current = await admin.realms.findOne({ realm: config.keycloak.realm! })
      await admin.realms.update({ realm: config.keycloak.realm! }, { ...current, ...requested })

      logger.admin.info('Realm session lifetimes updated', { changed: Object.keys(requested) })
      const updated = await admin.realms.findOne({ realm: config.keycloak.realm! })
      return realmSessionSettings(updated)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: SessionSettings,
    response: { 200: SessionSettings, ...CommonErrorResponses },
    detail: {
      summary: 'Update Realm Session Lifetimes',
      description:
        'Applies SSO/offline session lifetimes to the RUNNING realm. Partial updates are supported. Refuses a ceiling below its idle timeout, a non-positive duration (Keycloak reads 0 as unlimited), and enabling the offline ceiling without setting one.',
      tags: ['admin'],
    },
  })

  // Test Keycloak connection without saving
  .post('/test', async ({ body, set, headers }) => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { success: false, error: 'Bearer token required' } }
      await validateAdminToken(token)
      const isConnected = await testKeycloakConnection(body.baseUrl, body.realm)
      
      if (!isConnected) {
        set.status = 400
        return {
          success: false,
          error: 'Unable to connect to Keycloak or realm not found'
        }
      }
      
      return {
        success: true,
        message: 'Successfully connected to Keycloak realm'
      }
    } catch (error) {
      logger.admin.error('Keycloak connection test failed', { error })
      set.status = 500
      return {
        success: false,
        error: 'Connection test failed'
      }
    }
  }, {
    body: TestKeycloakConnectionRequest,
    detail: {
      summary: 'Test Keycloak Connection',
      description: 'Test connection to Keycloak without saving configuration',
      tags: ['admin']
    },
    response: {
      200: TestKeycloakConnectionResponse
    }
  })
  
  // Configure Keycloak connection
  .post('/configure', async ({ body, set, headers }) => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { success: false, error: 'Bearer token required' } }
      await validateAdminToken(token)
      // First test the connection
      const isConnected = await testKeycloakConnection(body.baseUrl, body.realm)
      
      if (!isConnected) {
        set.status = 400
        return {
          success: false,
          error: 'Unable to connect to Keycloak or realm not found. Please verify the URL and realm name.'
        }
      }
      
      // Update .env file
      updateConfiguration({
        baseUrl: body.baseUrl,
        realm: body.realm,
        adminClientId: body.adminClientId,
        adminClientSecret: body.adminClientSecret
      })
      
      logger.admin.info('Keycloak configuration updated', {
        baseUrl: body.baseUrl,
        realm: body.realm,
        hasAdminClient: !!(body.adminClientId && body.adminClientSecret)
      })
      
      return {
        success: true,
        message: 'Keycloak configuration updated successfully. Please restart the server for full effect.',
        restartRequired: true
      }
    } catch (error) {
      logger.admin.error('Failed to configure Keycloak', { error })
      set.status = 500
      return {
        success: false,
        error: 'Failed to save Keycloak configuration'
      }
    }
  }, {
    body: SaveKeycloakConfigRequest,
    detail: {
      summary: 'Configure Keycloak Connection',
      description: 'Save Keycloak configuration to environment and restart connection',
      tags: ['admin']
    },
    response: {
      200: SaveKeycloakConfigResponse
    }
  })

