// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import {
  Configuration,
  SmartAppsApi,
  HealthcareUsersApi,
  ScopeSetsApi,
  McpManagementApi,
  AdminApi,
  IdentityProvidersApi,
  UserFederationApi,
  RolesApi,
} from './api-client'
import { type ResolvedConfig } from './config'
import { type Session } from './session'

export interface ApiClient {
  smartApps: SmartAppsApi
  healthcareUsers: HealthcareUsersApi
  scopeSets: ScopeSetsApi
  mcp: McpManagementApi
  admin: AdminApi
  identityProviders: IdentityProvidersApi
  userFederation: UserFederationApi
  roles: RolesApi
  basePath: string
}

/** The session supplies the bearer per request, refreshing it when it has expired. */
export function createApiClient(config: ResolvedConfig, session: Session): ApiClient {
  const configuration = new Configuration({
    basePath: config.url,
    accessToken: () => session.getAccessToken(),
  })
  return {
    smartApps: new SmartAppsApi(configuration),
    healthcareUsers: new HealthcareUsersApi(configuration),
    scopeSets: new ScopeSetsApi(configuration),
    mcp: new McpManagementApi(configuration),
    admin: new AdminApi(configuration),
    identityProviders: new IdentityProvidersApi(configuration),
    userFederation: new UserFederationApi(configuration),
    roles: new RolesApi(configuration),
    basePath: config.url,
  }
}
