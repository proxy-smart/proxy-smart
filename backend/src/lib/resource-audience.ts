// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * RFC 8707 `resource` on an RFC 8693 token exchange.
 *
 * Keycloak's standard token exchange ignores `resource` and narrows `aud` only through
 * `audience` (client ids). Left alone, an exchange asking for the FHIR base came back with
 * `aud` still holding every pre-populated resource client and never the FHIR base, so
 * DICOMweb refused it. The proxy therefore names, as `audience`, the client whose
 * `resource_url` is the requested resource: the same binding Keycloak's resource-indicators
 * post-processor applies on the authorization-code path.
 */
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { getAdminClient } from '@/lib/kc-admin-factory'
import { RESOURCE_URL_ATTR } from './resource-server-exchange'

const CACHE_TTL_MS = 5 * 60 * 1000
/** A miss reloads at most this often, so unknown resources cannot hammer the admin API. */
const MISS_RELOAD_MIN_MS = 30 * 1000

export interface ResourceClientSource {
  /** Every client carrying a `resource_url`, as resource URL → client id. */
  load(): Promise<Map<string, string>>
}

/** Clients with a `resource_url`, read through the admin API. */
export function adminResourceClientSource(admin: () => Promise<KcAdminClient | null> = () => getAdminClient()): ResourceClientSource {
  return {
    async load() {
      const client = await admin()
      if (!client) return new Map()
      const byResource = new Map<string, string>()
      for (const candidate of await client.clients.find()) {
        // Keycloak 26.8 never puts a disabled client in aud, so naming one would mint a token the binding refuses.
        if (candidate.enabled === false) continue
        const resourceUrl = candidate.attributes?.[RESOURCE_URL_ATTR]
        const url = Array.isArray(resourceUrl) ? resourceUrl[0] : resourceUrl
        if (candidate.clientId && typeof url === 'string' && url) byResource.set(url, candidate.clientId)
      }
      return byResource
    },
  }
}

/** Every `resource_url` in the realm: the resources a token can be issued for. */
export async function realmResourceUrls(admin: KcAdminClient): Promise<string[]> {
  return [...(await adminResourceClientSource(async () => admin).load()).keys()]
}

export interface ResourceAudienceResolver {
  /** The client id holding exactly this `resource_url`, or null when none does. */
  audienceFor(resource: string): Promise<string | null>
}

export interface ResourceIndicatorRegistry extends ResourceAudienceResolver {
  /** The `resource_url` a client holds, or null when it holds none. */
  resourceOf(clientId: string): Promise<string | null>
}

/** Cached for a few minutes; a miss reloads once, so a client registered since is still found. */
export function createResourceAudienceResolver(
  source: ResourceClientSource = adminResourceClientSource(),
  now: () => number = Date.now,
): ResourceIndicatorRegistry {
  let cached: { byResource: Map<string, string>; loadedAt: number } | null = null

  async function load(): Promise<Map<string, string>> {
    const byResource = await source.load()
    cached = { byResource, loadedAt: now() }
    return byResource
  }

  async function lookup(pick: (byResource: Map<string, string>) => string | null): Promise<string | null> {
    const age = cached ? now() - cached.loadedAt : Infinity
    if (!cached || age >= CACHE_TTL_MS) return pick(await load())
    const hit = pick(cached.byResource)
    if (hit || age < MISS_RELOAD_MIN_MS) return hit
    return pick(await load())
  }

  return {
    audienceFor: (resource) => lookup((byResource) => byResource.get(resource) ?? null),
    resourceOf: (clientId) => lookup((byResource) => [...byResource].find(([, id]) => id === clientId)?.[0] ?? null),
  }
}

export const resourceAudienceResolver = createResourceAudienceResolver()
