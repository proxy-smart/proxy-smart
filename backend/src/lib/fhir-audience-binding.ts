// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// SMART App Launch: the resource server validates that the authorization's `aud` is its own FHIR endpoint.

import { fhirResourceUrlFor, type FHIRServerInfo } from './fhir-server-store'
import { proxyBaseUrl, type FhirTarget } from './fhir-request-pipeline'
import { logger } from './logger'
import { resourceAudienceResolver, type ResourceAudienceResolver } from './resource-audience'
import { getRuntimeAccessControlConfig } from './runtime-config'
import { RESOURCE_AUDIENCE_CLIENT_IDS, normalizeAud } from './token-audience'
import type { AccessControlResult } from './smart-access-control'

export type AudienceBinding = { bound: true; via: string } | { bound: false; reason: string }

type AudienceTarget = Pick<FhirTarget, 'serverName' | 'fhirVersion'> & {
  serverInfo: Pick<FHIRServerInfo, 'identifier' | 'url'> & { metadata: Pick<FHIRServerInfo['metadata'], 'fhirVersion'> }
}

const RESOURCE_CLIENTS: ReadonlySet<string> = new Set(RESOURCE_AUDIENCE_CLIENT_IDS)

const trimSlash = (url: string) => url.replace(/\/+$/, '')

/** The URLs that name this server: the route base, the RFC 8707 resource URL, and the upstream base. */
export function fhirAudienceBases(target: AudienceTarget): string[] {
  return [...new Set([proxyBaseUrl(target), fhirResourceUrlFor(target.serverInfo), target.serverInfo.url].map(trimSlash))]
}

/**
 * Bound when `aud` holds one of the bases, or the id of the resource client whose `resource_url` is one,
 * provided the token was narrowed to it (no other resource server is in `aud`).
 */
export async function fhirAudienceBinding(aud: unknown, bases: string[], resolver: ResourceAudienceResolver): Promise<AudienceBinding> {
  const audiences = normalizeAud(aud)
  const wanted = new Set(bases.map(trimSlash))
  const urls = audiences.filter((a) => a.includes('://'))
  const direct = urls.find((url) => wanted.has(trimSlash(url)))
  if (direct) return { bound: true, via: direct }
  if (urls.length > 0) return { bound: false, reason: `aud names ${urls.join(', ')}, not this server's FHIR base ${bases[0]}` }

  let resourceClient: string | null = null
  try {
    for (const base of wanted) {
      const clientId = await resolver.audienceFor(base)
      if (clientId && audiences.includes(clientId)) {
        resourceClient = clientId
        break
      }
    }
  } catch (error) {
    return { bound: false, reason: `the resource client for this server could not be resolved: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (resourceClient) {
    const others = audiences.filter((a) => a !== resourceClient && RESOURCE_CLIENTS.has(a))
    return others.length === 0
      ? { bound: true, via: resourceClient }
      : { bound: false, reason: `aud names ${resourceClient} alongside ${others.join(', ')}, so the token was not narrowed to this server` }
  }
  return { bound: false, reason: `aud (${audiences.join(', ') || 'none'}) names neither this server's FHIR base ${bases[0]} nor its resource client` }
}

/** FHIR_AUDIENCE_ENFORCEMENT: enforce refuses an unbound token, audit-only logs what enforce would refuse. */
export async function enforceFhirAudience(
  tokenPayload: Record<string, unknown>,
  bases: string[],
  serverName: string,
  resolver: ResourceAudienceResolver = resourceAudienceResolver,
): Promise<AccessControlResult> {
  const mode = getRuntimeAccessControlConfig().fhirAudienceEnforcement
  if (mode === 'disabled') return { allowed: true }
  const binding = await fhirAudienceBinding(tokenPayload.aud, bases, resolver)
  if (binding.bound) return { allowed: true }

  logger.fhir.warn('FHIR access token is not bound to this server', {
    server: serverName,
    base: bases[0],
    aud: normalizeAud(tokenPayload.aud),
    azp: tokenPayload.azp,
    reason: binding.reason,
    mode,
    wouldDeny: mode !== 'enforce',
  })
  if (mode !== 'enforce') return { allowed: true }
  return {
    allowed: false,
    status: 401,
    body: { error: 'invalid_token', error_description: `The access token was not issued for this FHIR server: ${binding.reason}` },
  }
}
