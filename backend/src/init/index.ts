// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Startup orchestration: what gets reconciled, in what order, and why.
 *
 * Each step lives in its own module here; this file is the running order. It is
 * deliberately fail-soft — the landing page, admin UI and docs all work without
 * Keycloak, and auth-dependent routes degrade to friendly errors — so a step
 * that cannot complete logs and startup continues.
 */

import { config } from '../config'
import { logger } from '../lib/logger'
import { refreshCorsOrigins } from '../lib/cors-origins'
import { resolveKcRealmIssuer } from '../lib/proxy-signing'
import { checkKeycloakConnection } from './keycloak-connection'
import { initializeFhirServers } from './fhir-servers'
import { ensureProxySigningIdp } from './federated-jwt'
import {
  ensureKeycloakEventLogging,
  ensureKeycloakSmtp,
  ensureLoginTheme,
  ensureOrganizationsEnabled,
  ensureUserProfileAttributes,
} from './realm-settings'
import {
  ensurePostLogoutRedirectUris,
  ensureSystemClients,
  loadRuntimeConfigEagerly,
} from './clients'

export { isKeycloakAccessible, checkKeycloakConnection } from './keycloak-connection'
export { initializeFhirServers, displayServerEndpoints } from './fhir-servers'
export { ensurePostLogoutRedirectUris, ensureSystemClients } from './clients'
export { ensureProxySigningIdp } from './federated-jwt'

async function initializeKeycloak(): Promise<void> {
  logger.keycloak.info('Initializing Keycloak connection...')
  logger.keycloak.info(`Keycloak Server: ${config.keycloak.baseUrl}`)
  logger.keycloak.info(`Realm: ${config.keycloak.realm}`)
  logger.keycloak.info(`JWKS URI: ${config.keycloak.jwksUri}`)

  await checkKeycloakConnection()

  // Canonical realm issuer first: it respects KC_HOSTNAME, and the steps below
  // write URLs derived from it.
  await resolveKcRealmIssuer()

  await ensureProxySigningIdp()
  await ensureKeycloakEventLogging()
  await ensureKeycloakSmtp()
  await ensurePostLogoutRedirectUris()
  await refreshCorsOrigins()
  await loadRuntimeConfigEagerly()
  await ensureOrganizationsEnabled()
  await ensureLoginTheme()
  await ensureUserProfileAttributes()
  await ensureSystemClients()

  // Brand display name is managed via the admin branding API (PUT /admin/branding),
  // which syncs displayName + displayNameHtml to the realm. Not reconciled here,
  // so a startup never overwrites what an admin set.
}

function reportInitializationFailure(error: unknown): void {
  if (error instanceof Error && error.message.includes('Keycloak connection verification failed')) {
    logger.server.warn('🔐 Keycloak connection failed — server will start with limited authentication')
    logger.server.warn(`   Keycloak URL: ${config.keycloak.baseUrl}`)
    logger.server.warn(`   Realm: ${config.keycloak.realm}`)
    logger.server.warn(`   JWKS: ${config.keycloak.jwksUri}`)
    logger.server.warn('')
    logger.server.warn('🔍 Keycloak troubleshooting:')
    logger.server.warn(`   1. Check if Keycloak is running at: ${config.keycloak.baseUrl}`)
    logger.server.warn(`   2. Verify realm "${config.keycloak.realm}" exists`)
    logger.server.warn(`   3. Test JWKS endpoint: ${config.keycloak.jwksUri}`)
    logger.server.warn('   4. Check network connectivity and firewall settings')
    logger.server.warn('   5. Configure Keycloak in the admin UI once the server is running')
    logger.server.warn('')
    return
  }

  logger.server.error('❌ Server initialization failed', {
    error: error instanceof Error
      ? { message: error.message, stack: error.stack, name: error.name, cause: error.cause }
      : String(error),
    initializationStep: 'Unknown',
    config: {
      keycloak: {
        isConfigured: config.keycloak.isConfigured,
        baseUrl: config.keycloak.baseUrl,
        realm: config.keycloak.realm,
        jwksUri: config.keycloak.jwksUri,
      },
      fhir: {
        serverBases: config.fhir.serverBases,
      },
    },
    timestamp: new Date().toISOString(),
  })

  logger.server.warn('⚠️  Server initialization had issues but will attempt to continue')
  logger.server.warn('Some features may not work correctly until issues are resolved')
}

/**
 * Initialize all server components (Keycloak + FHIR servers)
 */
export async function initializeServer(): Promise<void> {
  logger.server.info('Starting Proxy Smart...')

  try {
    if (config.keycloak.isConfigured) {
      await initializeKeycloak()
    } else {
      logger.keycloak.warn('Keycloak not configured - authentication features will be limited')
      logger.keycloak.warn('Configure Keycloak settings in the admin UI to enable full functionality')
    }

    await initializeFhirServers()
  } catch (error) {
    reportInitializationFailure(error)
  }
}
