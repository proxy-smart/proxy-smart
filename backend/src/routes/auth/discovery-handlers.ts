// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '@/config'
import { buildAuthorizationServerMetadata, buildOpenIdConfiguration } from '@/lib/oidc-discovery'
import { isRecord } from '@/lib/type-guards'
import { trustedCimdDomains } from '@/lib/cimd-policy'
import { trimTrailingSlashes } from '@proxy-smart/guards'

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
      const keycloakBase = config.keycloak.baseUrl || config.keycloak.publicUrl
      const response = await fetch(`${keycloakBase}/realms/${config.keycloak.realm}/.well-known/openid-configuration`)
      const oidcConfig: unknown = response.ok ? await response.json() : undefined

      if (!isRecord(oidcConfig)) {
        set.status = 502
        return { error: 'bad_gateway', error_description: `Failed to fetch ${label} from authorization server` }
      }

      const clientIdMetadataDocuments = (await trustedCimdDomains()).length > 0
      return build(oidcConfig, config.baseUrl, config.oauthIssuer, { clientIdMetadataDocuments })
    } catch {
      set.status = 500
      return { error: 'server_error', error_description: `Internal server error while fetching ${label}` }
    }
  }
}

function oauthIssuerPath(): string {
  return trimTrailingSlashes(new URL(config.oauthIssuer).pathname)
}

interface IssuerDiscoveryContext extends DiscoveryContext {
  params: Record<string, string | undefined>
}

export function issuerDiscoveryHandler(document: DiscoveryDocument, requestedIssuerPath: (params: IssuerDiscoveryContext['params']) => string) {
  const serve = discoveryHandler(document)

  return async (context: IssuerDiscoveryContext): Promise<Record<string, unknown>> => {
    if (trimTrailingSlashes(requestedIssuerPath(context.params)) !== oauthIssuerPath()) {
      context.set.status = 404
      return { error: 'not_found', error_description: 'No authorization server is identified by this path' }
    }
    return serve(context)
  }
}
