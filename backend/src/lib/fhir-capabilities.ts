// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import fetch from 'cross-fetch'
import { logger } from './logger'
import { fetchWithMtls, getMtlsConfig } from './mtls'

// ── CapabilityStatement raw types (FHIR R4/R5 complete) ─────────────────────

interface CapSearchParam {
  name: string
  type: string
  definition?: string
  documentation?: string
}

interface CapInteraction {
  code: string
}

interface CapOperation {
  name: string
  definition: string
  documentation?: string
}

interface CapSecurity {
  cors?: boolean
  service?: { coding?: { code?: string; system?: string }[]; text?: string }[]
  description?: string
}

interface CapResource {
  type: string
  profile?: string
  supportedProfile?: string[]
  documentation?: string
  interaction?: CapInteraction[]
  versioning?: string              // no-version | versioned | versioned-update
  readHistory?: boolean
  updateCreate?: boolean
  conditionalCreate?: boolean
  conditionalRead?: string         // not-supported | modified-since | not-match | full-support
  conditionalUpdate?: boolean
  conditionalDelete?: string       // not-supported | single | multiple
  referencePolicy?: string[]       // literal | logical | resolves | enforced | local
  searchInclude?: string[]
  searchRevInclude?: string[]
  searchParam?: CapSearchParam[]
  operation?: CapOperation[]
}

interface CapRest {
  mode: string
  documentation?: string
  security?: CapSecurity
  resource?: CapResource[]
  interaction?: CapInteraction[]
  searchParam?: CapSearchParam[]
  operation?: CapOperation[]
  compartment?: string[]
}

interface CapabilityStatementRaw {
  resourceType: 'CapabilityStatement'
  status?: string                  // draft | active | retired | unknown
  kind?: string                    // instance | capability | requirements
  fhirVersion?: string
  format?: string[]                // json | xml | ttl | mime types
  patchFormat?: string[]
  implementationGuide?: string[]
  software?: { name?: string; version?: string; releaseDate?: string }
  implementation?: { description?: string; url?: string }
  rest?: CapRest[]
}

// ── Parsed capability model (full spec coverage) ────────────────────────────

export interface ResourceCapability {
  type: string
  profile: string | null
  supportedProfiles: Set<string>
  interactions: Set<string>
  searchParams: Map<string, string>      // name → type
  searchInclude: Set<string>
  searchRevInclude: Set<string>
  operations: Set<string>
  // Behavioral flags
  versioning: string | null              // no-version | versioned | versioned-update
  readHistory: boolean
  updateCreate: boolean
  conditionalCreate: boolean
  conditionalRead: string | null         // not-supported | modified-since | not-match | full-support
  conditionalUpdate: boolean
  conditionalDelete: string | null       // not-supported | single | multiple
  referencePolicy: Set<string>
}

export interface ServerCapabilities {
  serverUrl: string
  serverIdentifier: string
  fhirVersion: string
  status: string | null
  format: Set<string>                    // supported content types (json, xml, etc.)
  patchFormat: Set<string>               // supported PATCH content types
  // Security
  security: {
    cors: boolean
    services: string[]                   // e.g., ['SMART-on-FHIR', 'OAuth']
  }
  // REST capabilities
  resources: Map<string, ResourceCapability>
  systemSearchParams: Map<string, string>
  systemInteractions: Set<string>
  systemOperations: Set<string>          // system-level $operations
  compartments: Set<string>              // compartment definition URLs
  fetchedAt: number
}

export interface NormalizationResult {
  originalParams: URLSearchParams
  normalizedParams: URLSearchParams
  strippedParams: string[]
  strippedIncludes: string[]             // _include/_revinclude values stripped
  resourceType: string
  supported: boolean
}

export interface FhirRequestContext {
  resourceType: string | null
  resourceId: string | null
  compartmentType: string | null
  isInstance: boolean
  isSearchEndpoint: boolean
  isOperation: boolean
  operationName: string | null
  isHistory: boolean
  hasSearchSemantics: boolean
}

// ── Cache ───────────────────────────────────────────────────────────────────

const capabilitiesCache = new Map<string, ServerCapabilities>()
const CACHE_TTL = 10 * 60 * 1000

