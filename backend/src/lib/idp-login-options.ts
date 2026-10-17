// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type IdentityProviderRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderRepresentation.js'
import { TtlCache } from '@/lib/cache/ttl-cache'
import { getAdminClient } from '@/lib/kc-admin-factory'
import { logger } from '@/lib/logger'
import { stringEntries } from '@/lib/type-guards'
import type { PublicIdentityProviderType } from '@/schemas'

const LISTING_TTL_MS = 30_000
const FAILURE_TTL_MS = 5_000
const CACHE_KEY = 'realm'

/** Keycloak 26 keeps the flag top-level; realms imported from older exports still carry it in config. */
export function isShownOnLogin(provider: IdentityProviderRepresentation): boolean {
  return provider.enabled === true
    && provider.linkOnly !== true
    && provider.hideOnLogin !== true
    && stringEntries(provider.config).hideOnLoginPage !== 'true'
}

function guiOrder(provider: IdentityProviderRepresentation): number {
  const order = Number.parseInt(stringEntries(provider.config).guiOrder ?? '', 10)
  return Number.isNaN(order) ? Number.MAX_SAFE_INTEGER : order
}

/** Only what a sign-in button needs, in the order Keycloak's own login page uses. */
export function toLoginOptions(providers: readonly IdentityProviderRepresentation[]): PublicIdentityProviderType[] {
  return providers
    .filter(isShownOnLogin)
    .flatMap((provider) => {
      const { alias, providerId } = provider
      if (!alias || !providerId) return []
      return [{ provider, option: { alias, providerId, displayName: provider.displayName || alias, enabled: true } }]
    })
    .sort((a, b) => guiOrder(a.provider) - guiOrder(b.provider) || a.option.displayName.localeCompare(b.option.displayName))
    .map(({ option }) => option)
}

interface Listing {
  options: PublicIdentityProviderType[]
  failed: boolean
}

export interface LoginIdentityProvidersOptions {
  getAdmin: () => Promise<KcAdminClient | null>
  ttlMs?: number
  failureTtlMs?: number
}

/** Cached, so an unauthenticated caller cannot turn login-page loads into admin API traffic. */
export function createLoginIdentityProviders({
  getAdmin,
  ttlMs = LISTING_TTL_MS,
  failureTtlMs = FAILURE_TTL_MS,
}: LoginIdentityProvidersOptions) {
  const cache = new TtlCache<Listing>({ ttlMs })

  async function load(): Promise<Listing> {
    try {
      const admin = await getAdmin()
      if (!admin) return { options: [], failed: true }
      return { options: toLoginOptions(await admin.identityProviders.find()), failed: false }
    } catch (error) {
      logger.auth.error('Failed to list identity providers for the login page', { error })
      return { options: [], failed: true }
    }
  }

  return {
    async list(): Promise<PublicIdentityProviderType[]> {
      const listing = await cache.getOrLoad(CACHE_KEY, load, (result) => (result.failed ? failureTtlMs : ttlMs))
      return listing.options
    },
    clear(): void {
      cache.clear()
    },
  }
}

export const loginIdentityProviders = createLoginIdentityProviders({ getAdmin: getAdminClient })
