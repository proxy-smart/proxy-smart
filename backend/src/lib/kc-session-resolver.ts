// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Keycloak Session Resolver
 *
 * Resolves user identity from a Keycloak session_state parameter.
 * Used during SMART callback to determine if the logged-in user is a Patient
 * (and thus doesn't need the patient picker).
 *
 * Strategy:
 *   1. Direct session lookup via GET /admin/realms/{realm}/sessions/{id} (single call, Keycloak 21+)
 *   2. Fallback: scan active user-sessions on the OIDC client (paginated)
 *   3. Look up the user's fhirUser attribute → if Patient/*, return patient ID
 */

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { extractPatientFromFhirUser, type CallbackParams, type LaunchSession } from '@proxy-smart/auth'
import { logger } from '@/lib/logger'
import { config } from '@/config'
import { getAdminClient as defaultGetAdminClient } from '@/lib/kc-admin-factory'

/** Factory function type for obtaining an authenticated admin client. */
export type AdminClientFactory = () => Promise<KcAdminClient | null>

/**
 * Direct session lookup via Keycloak REST API.
 * Uses GET /admin/realms/{realm}/sessions/{session-id} — returns the userId directly.
 * Available in Keycloak 21+. Falls back to null on 404 or error.
 */
async function findUserIdByDirectLookup(
  admin: KcAdminClient,
  sessionState: string,
): Promise<string | null> {
  const realm = config.keycloak.realm
  const baseUrl = config.keycloak.baseUrl
  if (!realm || !baseUrl) return null

  try {
    // Use getAccessToken() (async, handles refresh) rather than the .accessToken property
    const token = await admin.getAccessToken()
    if (!token) {
      logger.auth.warn('autoResolvePatient: admin access token is empty after auth')
      return null
    }

    const resp = await fetch(`${baseUrl}/admin/realms/${realm}/sessions/${sessionState}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!resp.ok) {
      logger.auth.debug('autoResolvePatient: direct session lookup returned non-OK', {
        status: resp.status,
        sessionState: sessionState.slice(0, 8) + '...',
      })
      return null
    }
    const data = await resp.json() as { userId?: string; username?: string }
    if (data.userId) {
      logger.auth.info('autoResolvePatient: direct session lookup matched', {
        userId: data.userId,
        username: data.username,
      })
      return data.userId
    }
    return null
  } catch (err) {
    logger.auth.debug('autoResolvePatient: direct session lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Fallback: find the userId by scanning the OIDC client's active user-sessions.
 * Used when direct session lookup is unavailable (older Keycloak versions).
 */
async function findUserIdByClientSessions(
  admin: KcAdminClient,
  clientId: string,
  sessionState: string,
): Promise<string | null> {
  const clients = await admin.clients.find({ clientId, max: 1 })
  const kcClient = clients?.[0]
  if (!kcClient?.id) {
    logger.auth.warn('autoResolvePatient: OIDC client not found in Keycloak', { clientId })
    return null
  }

  const pageSize = 50
  let offset = 0
  const maxPages = 10

  for (let page = 0; page < maxPages; page++) {
    const sessions = await admin.clients.listSessions({
      id: kcClient.id,
      first: offset,
      max: pageSize,
    })
    if (!sessions || sessions.length === 0) break

    const match = sessions.find(s => s.id === sessionState)
    if (match?.userId) {
      logger.auth.info('autoResolvePatient: client session scan matched', {
        userId: match.userId,
        username: match.username,
        page,
      })
      return match.userId
    }

    if (sessions.length < pageSize) break
    offset += pageSize
  }

  logger.auth.warn('autoResolvePatient: session_state not found via client session scan', {
    clientId,
    sessionState: sessionState.slice(0, 8) + '...',
  })
  return null
}

/**
 * Look up the Keycloak user's fhirUser attribute via session_state.
 * If fhirUser is "Patient/*", return the patient ID.
 * Returns null on any failure (non-fatal).
 */
export async function autoResolvePatient(
  session: LaunchSession,
  params: CallbackParams,
  adminClientFactory: AdminClientFactory = defaultGetAdminClient,
): Promise<string | null> {
  const sessionState = params.session_state
  if (!sessionState) {
    logger.auth.info('autoResolvePatient: no session_state in callback params — skipping')
    session.identityUnresolved = true
    return null
  }

  logger.auth.info('autoResolvePatient: attempting resolution', {
    clientId: session.clientId,
    sessionState: sessionState.slice(0, 8) + '...',
  })

  try {
    const admin = await adminClientFactory()
    if (!admin) {
      logger.auth.warn('autoResolvePatient: admin client not available (credentials missing?)')
      session.identityUnresolved = true
      return null
    }

    // Try direct session lookup first (single HTTP call, Keycloak 21+)
    let userId = await findUserIdByDirectLookup(admin, sessionState)

    // Fallback: scan client sessions (paginated, works on all Keycloak versions)
    if (!userId) {
      userId = await findUserIdByClientSessions(admin, session.clientId, sessionState)
    }

    if (!userId) {
      session.identityUnresolved = true
      return null
    }

    // /auth/logout needs this: a failed launch has no id_token_hint to log out with.
    session.userSub = userId

    // Look up the user's fhirUser attribute
    const user = await admin.users.findOne({ id: userId })
    const fhirUser = user?.attributes?.fhirUser?.[0]
    if (!fhirUser) {
      logger.auth.info('autoResolvePatient: user has no fhirUser attribute', { userId })
      return null
    }

    // Store fhirUser on the session so the fallback path in callback-handler can use it
    if (!session.fhirUser) {
      session.fhirUser = fhirUser
    }

    const patient = extractPatientFromFhirUser(fhirUser)
    logger.auth.info('autoResolvePatient: resolved', { fhirUser, patient })
    return patient
  } catch (err) {
    logger.auth.warn('Auto-resolve patient from session failed (non-fatal)', { error: err })
    if (!session.fhirUser) session.identityUnresolved = true
    return null
  }
}
