// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Keycloak reachability check run at startup and from the auth status route.
 *
 * Distinguishes "the realm is not answering" from "an optional endpoint is not
 * answering": only JWKS and realm-info are treated as fatal, because the server
 * must be able to start and serve its landing page without Keycloak.
 */

import { config } from '../config'
import { logger } from '../lib/logger'
import { isJwks } from '../lib/client-jwks'
import { isRecord, optionalString } from '../lib/type-guards'

const DEFAULT_RETRIES = 3
const DEFAULT_RETRY_INTERVAL_MS = 5000
const REQUEST_TIMEOUT_MS = 5000

let keycloakAccessible = false

/**
 * Get the current Keycloak accessibility status
 */
export function isKeycloakAccessible(): boolean {
  return config.keycloak.isConfigured || keycloakAccessible
}

async function fetchWithTimeout(url: string, timeout: number = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    return await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

/** JWKS plus realm info: the two endpoints authentication cannot work without. */
async function probeCriticalEndpoints(): Promise<void> {
  const response = await fetchWithTimeout(config.keycloak.jwksUri!)
  if (!response.ok) {
    throw new Error(`JWKS endpoint returned ${response.status}: ${response.statusText}`)
  }

  const jwksData: unknown = await response.json()
  if (!isJwks(jwksData) || jwksData.keys.length === 0) {
    throw new Error('JWKS endpoint returned invalid or empty key set')
  }
  logger.keycloak.info(`Keycloak JWKS endpoint accessible with ${jwksData.keys.length} key(s)`)

  const realmInfoUrl = `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}`
  const realmResponse = await fetchWithTimeout(realmInfoUrl)
  if (!realmResponse.ok) {
    throw new Error(`Realm info endpoint returned ${realmResponse.status}: ${realmResponse.statusText}`)
  }

  const realmInfo: unknown = await realmResponse.json()
  const realmName = isRecord(realmInfo) ? optionalString(realmInfo.realm) : undefined
  logger.keycloak.info(`Keycloak realm "${realmName ?? config.keycloak.realm}" accessible`)
}

/** Logged for diagnostics only; authentication works without it. */
async function probeOpenIdConfiguration(): Promise<void> {
  const openidConfigUrl = `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/.well-known/openid-configuration`

  try {
    const openidResponse = await fetchWithTimeout(openidConfigUrl)
    if (!openidResponse.ok) {
      logger.keycloak.warn(`OpenID Connect configuration endpoint returned ${openidResponse.status}: ${openidResponse.statusText}`)
      logger.keycloak.warn('This is non-critical - authentication will still work')
      return
    }

    const openidConfig: unknown = await openidResponse.json()
    const endpoint = (name: string) => (isRecord(openidConfig) ? optionalString(openidConfig[name]) : undefined)
    logger.keycloak.info('OpenID Connect configuration accessible')
    logger.keycloak.info(`Authorization endpoint: ${endpoint('authorization_endpoint')}`)
    logger.keycloak.info(`Token endpoint: ${endpoint('token_endpoint')}`)
    logger.keycloak.info(`Userinfo endpoint: ${endpoint('userinfo_endpoint')}`)
  } catch (error) {
    logger.keycloak.warn(`Could not access OpenID Connect configuration: ${error instanceof Error ? error.message : String(error)}`)
    logger.keycloak.warn('This is non-critical - authentication will still work')
  }
}

function logProbableCauses(errorMessage: string): void {
  if (errorMessage.includes('ECONNRESET') || errorMessage.includes('ECONNREFUSED')) {
    logger.keycloak.error('Possible causes:', {
      causes: [
        'Keycloak server is not running',
        'Keycloak URL is incorrect',
        'Network connectivity issues',
        `Check if Keycloak is accessible at: ${config.keycloak.baseUrl}`,
      ],
    })
  } else if (errorMessage.includes('404')) {
    logger.keycloak.error('Possible causes:', {
      causes: [
        'Keycloak realm name is incorrect',
        `Verify realm "${config.keycloak.realm}" exists in Keycloak`,
        'Realm might not be properly configured',
      ],
    })
  } else if (errorMessage.includes('timeout') || errorMessage.includes('aborted')) {
    logger.keycloak.error('Possible causes:', {
      causes: [
        'Keycloak server is slow to respond',
        'Network latency issues',
      ],
    })
  }
}

/**
 * Check Keycloak connection health with retry logic
 */
export async function checkKeycloakConnection(retries?: number, interval?: number): Promise<void> {
  if (!config.keycloak.isConfigured || !config.keycloak.jwksUri) {
    logger.keycloak.warn('Keycloak connection verification skipped: Not configured')
    return
  }

  const maxRetries = retries ?? DEFAULT_RETRIES
  const retryInterval = interval ?? DEFAULT_RETRY_INTERVAL_MS

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.keycloak.info(`Checking Keycloak connection (attempt ${attempt}/${maxRetries})...`)

      await probeCriticalEndpoints()
      await probeOpenIdConfiguration()

      keycloakAccessible = true
      return
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (attempt < maxRetries) {
        logger.keycloak.warn(`Keycloak connection attempt ${attempt} failed`, { error: errorMessage })
        logger.keycloak.info(`Retrying in ${retryInterval / 1000} seconds...`)
        await new Promise(resolve => setTimeout(resolve, retryInterval))
        continue
      }

      logger.keycloak.error('Keycloak connection check failed after all retry attempts', { error: errorMessage })
      logProbableCauses(errorMessage)

      if (errorMessage.includes('JWKS') || errorMessage.includes('Realm info')) {
        throw new Error('Keycloak connection verification failed after all retry attempts', { cause: error })
      }

      logger.keycloak.warn('Some Keycloak endpoints are not accessible, but critical authentication components are working')
      return
    }
  }
}
