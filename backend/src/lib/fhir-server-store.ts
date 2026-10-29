// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '../config'
import { getFHIRServerInfo, getServerIdentifier, clearMetadataCache, type FHIRVersionInfo } from './fhir-utils'
import { logger } from './logger'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from './paths'
import { isRecord } from './type-guards'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export interface FHIRServerInfo {
  name: string
  url: string
  identifier: string
  metadata: FHIRVersionInfo
  lastUpdated: number
  strictCapabilities?: boolean
  organizationIds?: string[]
  mcpEnabled?: boolean
}

// ── File-backed persistence for dynamically added servers ────────────────────

const PersistedServer = Type.Object({
  url: Type.String(),
  name: Type.Optional(Type.String()),
  strictCapabilities: Type.Optional(Type.Boolean()),
  organizationIds: Type.Optional(Type.Array(Type.String())),
  mcpEnabled: Type.Optional(Type.Boolean()),
})
type PersistedServer = Static<typeof PersistedServer>

const SERVERS_JSON_PATH = join(DATA_DIR, 'fhir-servers.json')

function loadPersistedServers(): Map<string, PersistedServer> {
  try {
    if (!existsSync(SERVERS_JSON_PATH)) return new Map()
    const data: unknown = JSON.parse(readFileSync(SERVERS_JSON_PATH, 'utf-8'))
    if (!isRecord(data) || !isRecord(data.servers)) return new Map()
    const servers = new Map<string, PersistedServer>()
    for (const [id, server] of Object.entries(data.servers)) {
      if (Value.Check(PersistedServer, server)) servers.set(id, server)
      else logger.fhir.warn('Skipping malformed entry in fhir-servers.json', { id })
    }
    return servers
  } catch (error) {
    logger.fhir.warn('Failed to load fhir-servers.json, starting with env-only servers', {
      error: error instanceof Error ? error.message : String(error)
    })
    return new Map()
  }
}

function savePersistedServers(servers: Map<string, PersistedServer>): void {
  const data = {
    $schema: 'fhir-servers-runtime',
    updatedAt: new Date().toISOString(),
    servers: Object.fromEntries(servers)
  }
  writeFileSync(SERVERS_JSON_PATH, JSON.stringify(data, null, 2), 'utf-8')
}

// Track which identifiers came from file vs env so we know what to persist
const dynamicServers = loadPersistedServers()

