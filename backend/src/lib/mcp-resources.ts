// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Where this deployment serves MCP.
 *
 * Three places have to agree: the protected-resource metadata that describes an endpoint, the
 * `aud`/`resource` the authorize endpoint will mint a token for, and the challenge the endpoint
 * itself returns. They disagreed — a per-server FHIR MCP endpoint served requests and published
 * metadata, but `validateAudience` had never heard of it, so no client could get a token for one.
 */
import { config } from '@/config'
import { ensureServersInitialized, getServerInfoByName } from '@/lib/fhir-server-store'

/** The per-server MCP path, e.g. `/fhir/hapi-fhir-server/mcp`. */
export function fhirMcpPath(serverId: string): string {
  return `/fhir/${serverId}/mcp`
}

/** The per-server MCP endpoint URL, the `resource` its tokens are issued for. */
export function fhirMcpUrl(serverId: string): string {
  return `${config.baseUrl}${fhirMcpPath(serverId)}`
}

/** The server id in a per-server MCP path, or undefined when it is not one. */
export function fhirMcpServerId(path: string): string | undefined {
  return /^\/fhir\/([^/]+)\/mcp$/.exec(path)?.[1]
}

/**
 * Whether the path is an MCP endpoint this deployment serves RIGHT NOW — the admin endpoint,
 * or a FHIR server whose `mcpEnabled` is set. A server with its MCP switched off is not one.
 */
export async function isServedMcpPath(path: string): Promise<boolean> {
  if (path === config.mcp.path) return true

  const serverId = fhirMcpServerId(path)
  if (!serverId) return false

  try {
    await ensureServersInitialized()
    return (await getServerInfoByName(serverId))?.mcpEnabled === true
  } catch {
    return false
  }
}
