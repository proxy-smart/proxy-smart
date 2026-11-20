// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The apps a user's own software connected (MCP clients and other self-onboarded clients), and disconnecting one:
 * its approvals go, Keycloak drops its consent and offline tokens, and refresh tokens it was issued before stop working.
 */

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import type UserConsentRepresentation from '@keycloak/keycloak-admin-client/lib/defs/userConsentRepresentation'
import { isCimdClientId } from '@proxy-smart/auth'
import type { ConnectedAppType } from '@/schemas'
import { readUnverifiedClaims } from './jwt-claims'
import { findClientByClientId } from './keycloak-client-lookup'
import { selfOnboardedKind } from './realm-clients'
import { logger } from './logger'
import type { ClientApproval, ClientApprovalBackend } from './client-approvals'

export interface ConnectedAppsDeps {
  admin: () => Promise<KcAdminClient>
  approvals: ClientApprovalBackend
  now?: () => number
}

const unique = (values: Iterable<string>): string[] => [...new Set(values)].filter(Boolean)
const earliest = (values: (number | undefined)[]): number | undefined => {
  const known = values.filter((value): value is number => typeof value === 'number')
  return known.length > 0 ? Math.min(...known) : undefined
}

function connectedApp(client: ClientRepresentation, approvals: ClientApproval[], consent: UserConsentRepresentation | undefined): ConnectedAppType | null {
  const kind = selfOnboardedKind(client)
  const clientId = client.clientId
  if (!kind || !clientId) return null
  const connectedAt = earliest([...approvals.map((approval) => approval.approvedAt), consent?.createdDate])
  return {
    clientId,
    name: client.name || clientId,
    ...(isCimdClientId(clientId) && { host: new URL(clientId).host }),
    kind,
    resources: unique(approvals.map((approval) => approval.resource)),
    scopes: unique([...approvals.flatMap((approval) => approval.scopes), ...(consent?.grantedClientScopes ?? [])]),
    ...(connectedAt !== undefined && { connectedAt }),
  }
}

/** Self-onboarded apps the user approved here or holds a Keycloak consent or offline token for; admin-registered apps are not listed. */
export async function listConnectedApps(userId: string, deps: ConnectedAppsDeps): Promise<ConnectedAppType[]> {
  const admin = await deps.admin()
  const [consents, approvals] = await Promise.all([admin.users.listConsents({ id: userId }), deps.approvals.forUser(userId)])
  const clientIds = unique([...approvals.map((approval) => approval.clientId), ...consents.flatMap((consent) => consent.clientId ?? [])])

  const apps = await Promise.all(clientIds.map(async (clientId) => {
    const client = await findClientByClientId(admin, clientId)
    if (!client) return null
    return connectedApp(
      client,
      approvals.filter((approval) => approval.clientId === clientId),
      consents.find((consent) => consent.clientId === clientId),
    )
  }))
  return apps.filter((app): app is ConnectedAppType => app !== null)
}

/** Disconnects one of the user's connected apps; false when the user has no such connection. */
export async function revokeConnectedApp(userId: string, clientId: string, deps: ConnectedAppsDeps): Promise<boolean> {
  const connected = (await listConnectedApps(userId, deps)).some((app) => app.clientId === clientId)
  if (!connected) return false

  const now = deps.now ?? Date.now
  await deps.approvals.revoke({ userId, clientId, revokedAt: now() })
  // Keycloak answers 404 when the user holds neither a consent nor an offline token for the client.
  await (await deps.admin()).users.revokeConsent({ id: userId, clientId }, { catchNotFound: true })
  logger.auth.info('User disconnected an app', { clientId })
  return true
}

/**
 * A refresh token issued before the user disconnected its client. The proxy refuses it ahead of Keycloak, which keeps
 * online sessions alive for a client without a stored consent. A store that cannot be read refuses nothing.
 */
export async function isRevokedRefreshToken(refreshToken: string, clientId: string | undefined, approvals: ClientApprovalBackend): Promise<boolean> {
  const claims = readUnverifiedClaims(refreshToken)
  if (!clientId || typeof claims?.sub !== 'string' || typeof claims.iat !== 'number') return false
  try {
    const revokedAt = await approvals.revokedAt(claims.sub, clientId)
    return revokedAt !== null && claims.iat * 1000 <= revokedAt
  } catch (error) {
    logger.auth.warn('Could not check whether the user disconnected this app', { clientId, error })
    return false
  }
}
