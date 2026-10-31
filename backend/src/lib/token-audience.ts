// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Default audience set must stay in sync with authorize-time validateAudience in routes/auth/oauth.ts.

import { config } from '../config'
import { stringList } from './type-guards'

export interface AudienceMatcher {
  value: string
  /** 'exact' matches aud or azp (client ids); 'prefix' matches aud at a URL path/query boundary. */
  mode: 'exact' | 'prefix'
}

export function isAudienceEnforcementDisabled(): boolean {
  return process.env.JWT_AUDIENCE_ENFORCEMENT === 'disabled'
}

// Boundary match so `<prefix>evil` does not match `<prefix>`.
function matchesPrefix(candidate: string, prefix: string): boolean {
  if (candidate === prefix) return true
  return (
    candidate.startsWith(prefix.endsWith('/') ? prefix : prefix + '/') ||
    candidate.startsWith(prefix + '?')
  )
}

export function getDefaultAudienceMatchers(): AudienceMatcher[] {
  const matchers: AudienceMatcher[] = []

  if (config.keycloak.adminUiClientId) {
    matchers.push({ value: config.keycloak.adminUiClientId, mode: 'exact' })
  }
  if (config.keycloak.adminClientId) {
    matchers.push({ value: config.keycloak.adminClientId, mode: 'exact' })
  }

  matchers.push({ value: `${config.baseUrl}${config.mcp.path}`, mode: 'prefix' })

  matchers.push({ value: `${config.baseUrl}/${config.name}/`, mode: 'prefix' })

  for (const base of config.fhir.serverBases) {
    if (base) matchers.push({ value: base, mode: 'prefix' })
  }

  for (const ext of config.accessControl.externalAudiences) {
    if (!ext) continue
    // Wildcard domains ('.example.com') are only checked at authorize time.
    if (!ext.startsWith('.')) matchers.push({ value: ext, mode: 'prefix' })
  }

  return matchers
}

/** Keycloak client whose `resource_url` is the FHIR base. */
export const FHIR_RESOURCE_CLIENT_ID = 'fhir-resource-server'

/** Audiences the resource-indicators scope maps. fhir-* is export-owned but still needs a mapper. */
export const RESOURCE_AUDIENCE_CLIENT_IDS = [FHIR_RESOURCE_CLIENT_ID, 'mcp-resource-server'] as const

export function isResourceAudienceClient(clientId: string | undefined): boolean {
  return RESOURCE_AUDIENCE_CLIENT_IDS.some((id) => id === clientId)
}

// SMART App Launch: aud is the FHIR base. The client id is the only aud an RFC 8693 exchange can carry.
export function getFhirResourceAudiences(): string[] {
  const auds = [`${config.baseUrl}/${config.name}/`, FHIR_RESOURCE_CLIENT_ID]
  for (const base of config.fhir.serverBases) {
    if (base) auds.push(base)
  }
  return auds
}

/** RFC 8707 resource URL of the MCP endpoint. */
export function getMcpResourceAudience(): string {
  return `${config.baseUrl}${config.mcp.path}`
}

function toMatchers(expected: string | string[]): AudienceMatcher[] {
  const values = Array.isArray(expected) ? expected : [expected]
  return values
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((value) => ({
      value,
      mode: value.includes('://') ? 'prefix' : 'exact',
    }))
}

export function isAudienceAccepted(
  aud: unknown,
  azp: unknown,
  expected?: string | string[],
): boolean {
  if (isAudienceEnforcementDisabled()) return true

  const matchers = expected !== undefined ? toMatchers(expected) : getDefaultAudienceMatchers()
  if (matchers.length === 0) return false

  const auds = stringList(aud)
  const azpStr = typeof azp === 'string' ? azp : null

  // azp names a client, never a resource URL, so it only satisfies exact matchers.
  const candidatesExact = azpStr ? [...auds, azpStr] : auds

  return matchers.some((m) => {
    if (m.mode === 'exact') return candidatesExact.includes(m.value)
    return auds.some((a) => matchesPrefix(a, m.value))
  })
}
