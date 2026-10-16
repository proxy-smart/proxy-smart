// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '../config'
import { logger } from './logger'
import { isRecord, stringArray } from './type-guards'

/**
 * FHIR server utilities for dynamic version detection and metadata
 */

interface FHIRCapabilityStatement {
  resourceType: 'CapabilityStatement'
  fhirVersion?: string
  version?: string
  software?: {
    name?: string
    version?: string
  }
  implementation?: {
    description?: string
    url?: string
  }
}

export interface FHIRVersionInfo {
  fhirVersion: string
  serverVersion?: string
  serverName?: string
  supported: boolean
  smartCapabilities?: string[]
}

/**
 * Cache for FHIR server metadata to avoid repeated requests
 */
const fhirMetadataCache = new Map<string, { data: FHIRVersionInfo, timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/** Clear cached metadata for a specific server URL so the next fetch is fresh */
export function clearMetadataCache(serverUrl: string): void {
  fhirMetadataCache.delete(serverUrl)
}

/**
 * Normalize FHIR version to standard R + major version format
 * Examples:
 * - "4.0.1" → "R4"
 * - "5.0.0" → "R5" 
 * - "3.0.2" → "STU3"
 * - "1.0.2" → "DSTU2"
 * - "R4" → "R4" (already normalized)
 */
export function normalizeFHIRVersion(version: string): string {
  if (!version) throw new Error('FHIR version cannot be empty')

  // Already normalized (starts with R, STU, or DSTU)
  if (version.match(/^(R\d+|STU\d+|DSTU\d+)$/i)) {
    return version.toUpperCase()
  }

  // Extract major version number
  const majorVersionMatch = version.match(/^(\d+)\./)
  if (majorVersionMatch) {
    const majorVersion = parseInt(majorVersionMatch[1])
    switch (majorVersion) {
      case 5: return 'R5'
      case 4: return 'R4'
      case 3: return 'STU3'
      case 1: return 'DSTU2'
      default: return config.fhir.supportedVersions[0] // Default fallback to first supported version
    }
  }

  // Handle special cases
  const lowerVersion = version.toLowerCase()
  if (lowerVersion.includes('r5') || lowerVersion.includes('5.0')) return 'R5'
  if (lowerVersion.includes('r4') || lowerVersion.includes('4.0')) return 'R4'
  if (lowerVersion.includes('stu3') || lowerVersion.includes('3.0')) return 'STU3'
  if (lowerVersion.includes('dstu2') || lowerVersion.includes('1.0')) return 'DSTU2'

  // Ultimate fallback
  return config.fhir.supportedVersions[0]
}

/**
 * Fetch SMART capabilities from an origin FHIR server's .well-known/smart-configuration
 * Returns the capabilities array if available, empty array otherwise
 */
async function fetchSmartCapabilities(serverUrl: string): Promise<string[]> {
  try {
    const smartConfigUrl = `${serverUrl}/.well-known/smart-configuration`
    const response = await fetch(smartConfigUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    })

    if (!response.ok) return []

    const smartConfig: unknown = await response.json()
    return (isRecord(smartConfig) && stringArray(smartConfig.capabilities)) || []
  } catch {
    // Server doesn't support .well-known/smart-configuration — that's fine
    return []
  }
}

/**
 * Fetch and parse FHIR server metadata to determine version
 */
export async function getFHIRServerInfo(baseUrl?: string): Promise<FHIRVersionInfo> {
  const serverUrl = baseUrl || config.fhir.serverBases[0] // Use first server as default
  const cacheKey = serverUrl

  // Check cache first
  const cached = fhirMetadataCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data
  }

  try {
    // Fetch CapabilityStatement (metadata endpoint)
    const metadataUrl = `${serverUrl}/metadata`
    const response = await fetch(metadataUrl, {
      headers: {
        'Accept': 'application/fhir+json, application/json'
      },
      signal: AbortSignal.timeout(10000)
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch FHIR metadata: ${response.status} ${response.statusText}`)
    }

    const capability: FHIRCapabilityStatement = await response.json()

    // Extract FHIR version from CapabilityStatement
    let fhirVersion = capability.fhirVersion || config.fhir.supportedVersions[0] // Default to first supported version

    // Normalize version format to R + major version
    fhirVersion = normalizeFHIRVersion(fhirVersion)

    const versionInfo: FHIRVersionInfo = {
      fhirVersion,
      serverVersion: capability.software?.version || capability.version,
      serverName: capability.software?.name || 'Unknown FHIR Server',
      supported: config.fhir.supportedVersions.includes(fhirVersion)
    }

    // Try to fetch SMART capabilities from the origin server's .well-known/smart-configuration
    versionInfo.smartCapabilities = await fetchSmartCapabilities(serverUrl)

    // Cache the result
    fhirMetadataCache.set(cacheKey, {
      data: versionInfo,
      timestamp: Date.now()
    })

    return versionInfo
  } catch (error) {
    logger.fhir.warn('Failed to fetch FHIR server metadata', { 
      serverUrl, 
      error: error instanceof Error ? error.message : String(error) 
    })

    // Return default/fallback version info when metadata can't be retrieved
    const fallback: FHIRVersionInfo = {
      fhirVersion: 'Unknown',
      serverName: 'Unknown FHIR Server',
      supported: false
    }

    // Cache the fallback for a shorter period
    fhirMetadataCache.set(cacheKey, {
      data: fallback,
      timestamp: Date.now() - (CACHE_TTL - 60000) // Cache for 1 minute only
    })

    return fallback
  }
}

/**
 * Validate if a requested FHIR version is supported by the server
 */
export async function validateFHIRVersion(requestedVersion: string): Promise<boolean> {
  // Normalize the version first
  const normalizedVersion = normalizeFHIRVersion(requestedVersion)
  
  // Check if the version is in our supported list
  return config.fhir.supportedVersions.includes(normalizedVersion)
}

/**
 * Get supported FHIR versions for OpenAPI documentation
 */
export function getSupportedFHIRVersions(): string[] {
  return config.fhir.supportedVersions
}

/**
 * Generate a URL-safe server identifier from server metadata
 */
export function getServerIdentifier(serverInfo: FHIRVersionInfo, serverUrl: string, index: number): string {
  // Try to use server name from metadata first
  if (serverInfo.serverName && serverInfo.serverName !== 'Unknown FHIR Server') {
    // Convert server name to URL-safe identifier
    return serverInfo.serverName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  }

  // Fallback to URL-based identifier
  try {
    const url = new URL(serverUrl)
    const hostname = url.hostname.replace(/\./g, '-').replace(/[^a-zA-Z0-9-]/g, '')
    return hostname || `server-${index}`
  } catch {
    return `server-${index}`
  }
}

/**
 * Convert short FHIR version labels to semver codes (inverse of normalizeFHIRVersion)
 * Examples: "R4" → "4.0.1", "R5" → "5.0.0", "STU3" → "3.0.2"
 */
export function fhirVersionToSemver(version: string): string {
  const map: Record<string, string> = {
    'R2': '1.0.2', 'DSTU2': '1.0.2',
    'R3': '3.0.2', 'STU3': '3.0.2',
    'R4': '4.0.1',
    'R4B': '4.3.0',
    'R5': '5.0.0'
  }
  return map[version.toUpperCase()] || version
}

/**
 * Clear FHIR metadata cache (useful for testing or manual refresh)
 */
export function clearFHIRMetadataCache(): void {
  fhirMetadataCache.clear()
}
