// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * A SMART client's Home URL (Keycloak `baseUrl`), which Keycloak and the proxy's /auth/return
 * offer as "Back to application". One rule for create, update, reconcile and the return lookup.
 */

import { config } from '@/config'
import { isProxyRoot, resolveClientHomeUrl } from '@proxy-smart/auth'

export interface HomeUrlSources {
  clientUri?: string
  launchUrl?: string
  redirectUris?: readonly string[]
}

/** The Home URL a client's own registration implies, never one of the proxy's own roots. */
export function derivedHomeUrl(sources: HomeUrlSources): string | undefined {
  return resolveClientHomeUrl({ ...sources, proxyBaseUrl: config.baseUrl, proxySiteUrl: config.siteUrl })
}

/** A stored Home URL worth keeping: absolute http(s) and not the proxy's API or site root. */
export function usableHomeUrl(stored: string | undefined): string | undefined {
  if (!stored || !/^https?:\/\//.test(stored)) return undefined
  return isProxyRoot(stored, [config.baseUrl, config.siteUrl]) ? undefined : stored
}

/**
 * The Home URL to store: an explicit one when the operator gives it (empty string = derive),
 * else the stored one when usable, else the derived one.
 */
export function homeUrlToStore(
  requested: string | undefined,
  stored: string | undefined,
  sources: HomeUrlSources,
): string | undefined {
  if (requested) return usableHomeUrl(requested) ?? derivedHomeUrl(sources)
  if (requested === undefined) return usableHomeUrl(stored) ?? derivedHomeUrl(sources)
  return derivedHomeUrl(sources)
}
