// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '../config'
import { logger } from './logger'
import { isRecord, stringArray } from './type-guards'
import { isCapabilityStatement } from './fhir-capability-statement'
import { upstreamFetch } from './upstream-fetch'
import { TtlCache } from './cache/ttl-cache'

export interface FHIRVersionInfo {
  fhirVersion: string
  serverVersion?: string
  serverName?: string
  supported: boolean
  smartCapabilities?: string[]
}

const fhirMetadataCache = new Map<string, { data: FHIRVersionInfo, timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000
const FAILURE_TTL = 60 * 1000

/** An origin's SMART capabilities change rarely, and most origins (HAPI) serve none; an admin refresh asks again. */
const smartCapabilitiesCache = new TtlCache<string[]>({ ttlMs: 60 * 60 * 1000, maxEntries: 100 })

export function clearMetadataCache(serverUrl: string): void {
  fhirMetadataCache.delete(serverUrl)
  smartCapabilitiesCache.delete(serverUrl)
}

/** "4.0.1" → "R4", "3.0.2" → "STU3", "1.0.2" → "DSTU2"; unknown majors fall back to the first supported version. */
export function normalizeFHIRVersion(version: string): string {
  if (!version) throw new Error('FHIR version cannot be empty')

  if (version.match(/^(R\d+|STU\d+|DSTU\d+)$/i)) {
    return version.toUpperCase()
  }

  const majorVersionMatch = version.match(/^(\d+)\./)
  if (majorVersionMatch) {
    const majorVersion = parseInt(majorVersionMatch[1])
    switch (majorVersion) {
      case 5: return 'R5'
      case 4: return 'R4'
      case 3: return 'STU3'
      case 1: return 'DSTU2'
      default: return config.fhir.supportedVersions[0]
    }
  }

  const lowerVersion = version.toLowerCase()
  if (lowerVersion.includes('r5') || lowerVersion.includes('5.0')) return 'R5'
  if (lowerVersion.includes('r4') || lowerVersion.includes('4.0')) return 'R4'
  if (lowerVersion.includes('stu3') || lowerVersion.includes('3.0')) return 'STU3'
  if (lowerVersion.includes('dstu2') || lowerVersion.includes('1.0')) return 'DSTU2'

  return config.fhir.supportedVersions[0]
}

/** The origin's `.well-known/smart-configuration` capabilities, or [] when it serves none. */
function fetchSmartCapabilities(serverUrl: string): Promise<string[]> {
  return smartCapabilitiesCache.getOrLoad(serverUrl, () => probeSmartCapabilities(serverUrl))
}

async function probeSmartCapabilities(serverUrl: string): Promise<string[]> {
  try {
    const smartConfigUrl = `${serverUrl}/.well-known/smart-configuration`
    const response = await upstreamFetch(smartConfigUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    })

    if (!response.ok) return []

    const smartConfig: unknown = await response.json()
    return (isRecord(smartConfig) && stringArray(smartConfig.capabilities)) || []
  } catch {
    return []
  }
}

export async function getFHIRServerInfo(baseUrl?: string): Promise<FHIRVersionInfo> {
  const serverUrl = baseUrl || config.fhir.serverBases[0]
  const cacheKey = serverUrl

  const cached = fhirMetadataCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data
  }

  try {
    const metadataUrl = `${serverUrl}/metadata`
    const response = await upstreamFetch(metadataUrl, {
      headers: {
        'Accept': 'application/fhir+json, application/json'
      },
      signal: AbortSignal.timeout(10000)
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch FHIR metadata: ${response.status} ${response.statusText}`)
    }

    const capability: unknown = await response.json()
    if (!isCapabilityStatement(capability)) {
      throw new Error(`FHIR metadata at ${metadataUrl} is not a CapabilityStatement`)
    }

    const fhirVersion = normalizeFHIRVersion(capability.fhirVersion || config.fhir.supportedVersions[0])

    const versionInfo: FHIRVersionInfo = {
      fhirVersion,
      serverVersion: capability.software?.version || capability.version,
      serverName: capability.software?.name || 'Unknown FHIR Server',
      supported: config.fhir.supportedVersions.includes(fhirVersion)
    }

    versionInfo.smartCapabilities = await fetchSmartCapabilities(serverUrl)

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

    const fallback: FHIRVersionInfo = {
      fhirVersion: 'Unknown',
      serverName: 'Unknown FHIR Server',
      supported: false
    }

    fhirMetadataCache.set(cacheKey, {
      data: fallback,
      timestamp: Date.now() - (CACHE_TTL - FAILURE_TTL),
    })

    return fallback
  }
}

/** URL-safe identifier from the server's software name, else its hostname, else `server-<index>`. */
export function getServerIdentifier(serverInfo: FHIRVersionInfo, serverUrl: string, index: number): string {
  if (serverInfo.serverName && serverInfo.serverName !== 'Unknown FHIR Server') {
    return serverInfo.serverName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  }

  try {
    const url = new URL(serverUrl)
    const hostname = url.hostname.replace(/\./g, '-').replace(/[^a-zA-Z0-9-]/g, '')
    return hostname || `server-${index}`
  } catch {
    return `server-${index}`
  }
}

/** "R4" → "4.0.1"; an unknown label is returned unchanged. */
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

export function clearFHIRMetadataCache(): void {
  fhirMetadataCache.clear()
  smartCapabilitiesCache.clear()
}