class FHIRServerStore {
  private servers = new Map<string, FHIRServerInfo>()
  private isInitialized = false
  private isLoading = false
  private error: string | null = null
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  async initializeServers(): Promise<void> {
    // Don't initialize if already initialized or currently loading
    if (this.isInitialized || this.isLoading) return

    this.isLoading = true
    this.error = null

    try {
      const serverInfos = new Map<string, FHIRServerInfo>()

      // Fetch metadata for all configured servers
      for (let i = 0; i < config.fhir.serverBases.length; i++) {
        const serverUrl = config.fhir.serverBases[i]
        
        try {
          const metadata = await getFHIRServerInfo(serverUrl)
          const identifier = getServerIdentifier(metadata, serverUrl, i)
          
          const serverInfo: FHIRServerInfo = {
            name: metadata.serverName || `Server ${i + 1}`,
            url: serverUrl,
            identifier,
            metadata,
            lastUpdated: Date.now()
          }
          
          // Actually add the server to the map when successful
          serverInfos.set(identifier, serverInfo)
          
          logger.fhir.info(`Initialized FHIR server: ${serverInfo.name}`, { 
            url: serverUrl, 
            fhirVersion: metadata.fhirVersion 
          })
        } catch (error) {
          logger.fhir.warn(`Failed to fetch metadata for ${serverUrl}`, { error })
          
          // Add fallback server info when metadata retrieval fails
          const fallbackIdentifier = `server-${i}`
          const fallbackServerInfo: FHIRServerInfo = {
            name: `Server ${i + 1}`,
            url: serverUrl,
            identifier: fallbackIdentifier,
            metadata: {
              fhirVersion: 'Unknown',
              serverName: 'Unknown FHIR Server',
              supported: false
            },
            lastUpdated: Date.now()
          }
          
          serverInfos.set(fallbackIdentifier, fallbackServerInfo)
        }
      }

      // Also load dynamically added servers from fhir-servers.json
      for (const [identifier, persisted] of dynamicServers) {
        const envServer = Array.from(serverInfos.values()).find(
          s => s.url.replace(/\/+$/, '') === persisted.url.replace(/\/+$/, '')
        )
        if (envServer) {
          serverInfos.set(envServer.identifier, {
            ...envServer,
            name: persisted.name || envServer.name,
            strictCapabilities: persisted.strictCapabilities,
            organizationIds: persisted.organizationIds,
            mcpEnabled: persisted.mcpEnabled,
          })
          continue
        }

        try {
          const metadata = await getFHIRServerInfo(persisted.url)
          const serverInfo: FHIRServerInfo = {
            name: persisted.name || metadata.serverName || `Server ${identifier}`,
            url: persisted.url,
            identifier,
            metadata,
            lastUpdated: Date.now(),
            strictCapabilities: persisted.strictCapabilities,
            organizationIds: persisted.organizationIds,
            mcpEnabled: persisted.mcpEnabled
          }
          serverInfos.set(identifier, serverInfo)
          logger.fhir.info(`Loaded persisted FHIR server: ${serverInfo.name}`, {
            url: persisted.url,
            identifier,
            fhirVersion: metadata.fhirVersion
          })
        } catch (error) {
          logger.fhir.warn(`Failed to fetch metadata for persisted server ${persisted.url}`, { error })
          serverInfos.set(identifier, {
            name: persisted.name || `Server ${identifier}`,
            url: persisted.url,
            identifier,
            metadata: { fhirVersion: 'Unknown', serverName: 'Unknown FHIR Server', supported: false },
            lastUpdated: Date.now(),
            strictCapabilities: persisted.strictCapabilities,
            organizationIds: persisted.organizationIds,
            mcpEnabled: persisted.mcpEnabled
          })
        }
      }

      this.servers = serverInfos
      this.isInitialized = true
      this.isLoading = false
      this.error = null
    } catch (error) {
      logger.fhir.error('Failed to initialize FHIR servers', { error })
      this.isLoading = false
      this.error = error instanceof Error ? error.message : 'Unknown error'
    }
  }

  getServerByName(serverName: string): FHIRServerInfo | null {
    return this.servers.get(serverName) || null
  }

  getServerUrlByName(serverName: string): string | null {
    const server = this.servers.get(serverName)
    return server ? server.url : null
  }

  async refreshServer(serverName: string): Promise<void> {
    const server = this.servers.get(serverName)
    
    if (!server) {
      logger.fhir.warn(`Server ${serverName} not found`)
      return
    }

    try {
      const metadata = await getFHIRServerInfo(server.url)
      const updatedServer: FHIRServerInfo = {
        ...server,
        metadata,
        lastUpdated: Date.now()
      }
      
      this.servers.set(serverName, updatedServer)
    } catch (error) {
      logger.fhir.error(`Failed to refresh server ${serverName}`, { error })
    }
  }

  async refreshAllServers(): Promise<void> {
    for (const [serverName, server] of this.servers) {
      // Check if server needs refresh (older than cache TTL)
      if (Date.now() - server.lastUpdated > this.CACHE_TTL) {
        await this.refreshServer(serverName)
      }
    }
  }

  getAllServers(): FHIRServerInfo[] {
    return Array.from(this.servers.values())
  }

  addServer(identifier: string, serverInfo: FHIRServerInfo): void {
    this.servers.set(identifier, serverInfo)
  }

  updateServer(identifier: string, serverInfo: FHIRServerInfo): void {
    this.servers.set(identifier, serverInfo)
  }

