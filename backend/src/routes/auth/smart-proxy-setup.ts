// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

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

/** Getters, so a config change (and a test's env) takes effect without a restart. */
export const smartProxyConfig: SmartProxyConfig = {
  get baseUrl() { return config.baseUrl },
  callbackPath: DEFAULT_CALLBACK_PATH,
  get launchCodeSecret() { return launchCodeSecret() },
  get launchCodeTtlSeconds() { return config.smart.launchCodeTtlSeconds },
  // MCP clients discover this proxy as their authorization server, so their callback must carry our `iss`.
  get interceptedResourceUrls() { return [getMcpResourceAudience()] },
}

export const smartStore: ILaunchContextStore = launchContextStore

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
  getIdentityProviderHintParams: (alias) => keycloak().getIdentityProviderHintParams(alias),
  getLaunchContextParams: (context) => keycloak().getLaunchContextParams(context),
  getIntrospectionAuth: () => keycloak().getIntrospectionAuth(),
  isReachable: (fetchFn) => keycloak().isReachable(fetchFn),
}

export { smartLogger }