// Params that are always valid regardless of CapabilityStatement declarations.
// These are part of the FHIR spec itself, not server-declared.
const FHIR_UNIVERSAL_PARAMS = new Set([
  // Result control
  '_format', '_pretty', '_summary', '_elements', '_count', '_total',
  '_sort', '_contained', '_containedType',
  // Common search params (spec-defined for all resources)
  '_id', '_lastUpdated', '_tag', '_profile', '_security', '_text',
  '_content', '_list', '_has', '_type', '_source',
  // Pagination
  '_offset', '_page', '_getpages', '_getpagesoffset',
  // Bundle
  '_bundletype',
])

// _include and _revinclude are NOT in FHIR_UNIVERSAL_PARAMS because
// their *values* need to be validated against searchInclude/searchRevInclude

// ── Core functions ──────────────────────────────────────────────────────────

export async function getServerCapabilities(
  serverUrl: string,
  serverIdentifier: string,
  options?: { force?: boolean }
): Promise<ServerCapabilities | null> {
  const cacheKey = serverIdentifier

  if (!options?.force) {
    const cached = capabilitiesCache.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return cached
    }
  }

  try {
    const metadataUrl = `${serverUrl}/metadata`
    const mtlsConfig = await getMtlsConfig(serverIdentifier)
    const useMtls = mtlsConfig?.enabled === true && metadataUrl.startsWith('https://')

    const response = useMtls
      ? await fetchWithMtls(metadataUrl, {
          headers: { 'Accept': 'application/fhir+json' },
          signal: AbortSignal.timeout(15000),
          serverId: serverIdentifier,
        })
      : await fetch(metadataUrl, {
          headers: { 'Accept': 'application/fhir+json' },
          signal: AbortSignal.timeout(15000),
        })

    if (!response.ok) {
      logger.fhir.warn('Failed to fetch CapabilityStatement', {
        serverIdentifier, status: response.status,
      })
      return null
    }

    const raw: CapabilityStatementRaw = await response.json()
    const capabilities = parseCapabilityStatement(raw, serverUrl, serverIdentifier)
    capabilitiesCache.set(cacheKey, capabilities)

    logger.fhir.info('Parsed CapabilityStatement', {
      serverIdentifier,
      resourceCount: capabilities.resources.size,
      fhirVersion: capabilities.fhirVersion,
      formats: [...capabilities.format],
    })

    return capabilities
  } catch (error) {
    logger.fhir.warn('Error fetching CapabilityStatement', {
      serverIdentifier,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** Exported for testing — parses raw CapabilityStatement JSON into structured model */
export function parseCapabilityStatement(
  raw: CapabilityStatementRaw,
  serverUrl: string,
  serverIdentifier: string
): ServerCapabilities {
  const serverRest = raw.rest?.find(r => r.mode === 'server') || raw.rest?.[0]

  const resources = new Map<string, ResourceCapability>()
  const systemSearchParams = new Map<string, string>()
  const systemInteractions = new Set<string>()
  const systemOperations = new Set<string>()

  // System-level search params
  if (serverRest?.searchParam) {
    for (const sp of serverRest.searchParam) {
      systemSearchParams.set(sp.name, sp.type)
    }
  }

  // System-level interactions (transaction, batch, search-system, history-system)
  if (serverRest?.interaction) {
    for (const i of serverRest.interaction) {
      systemInteractions.add(i.code)
    }
  }

  // System-level operations ($export, $everything, etc.)
  if (serverRest?.operation) {
    for (const op of serverRest.operation) {
      systemOperations.add(op.name)
    }
  }

  // Resource-level capabilities — full spec coverage
  if (serverRest?.resource) {
    for (const res of serverRest.resource) {
      const rc: ResourceCapability = {
        type: res.type,
        profile: res.profile || null,
        supportedProfiles: new Set(res.supportedProfile || []),
        interactions: new Set(res.interaction?.map(i => i.code) || []),
        searchParams: new Map(res.searchParam?.map(sp => [sp.name, sp.type]) || []),
        searchInclude: new Set(res.searchInclude || []),
        searchRevInclude: new Set(res.searchRevInclude || []),
        operations: new Set(res.operation?.map(o => o.name) || []),
        versioning: res.versioning || null,
        readHistory: res.readHistory ?? false,
        updateCreate: res.updateCreate ?? false,
        conditionalCreate: res.conditionalCreate ?? false,
        conditionalRead: res.conditionalRead || null,
        conditionalUpdate: res.conditionalUpdate ?? false,
        conditionalDelete: res.conditionalDelete || null,
        referencePolicy: new Set(res.referencePolicy || []),
      }
      resources.set(res.type, rc)
    }
  }

  // Parse security
  const securityRaw = serverRest?.security
  const security = {
    cors: securityRaw?.cors ?? false,
    services: securityRaw?.service
      ?.flatMap(s => s.coding?.map(c => c.code).filter(Boolean) as string[] || [])
      ?? [],
  }

  return {
    serverUrl,
    serverIdentifier,
    fhirVersion: raw.fhirVersion || 'unknown',
    status: raw.status || null,
    format: new Set(raw.format || []),
    patchFormat: new Set(raw.patchFormat || []),
    security,
    resources,
    systemSearchParams,
    systemInteractions,
    systemOperations,
    compartments: new Set(serverRest?.compartment || []),
    fetchedAt: Date.now(),
  }
}

// ── Path parsing ────────────────────────────────────────────────────────────

export function parseFhirPath(resourcePath: string, httpMethod: string): FhirRequestContext {
  const segments = resourcePath.split('/').filter(Boolean)

  const result: FhirRequestContext = {
    resourceType: null,
    resourceId: null,
    compartmentType: null,
    isInstance: false,
    isSearchEndpoint: false,
    isOperation: false,
    operationName: null,
    isHistory: false,
    hasSearchSemantics: false,
  }

  if (segments.length === 0) {
    result.hasSearchSemantics = httpMethod === 'GET'
    return result
  }

  const first = segments[0]

  if (first.startsWith('$')) {
    result.isOperation = true
    result.operationName = first.slice(1)
    return result
  }

  if (!first.match(/^[A-Z]/)) return result

  result.resourceType = first

  if (segments.length === 1) {
    result.hasSearchSemantics = httpMethod === 'GET'
    return result
  }

  const second = segments[1]

  if (second === '_search') {
    result.isSearchEndpoint = true
    result.hasSearchSemantics = true
    return result
  }

  if (second.startsWith('$')) {
    result.isOperation = true
    result.operationName = second.slice(1)
    return result
  }

  if (second === '_history') {
    result.isHistory = true
    return result
  }

  result.isInstance = true
  result.resourceId = second

  if (segments.length === 2) return result

  const third = segments[2]

  if (third === '_history') {
    result.isHistory = true
    return result
  }

  if (third.startsWith('$')) {
    result.isOperation = true
    result.operationName = third.slice(1)
    return result
  }

  // Compartment: Type/id/SubType
  if (third.match(/^[A-Z]/)) {
    result.compartmentType = first
    result.resourceType = third
    result.resourceId = null
    result.isInstance = false
    result.hasSearchSemantics = httpMethod === 'GET' || (segments.length > 3 && segments[3] === '_search')
    if (segments.length > 3 && segments[3] === '_search') {
      result.isSearchEndpoint = true
    }
    return result
  }

  return result
}

// ── Search param normalization ──────────────────────────────────────────────

/**
 * Normalize search parameters for a proxied request.
 *
 * Strategy:
 * 1. Fail-open when capabilities are absent
 * 2. FHIR universal params always pass
 * 3. _include / _revinclude values are validated against searchInclude / searchRevInclude
 * 4. Chained params (patient.name) validated by root param
 * 5. Modifier params (status:not) validated by base param
 * 6. System-level and resource-level params from CapabilityStatement
 */
export function normalizeSearchParams(
  capabilities: ServerCapabilities | null,
  resourceType: string,
  queryString: string
): NormalizationResult {
  const raw = queryString.startsWith('?') ? queryString.slice(1) : queryString
  const originalParams = new URLSearchParams(raw)
  const normalizedParams = new URLSearchParams()
  const strippedParams: string[] = []
  const strippedIncludes: string[] = []

  if (!capabilities) {
    return {
      originalParams,
      normalizedParams: new URLSearchParams(raw),
      strippedParams: [],
      strippedIncludes: [],
      resourceType,
      supported: true,
    }
  }

  const resourceCap = capabilities.resources.get(resourceType)

  // Unknown resource type → pass through
  if (!resourceCap) {
    return {
      originalParams,
      normalizedParams: new URLSearchParams(raw),
      strippedParams: [],
      strippedIncludes: [],
      resourceType,
      supported: false,
    }
  }

  for (const [key, value] of originalParams.entries()) {
    // _include / _revinclude — validate values, not just keys
    if (key === '_include' || key === '_include:iterate' || key === '_include:recurse') {
      if (isIncludeValueSupported(value, resourceCap.searchInclude)) {
        normalizedParams.append(key, value)
      } else {
        strippedIncludes.push(`${key}=${value}`)
      }
      continue
    }
    if (key === '_revinclude' || key === '_revinclude:iterate' || key === '_revinclude:recurse') {
      if (isIncludeValueSupported(value, resourceCap.searchRevInclude)) {
        normalizedParams.append(key, value)
      } else {
        strippedIncludes.push(`${key}=${value}`)
      }
      continue
    }

    const baseParam = key.split(':')[0]
    const rootParam = baseParam.split('.')[0]

    if (
      FHIR_UNIVERSAL_PARAMS.has(rootParam) ||
      capabilities.systemSearchParams.has(rootParam) ||
      resourceCap.searchParams.has(rootParam)
    ) {
      normalizedParams.append(key, value)
    } else {
      strippedParams.push(key)
    }
  }

  return {
    originalParams,
    normalizedParams,
    strippedParams,
    strippedIncludes,
    resourceType,
    supported: true,
  }
}

/**
 * Check if an _include/_revinclude value is supported.
 * Values come in the form "SourceType:searchParam" or "SourceType:searchParam:TargetType".
 * CapabilityStatement declares supported values like "Patient:organization".
 * A wildcard `*` in the CapabilityStatement means all includes are supported.
 */
function isIncludeValueSupported(value: string, declaredIncludes: Set<string>): boolean {
  if (declaredIncludes.size === 0) return true    // not declared = allow all
  if (declaredIncludes.has('*')) return true       // wildcard
  if (declaredIncludes.has(value)) return true     // exact match

  // Check prefix match: "Patient:organization:Organization" matches "Patient:organization"
  const parts = value.split(':')
  if (parts.length === 3) {
    return declaredIncludes.has(`${parts[0]}:${parts[1]}`)
  }

  return false
}

// ── Interaction checks ──────────────────────────────────────────────────────

export function isInteractionSupported(
  capabilities: ServerCapabilities | null,
  resourceType: string,
  httpMethod: string,
  isSearch: boolean
): boolean {
  if (!capabilities) return true

  const resourceCap = capabilities.resources.get(resourceType)
  if (!resourceCap) return true

  const interactionCode = mapHttpToInteraction(httpMethod, isSearch)
  if (!interactionCode) return true

  return resourceCap.interactions.has(interactionCode)
}

function mapHttpToInteraction(method: string, isSearch: boolean): string | null {
  switch (method.toUpperCase()) {
    case 'GET': return isSearch ? 'search-type' : 'read'
    case 'POST': return isSearch ? 'search-type' : 'create'
    case 'PUT': return 'update'
    case 'PATCH': return 'patch'
    case 'DELETE': return 'delete'
    default: return null
  }
}

/**
 * Check if a _history request is supported for a resource type.
 * Uses both interaction declarations and the readHistory flag.
 */
export function isHistorySupported(
  capabilities: ServerCapabilities | null,
  resourceType: string,
  isInstance: boolean
): boolean {
  if (!capabilities) return true

  const resourceCap = capabilities.resources.get(resourceType)
  if (!resourceCap) return true

  const code = isInstance ? 'history-instance' : 'history-type'
  return resourceCap.interactions.has(code)
}

/**
 * Check if a $operation is supported for a resource type (or system-level).
 */
export function isOperationSupported(
  capabilities: ServerCapabilities | null,
  resourceType: string | null,
  operationName: string
): boolean {
  if (!capabilities) return true

  // System-level operation
  if (!resourceType) {
    return capabilities.systemOperations.has(operationName)
  }

  const resourceCap = capabilities.resources.get(resourceType)
  if (!resourceCap) return true

  return resourceCap.operations.has(operationName)
}

/**
 * Check if the server supports a given content type for responses.
 * Falls back to true if format is not declared (many servers omit it).
 */
export function isFormatSupported(
  capabilities: ServerCapabilities | null,
  acceptHeader: string
): boolean {
  if (!capabilities || capabilities.format.size === 0) return true

  // Normalize common FHIR content types
  const normalized = acceptHeader.toLowerCase()
  for (const fmt of capabilities.format) {
    if (normalized.includes(fmt.toLowerCase())) return true
  }

  // Check common aliases
  if (normalized.includes('json') && (capabilities.format.has('json') || capabilities.format.has('application/fhir+json'))) return true
  if (normalized.includes('xml') && (capabilities.format.has('xml') || capabilities.format.has('application/fhir+xml'))) return true

  return false
}

/**
 * Check if a PATCH content type is supported.
 */
export function isPatchFormatSupported(
  capabilities: ServerCapabilities | null,
  contentType: string
): boolean {
  if (!capabilities || capabilities.patchFormat.size === 0) return true

  const normalized = contentType.toLowerCase()
  for (const fmt of capabilities.patchFormat) {
    if (normalized.includes(fmt.toLowerCase())) return true
  }
  return false
}

// ── Admin / introspection ───────────────────────────────────────────────────

export async function getCapabilitiesForServer(
  serverUrl: string,
  serverIdentifier: string
): Promise<ServerCapabilities | null> {
  return getServerCapabilities(serverUrl, serverIdentifier)
}

export function serializeCapabilities(caps: ServerCapabilities) {
  const resources: Record<string, object> = {}

  for (const [type, rc] of caps.resources) {
    resources[type] = {
      profile: rc.profile,
      supportedProfiles: [...rc.supportedProfiles],
      interactions: [...rc.interactions],
      searchParams: Object.fromEntries(rc.searchParams),
      searchInclude: [...rc.searchInclude],
      searchRevInclude: [...rc.searchRevInclude],
      operations: [...rc.operations],
      versioning: rc.versioning,
      readHistory: rc.readHistory,
      updateCreate: rc.updateCreate,
      conditionalCreate: rc.conditionalCreate,
      conditionalRead: rc.conditionalRead,
      conditionalUpdate: rc.conditionalUpdate,
      conditionalDelete: rc.conditionalDelete,
      referencePolicy: [...rc.referencePolicy],
    }
  }

  return {
    serverUrl: caps.serverUrl,
    serverIdentifier: caps.serverIdentifier,
    fhirVersion: caps.fhirVersion,
    status: caps.status,
    format: [...caps.format],
    patchFormat: [...caps.patchFormat],
    security: caps.security,
    resourceCount: caps.resources.size,
    systemSearchParams: Object.fromEntries(caps.systemSearchParams),
    systemInteractions: [...caps.systemInteractions],
    systemOperations: [...caps.systemOperations],
    compartments: [...caps.compartments],
    resources,
    fetchedAt: new Date(caps.fetchedAt).toISOString(),
    cacheAgeMs: Date.now() - caps.fetchedAt,
  }
}

export function clearCapabilitiesCache(serverIdentifier?: string): void {
  if (serverIdentifier) {
    capabilitiesCache.delete(serverIdentifier)
  } else {
    capabilitiesCache.clear()
  }
}

export function getCapabilitiesCacheStats() {
  const entries: { serverIdentifier: string; resourceCount: number; ageMs: number }[] = []
  for (const [, caps] of capabilitiesCache) {
    entries.push({
      serverIdentifier: caps.serverIdentifier,
      resourceCount: caps.resources.size,
      ageMs: Date.now() - caps.fetchedAt,
    })
  }
  return { size: capabilitiesCache.size, entries }
}