  removeServer(identifier: string): boolean {
    return this.servers.delete(identifier)
  }

  clearError(): void {
    this.error = null
  }

  getError(): string | null {
    return this.error
  }

  getIsInitialized(): boolean {
    return this.isInitialized
  }

  getIsLoading(): boolean {
    return this.isLoading
  }
}

// Create a singleton instance
const fhirServerStore = new FHIRServerStore()

// Helper function to get server URL by name (for backward compatibility)
export async function getServerByName(serverName: string): Promise<string | null> {
  // Initialize servers if not done yet
  if (!fhirServerStore.getIsInitialized()) {
    await fhirServerStore.initializeServers()
  }
  
  return fhirServerStore.getServerUrlByName(serverName)
}

// Helper function to get server info by name
export async function getServerInfoByName(serverName: string): Promise<FHIRServerInfo | null> {
  // Initialize servers if not done yet
  if (!fhirServerStore.getIsInitialized()) {
    await fhirServerStore.initializeServers()
  }
  
  return fhirServerStore.getServerByName(serverName)
}

// Helper function to get all servers
export async function getAllServers(): Promise<FHIRServerInfo[]> {
  // Initialize servers if not done yet
  if (!fhirServerStore.getIsInitialized()) {
    await fhirServerStore.initializeServers()
  }
  
  return fhirServerStore.getAllServers()
}

/** RFC 8707 resource URL a SMART app requests for a server; the single source for token audience and Keycloak provisioning. */
export function fhirResourceUrlFor(server: { identifier: string; metadata: { fhirVersion: string } }): string {
  return `${config.baseUrl}/${config.name}/${server.identifier}/${server.metadata.fhirVersion}`
}

/** Resource-indicator URLs for every registered FHIR server, in registry order. */
export async function getFhirResourceUrls(): Promise<string[]> {
  return (await getAllServers()).map(fhirResourceUrlFor)
}

// Add a new server to the store
export async function addServer(serverUrl: string, name?: string, organizationIds?: string[]): Promise<FHIRServerInfo> {
  try {
    // Ensure store is initialized first
    await ensureServersInitialized()
        
    // Normalize URL: strip trailing slash to prevent duplicates
    const normalizedUrl = serverUrl.replace(/\/+$/, '')

    // Check if a server with this URL already exists
    const existingServers = fhirServerStore.getAllServers()
    const existingServer = existingServers.find(server => server.url.replace(/\/+$/, '') === normalizedUrl)
    
    if (existingServer) {
      throw new Error(`A server with URL ${normalizedUrl} already exists: ${existingServer.name}`)
    }
    // Fetch server metadata
    const metadata = await getFHIRServerInfo(normalizedUrl)
    let identifier = getServerIdentifier(metadata, normalizedUrl, Date.now())
    
    // Ensure unique identifier by checking for conflicts and appending number if needed
    let counter = 1
    let uniqueIdentifier = identifier
    while (fhirServerStore.getServerByName(uniqueIdentifier)) {
      uniqueIdentifier = `${identifier}-${counter}`
      counter++
    }
    identifier = uniqueIdentifier
    
    const serverInfo: FHIRServerInfo = {
      name: name || metadata.serverName || `Server ${identifier}`,
      url: normalizedUrl,
      identifier,
      metadata,
      lastUpdated: Date.now(),
      organizationIds
    }
    
    // Add to store
    fhirServerStore.addServer(identifier, serverInfo)
    
    // Persist dynamically added server
    dynamicServers.set(identifier, { url: normalizedUrl, name: serverInfo.name, organizationIds })
    savePersistedServers(dynamicServers)
    
    logger.fhir.info(`Added new FHIR server: ${serverInfo.name}`, { 
      url: normalizedUrl, 
      identifier,
      version: metadata.fhirVersion 
    })
    
    return serverInfo
  } catch (error) {
    logger.fhir.error(`Failed to add FHIR server: ${serverUrl}`, { error })
    throw new Error(`Failed to add FHIR server: ${error}`, { cause: error })
  }
}

