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
import { launchCodeSecret } from '@/lib/proxy-signing'
import { getMcpResourceAudience } from '@/lib/token-audience'
import {
  DEFAULT_CALLBACK_PATH,
  KeycloakAdapter,
  type SmartProxyConfig,
  type ILaunchContextStore,
  type IdPAdapter,
} from '@proxy-smart/auth'

/** SMART proxy configuration derived from backend config (uses getters for test compatibility) */
export const smartProxyConfig: SmartProxyConfig = {
  get baseUrl() { return config.baseUrl },
  callbackPath: DEFAULT_CALLBACK_PATH,
  get launchCodeSecret() { return launchCodeSecret() },
  get launchCodeTtlSeconds() { return config.smart.launchCodeTtlSeconds },
  // The MCP endpoint is the one non-SMART resource whose clients discover THIS
  // proxy as their authorization server, so its callback must come from us and
  // carry our `iss`. Derived from the same helper the /mcp audience check uses,
  // so the two cannot drift.
  get interceptedResourceUrls() { return [getMcpResourceAudience()] },
}

/** Session store — re-use the existing backend singleton (same ILaunchContextStore interface) */
export const smartStore: ILaunchContextStore = launchContextStore

/** Built per call so a config change (and a test's env) takes effect without a restart. */
const keycloak = () => new KeycloakAdapter({
  baseUrl: config.keycloak.baseUrl ?? '',
  publicUrl: config.keycloak.publicUrl ?? undefined,
  realm: config.keycloak.realm ?? '',
})

export const keycloakAdapter: IdPAdapter = {
  getAuthorizationUrl: () => keycloak().getAuthorizationUrl(),
  getTokenUrl: () => keycloak().getTokenUrl(),
  getDeviceAuthorizationUrl: () => keycloak().getDeviceAuthorizationUrl(),
  getIntrospectionUrl: () => keycloak().getIntrospectionUrl(),
  getRevocationUrl: () => keycloak().getRevocationUrl(),
  getLogoutUrl: () => keycloak().getLogoutUrl(),
  getLaunchContextParams: (context) => keycloak().getLaunchContextParams(context),
}

export { smartLogger }
