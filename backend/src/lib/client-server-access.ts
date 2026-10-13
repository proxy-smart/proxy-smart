// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// A SMART app's `server_access_type` / `allowed_server_ids` hold on every FHIR request its tokens make.

import { getAdminClient } from './kc-admin-factory'
import { TtlCache } from './cache/ttl-cache'
import { parseFhirPersons } from './fhir-person-associations'
import { getClientServerAccess } from './smart-client-config-cache'
import type { ServerAccess } from './smart-client-enrichment'
import type { AccessControlResult } from './smart-access-control'
import { logger } from './logger'
import { optionalString } from './type-guards'

export interface ServerAccessDeps {
  clientServerAccess(clientId: string): Promise<ServerAccess | null>
  /** The FHIR servers on which the user has a Person; throws when that cannot be read. */
  userPersonServerIds(userId: string): Promise<string[]>
}

const personServers = new TtlCache<string[]>({ ttlMs: 5 * 60 * 1000, maxEntries: 10_000 })

async function readUserPersonServerIds(userId: string): Promise<string[]> {
  return personServers.getOrLoad(userId, async () => {
    const admin = await getAdminClient()
    if (!admin) throw new Error('Keycloak admin credentials are not configured')
    const user = await admin.users.findOne({ id: userId })
    return parseFhirPersons(user?.attributes?.fhir_persons?.[0]).map((person) => person.serverId)
  })
}

const defaultDeps: ServerAccessDeps = {
  clientServerAccess: (clientId) => getClientServerAccess(clientId),
  userPersonServerIds: readUserPersonServerIds,
}

function refuse(clientId: string, server: { identifier: string; name: string }, reason: string): AccessControlResult {
  logger.fhir.warn('Client may not reach this FHIR server', { clientId, server: server.identifier, reason })
  return {
    allowed: false,
    status: 403,
    body: { error: 'server_not_permitted', message: `Client ${clientId} is not permitted to access FHIR server ${server.name}: ${reason}` },
  }
}

/** Always enforced: a restriction an administrator configured on the client is not a mode. */
export async function enforceClientServerAccess(
  tokenPayload: Record<string, unknown>,
  server: { identifier: string; name: string },
  deps: ServerAccessDeps = defaultDeps,
): Promise<AccessControlResult> {
  const clientId = optionalString(tokenPayload.azp) ?? optionalString(tokenPayload.client_id)
  if (!clientId) return { allowed: true }

  try {
    const access = await deps.clientServerAccess(clientId)
    if (!access || access.type === 'all-servers') return { allowed: true }
    if (access.type === 'user-person-servers') {
      const userId = optionalString(tokenPayload.sub)
      const servers = userId ? await deps.userPersonServerIds(userId) : []
      return servers.includes(server.identifier)
        ? { allowed: true }
        : refuse(clientId, server, 'the user has no Person record on this server')
    }
    if (access.type === null && access.allowedServerIds.length === 0) return { allowed: true }
    return access.allowedServerIds.includes(server.identifier)
      ? { allowed: true }
      : refuse(clientId, server, 'the server is not among the servers selected for this client')
  } catch (error) {
    logger.fhir.error('Cannot read the FHIR servers this client may reach', {
      clientId,
      server: server.identifier,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      allowed: false,
      status: 503,
      body: { error: 'temporarily_unavailable', message: 'The FHIR servers this client may reach cannot be verified right now.' },
    }
  }
}