// Update an existing server in the store
export async function updateServer(serverIdentifier: string, newServerUrl: string, name?: string, organizationIds?: string[]): Promise<FHIRServerInfo> {
  try {
    // Ensure store is initialized first
    await ensureServersInitialized()

    // Normalize URL: strip trailing slash to prevent duplicates
    const normalizedUrl = newServerUrl.replace(/\/+$/, '')

    // Check if a server with this URL already exists (exclude self)
    const existingServers = fhirServerStore.getAllServers()
    const existingServer = existingServers.find(server =>
      server.url.replace(/\/+$/, '') === normalizedUrl && server.identifier !== serverIdentifier
    )
    
    if (existingServer) {
      throw new Error(`A server with URL ${normalizedUrl} already exists: ${existingServer.name}`)
    }
    // Fetch server metadata for the new URL
    const metadata = await getFHIRServerInfo(normalizedUrl)
    
    const previous = fhirServerStore.getServerByName(serverIdentifier)
    const serverInfo: FHIRServerInfo = {
      name: name || metadata.serverName || `Server ${serverIdentifier}`,
      url: normalizedUrl,
      identifier: serverIdentifier,
      metadata,
      lastUpdated: Date.now(),
      organizationIds,
      strictCapabilities: previous?.strictCapabilities,
      mcpEnabled: previous?.mcpEnabled,
    }

    fhirServerStore.updateServer(serverIdentifier, serverInfo)

    dynamicServers.set(serverIdentifier, {
      url: normalizedUrl,
      name: serverInfo.name,
      organizationIds,
      strictCapabilities: serverInfo.strictCapabilities,
      mcpEnabled: serverInfo.mcpEnabled,
    })
    savePersistedServers(dynamicServers)
    
    logger.fhir.info(`Updated FHIR server: ${serverInfo.name}`, { 
      url: newServerUrl, 
      identifier: serverIdentifier,
      version: metadata.fhirVersion 
    })
    
    return serverInfo
  } catch (error) {
    logger.fhir.error(`Failed to update FHIR server: ${newServerUrl}`, { error })
    throw new Error(`Failed to update FHIR server: ${error}`, { cause: error })
  }
}

// Refresh metadata for a single server (re-fetch from origin)
export async function refreshServer(serverIdentifier: string): Promise<FHIRServerInfo> {
  await ensureServersInitialized()

  const server = fhirServerStore.getServerByName(serverIdentifier)
  if (!server) {
    throw new Error(`Server '${serverIdentifier}' not found`)
  }

  // Clear cache so we get a fresh fetch
  clearMetadataCache(server.url)
  const metadata = await getFHIRServerInfo(server.url)

  const updated: FHIRServerInfo = {
    ...server,
    name: metadata.serverName && metadata.serverName !== 'Unknown FHIR Server' ? metadata.serverName : server.name,
    metadata,
    lastUpdated: Date.now()
  }

  fhirServerStore.updateServer(serverIdentifier, updated)
  return updated
}

// Retry metadata fetch for all servers currently showing as Unknown
export async function retryUnknownServers(): Promise<void> {
  await ensureServersInitialized()

  const servers = fhirServerStore.getAllServers()
  const unknowns = servers.filter(s => s.metadata.fhirVersion === 'Unknown')

  await Promise.allSettled(
    unknowns.map(async (server) => {
      try {
        clearMetadataCache(server.url)
        const metadata = await getFHIRServerInfo(server.url)
        if (metadata.fhirVersion !== 'Unknown') {
          fhirServerStore.updateServer(server.identifier, {
            ...server,
            name: metadata.serverName !== 'Unknown FHIR Server' ? metadata.serverName || server.name : server.name,
            metadata,
            lastUpdated: Date.now()
          })
          logger.fhir.info(`Recovered FHIR server metadata: ${metadata.serverName}`, {
            url: server.url,
            identifier: server.identifier,
          })
        }
      } catch { /* still unreachable, keep as-is */ }
    })
  )
}

