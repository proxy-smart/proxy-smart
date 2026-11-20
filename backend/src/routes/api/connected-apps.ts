// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The signed-in user's connected apps, and disconnecting one, for an app the user trusts such as a consent manager.
 * A connected app itself may neither list nor end connections, so one app cannot read or cut off the others.
 */

import { Elysia, type Context } from 'elysia'
import { clientApprovals } from '@/lib/client-approvals'
import { listConnectedApps, revokeConnectedApp, type ConnectedAppsDeps } from '@/lib/connected-apps'
import { findClientByClientId } from '@/lib/keycloak-client-lookup'
import { tokenClientId } from '@/lib/jwt-claims'
import { selfOnboardedKind } from '@/lib/realm-clients'
import { getServiceAccountAdmin } from '@/lib/service-account-admin'
import { CommonErrorResponses, ConnectedAppQuery, ConnectedAppsResponse, SuccessResponse } from '@/schemas'
import { authenticateCaller } from './patient-caller'

const deps: ConnectedAppsDeps = { admin: getServiceAccountAdmin, approvals: clientApprovals }

const CONNECTED_APP_CALLER = 'Connected apps are managed from an app you trust, not from a connected app'

async function authenticateAccountHolder(headers: Record<string, string | undefined>, set: Context['set']): Promise<{ userId: string } | { error: string }> {
  const caller = await authenticateCaller(headers, set)
  if ('error' in caller) return caller
  const userId = typeof caller.payload.sub === 'string' ? caller.payload.sub : ''
  const callerClientId = tokenClientId(caller.payload)
  if (!userId || !callerClientId) {
    set.status = 403
    return { error: 'The token names no user' }
  }
  const callerClient = await findClientByClientId(await deps.admin(), callerClientId)
  if (!callerClient || selfOnboardedKind(callerClient) !== null) {
    set.status = 403
    return { error: CONNECTED_APP_CALLER }
  }
  return { userId }
}

export const connectedAppsRoutes = new Elysia({ prefix: '/connected-apps', tags: ['connected-apps'] })

  .get('/', async ({ headers, set }) => {
    const caller = await authenticateAccountHolder(headers, set)
    if ('error' in caller) return caller
    set.headers['Cache-Control'] = 'no-store'
    return { apps: await listConnectedApps(caller.userId, deps) }
  }, {
    response: { 200: ConnectedAppsResponse, ...CommonErrorResponses },
    detail: {
      summary: 'My connected apps',
      description: 'The apps the signed-in user connected themselves, such as MCP clients, with the resources and permissions they approved. Callable only by an admin-registered app.',
    },
  })

  .delete('/', async ({ headers, query, set }) => {
    const caller = await authenticateAccountHolder(headers, set)
    if ('error' in caller) return caller
    if (!(await revokeConnectedApp(caller.userId, query.client_id, deps))) {
      set.status = 404
      return { error: 'This app is not connected' }
    }
    return { success: true, message: 'Disconnected' }
  }, {
    query: ConnectedAppQuery,
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Disconnect an app',
      description: 'Forgets every approval the user gave the app, drops its Keycloak consent and offline tokens, and refuses refresh tokens it was issued before now. Callable only by an admin-registered app.',
    },
  })
