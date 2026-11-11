// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { extractPatientFromFhirUser, type CallbackParams, type LaunchSession } from '@proxy-smart/auth'
import { logger } from '@/lib/logger'
import { isRecord, optionalString } from '@/lib/type-guards'
import { config } from '@/config'
import { getAdminClient as defaultGetAdminClient } from '@/lib/kc-admin-factory'

export type AdminClientFactory = () => Promise<KcAdminClient | null>

/** GET /admin/realms/{realm}/sessions/{id}, Keycloak 21+. */
async function findUserIdByDirectLookup(
  admin: KcAdminClient,
  sessionState: string,
): Promise<string | null> {
  const realm = config.keycloak.realm
  const baseUrl = config.keycloak.baseUrl
  if (!realm || !baseUrl) return null

  try {
    // getAccessToken() handles refresh; the .accessToken property does not.
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
    const data: unknown = await resp.json()
    if (isRecord(data) && typeof data.userId === 'string' && data.userId) {
      logger.auth.info('autoResolvePatient: direct session lookup matched', {
        userId: data.userId,
        username: optionalString(data.username),
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

/** Fallback for Keycloak without the direct session lookup. */
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

/** The Keycloak user behind a callback's session_state, or null when it cannot be found. */
export async function findSessionUserId(admin: KcAdminClient, clientId: string, sessionState: string): Promise<string | null> {
  return (await findUserIdByDirectLookup(admin, sessionState)) ?? findUserIdByClientSessions(admin, clientId, sessionState)
}

/** The patient id when the session's user has a Patient fhirUser, so the picker can be skipped; null otherwise. */
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

    const userId = await findSessionUserId(admin, session.clientId, sessionState)
    if (!userId) {
      session.identityUnresolved = true
      return null
    }

    // /auth/logout needs this: a failed launch has no id_token_hint to log out with.
    session.userSub = userId

    const user = await admin.users.findOne({ id: userId })
    const fhirUser = user?.attributes?.fhirUser?.[0]
    if (!fhirUser) {
      logger.auth.info('autoResolvePatient: user has no fhirUser attribute', { userId })
      return null
    }

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