// Delete a server from the store
export async function deleteServer(serverIdentifier: string): Promise<void> {
  await ensureServersInitialized()

  const server = fhirServerStore.getServerByName(serverIdentifier)
  if (!server) {
    throw new Error(`Server '${serverIdentifier}' not found`)
  }

  fhirServerStore.removeServer(serverIdentifier)
  
  // Remove from persisted file
  if (dynamicServers.has(serverIdentifier)) {
    dynamicServers.delete(serverIdentifier)
    savePersistedServers(dynamicServers)
  }
  
  logger.fhir.info(`Deleted FHIR server: ${server.name}`, {
    url: server.url,
    identifier: serverIdentifier,
  })
}

// Toggle strict capability enforcement for a server
export async function setStrictCapabilities(serverIdentifier: string, strict: boolean): Promise<FHIRServerInfo> {
  await ensureServersInitialized()

  const server = fhirServerStore.getServerByName(serverIdentifier)
  if (!server) {
    throw new Error(`Server '${serverIdentifier}' not found`)
  }

  const updated: FHIRServerInfo = { ...server, strictCapabilities: strict }
  fhirServerStore.updateServer(serverIdentifier, updated)

  // Persist the setting
  const persisted = dynamicServers.get(serverIdentifier) || { url: server.url, name: server.name }
  dynamicServers.set(serverIdentifier, { ...persisted, strictCapabilities: strict })
  savePersistedServers(dynamicServers)

  logger.fhir.info(`Set strictCapabilities=${strict} for server ${server.name}`, { identifier: serverIdentifier })
  return updated
}

// Update the organization assignments for a server
export async function setServerOrganizations(serverIdentifier: string, organizationIds: string[]): Promise<FHIRServerInfo> {
  await ensureServersInitialized()

  const server = fhirServerStore.getServerByName(serverIdentifier)
  if (!server) {
    throw new Error(`Server '${serverIdentifier}' not found`)
  }

  const ids = organizationIds.length > 0 ? organizationIds : undefined
  const updated: FHIRServerInfo = { ...server, organizationIds: ids }
  fhirServerStore.updateServer(serverIdentifier, updated)

  // Persist the setting
  const persisted = dynamicServers.get(serverIdentifier) || { url: server.url, name: server.name }
  dynamicServers.set(serverIdentifier, { ...persisted, organizationIds: ids })
  savePersistedServers(dynamicServers)

  logger.fhir.info(`Set organizationIds for server ${server.name}`, { identifier: serverIdentifier, organizationIds: ids })
  return updated
}

// Toggle MCP endpoint exposure for a server
export async function setMcpEnabled(serverIdentifier: string, enabled: boolean): Promise<FHIRServerInfo> {
  await ensureServersInitialized()

  const server = fhirServerStore.getServerByName(serverIdentifier)
  if (!server) {
    throw new Error(`Server '${serverIdentifier}' not found`)
  }

  const updated: FHIRServerInfo = { ...server, mcpEnabled: enabled }
  fhirServerStore.updateServer(serverIdentifier, updated)

  // Persist the setting
  const persisted = dynamicServers.get(serverIdentifier) || { url: server.url, name: server.name }
  dynamicServers.set(serverIdentifier, { ...persisted, mcpEnabled: enabled })
  savePersistedServers(dynamicServers)

  logger.fhir.info(`Set mcpEnabled=${enabled} for server ${server.name}`, { identifier: serverIdentifier })
  return updated
}

// Helper function to ensure servers are initialized
export async function ensureServersInitialized(): Promise<void> {
  if (!fhirServerStore.getIsInitialized()) {
    await fhirServerStore.initializeServers()
  }
}

// Export the store instance for direct access if needed
export { fhirServerStore }