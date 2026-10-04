// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '@/config'
import { buildAuthorizationServerMetadata, buildOpenIdConfiguration } from '@/lib/oidc-discovery'
import { isRecord } from '@/lib/type-guards'
import { isCimdActive } from '@/lib/cimd-policy'

const DOCUMENTS = {
  'openid-configuration': { build: buildOpenIdConfiguration, label: 'OpenID Connect configuration' },
  'oauth-authorization-server': { build: buildAuthorizationServerMetadata, label: 'authorization server metadata' },
} as const

export type DiscoveryDocument = keyof typeof DOCUMENTS

interface DiscoveryContext {
  set: { status?: number | string }
}

export function discoveryHandler(document: DiscoveryDocument) {
  const { build, label } = DOCUMENTS[document]

  return async ({ set }: DiscoveryContext): Promise<Record<string, unknown>> => {
    try {
      const keycloakBase = config.keycloak.publicUrl || config.keycloak.baseUrl
      const response = await fetch(`${keycloakBase}/realms/${config.keycloak.realm}/.well-known/openid-configuration`)
      const oidcConfig: unknown = response.ok ? await response.json() : undefined

      if (!isRecord(oidcConfig)) {
        set.status = 502
        return { error: 'bad_gateway', error_description: `Failed to fetch ${label} from authorization server` }
      }

      return build(oidcConfig, config.baseUrl, isCimdActive())
    } catch {
      set.status = 500
      return { error: 'server_error', error_description: `Internal server error while fetching ${label}` }
    }
  }
}
