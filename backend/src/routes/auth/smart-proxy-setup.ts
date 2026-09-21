// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART Proxy Setup — instantiates @proxy-smart/auth components with backend config.
 *
 * Single source of truth for the proxy's SMART flow infrastructure.
 * Consumed by oauth.ts route handlers.
 */

import { config } from '@/config'
import { launchContextStore } from '@/lib/launch-context-store'
import { smartLogger } from '@/lib/smart-logger'
import { getMcpResourceAudience } from '@/lib/token-audience'
import {
  KeycloakAdapter,
  type SmartProxyConfig,
  type ILaunchContextStore,
  type IdPAdapter,
} from '@proxy-smart/auth'

/** SMART proxy configuration derived from backend config (uses getters for test compatibility) */
export const smartProxyConfig: SmartProxyConfig = {
  get baseUrl() { return config.baseUrl },
  callbackPath: '/auth/smart-callback',
  get launchCodeSecret() { return config.smart.launchSecret },
  get launchCodeTtlSeconds() { return config.smart.launchCodeTtlSeconds },
  // The MCP endpoint is the one non-SMART resource whose clients discover THIS
  // proxy as their authorization server, so its callback must come from us and
  // carry our `iss`. Derived from the same helper the /mcp audience check uses,
  // so the two cannot drift.
  get interceptedResourceUrls() { return [getMcpResourceAudience()] },
}

/** Session store — re-use the existing backend singleton (same ILaunchContextStore interface) */
export const smartStore: ILaunchContextStore = launchContextStore

/** Keycloak IdP adapter (lazy — reads config at call time) */
export const keycloakAdapter: IdPAdapter = {
  getAuthorizationUrl: () => `${config.keycloak.publicUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/auth`,
  getTokenUrl: () => `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/token`,
  getDeviceAuthorizationUrl: () => `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/auth/device`,
  getIntrospectionUrl: () => `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/token/introspect`,
  getLogoutUrl: () => `${config.keycloak.publicUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/logout`,
  getLaunchContextParams: (context) => {
    const adapter = new KeycloakAdapter({
      baseUrl: config.keycloak.baseUrl!,
      publicUrl: config.keycloak.publicUrl ?? undefined,
      realm: config.keycloak.realm!,
    })
    return adapter.getLaunchContextParams?.(context)
  },
  getIntrospectionAuth: () => {
    if (config.keycloak.adminClientId && config.keycloak.adminClientSecret) {
      return { clientId: config.keycloak.adminClientId, clientSecret: config.keycloak.adminClientSecret }
    }
    return null
  },
}

export { smartLogger }
