// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

export const TestKeycloakConnectionRequest = t.Object({
  baseUrl: t.String({ format: 'uri', description: 'Keycloak base URL' }),
  realm: t.String({ description: 'Keycloak realm name' })
}, { title: 'TestKeycloakConnectionRequest' })

export const TestKeycloakConnectionResponse = t.Object({
  success: t.Boolean({ description: 'Whether the connection test succeeded' }),
  message: t.Optional(t.String({ description: 'Success message' })),
  error: t.Optional(t.String({ description: 'Error message if connection failed' }))
}, { title: 'TestKeycloakConnectionResponse' })

export const SaveKeycloakConfigRequest = t.Object({
  baseUrl: t.String({ format: 'uri', description: 'Keycloak base URL' }),
  realm: t.String({ description: 'Keycloak realm name' }),
  adminClientId: t.Optional(t.String({ description: 'Admin client ID for API access' })),
  adminClientSecret: t.Optional(t.String({ description: 'Admin client secret for API access' }))
}, { title: 'SaveKeycloakConfigRequest' })

export const SaveKeycloakConfigResponse = t.Object({
  success: t.Boolean({ description: 'Whether the configuration was saved successfully' }),
  message: t.Optional(t.String({ description: 'Success message' })),
  error: t.Optional(t.String({ description: 'Error message if save failed' })),
  restartRequired: t.Optional(t.Boolean({ description: 'Whether a service restart is required' }))
}, { title: 'SaveKeycloakConfigResponse' })

export const KeycloakConfigResponse = t.Object({
  baseUrl: t.Union([t.String(), t.Null()], { description: 'Keycloak base URL' }),
  realm: t.Union([t.String(), t.Null()], { description: 'Keycloak realm name' }),
  hasAdminClient: t.Boolean({ description: 'Whether admin client credentials are configured' }),
  adminClientId: t.Union([t.String(), t.Null()], { description: 'Admin client ID (if configured)' })
}, { title: 'KeycloakConfigResponse' })

// Cross-field rules (ceiling above idle window, no 0 since Keycloak reads it as unlimited) live in lib/session-settings.
export const SessionSettings = t.Object({
  ssoSessionIdleTimeout: t.Optional(t.Integer({ description: 'Seconds an SSO session may sit idle before expiring' })),
  ssoSessionMaxLifespan: t.Optional(t.Integer({ description: 'Seconds an SSO session may live regardless of activity' })),
  offlineSessionIdleTimeout: t.Optional(t.Integer({ description: 'Seconds an offline session may sit idle before expiring' })),
  offlineSessionMaxLifespan: t.Optional(t.Integer({ description: 'Seconds an offline session may live regardless of activity. Applies only when the ceiling is enabled' })),
  offlineSessionMaxLifespanEnabled: t.Optional(t.Boolean({ description: 'Whether the offline ceiling is enforced. False leaves offline sessions unbounded by anything but the idle timeout' })),
}, { title: 'SessionSettings' })

export type TestKeycloakConnectionRequestType = Static<typeof TestKeycloakConnectionRequest>
export type TestKeycloakConnectionResponseType = Static<typeof TestKeycloakConnectionResponse>
export type SaveKeycloakConfigRequestType = Static<typeof SaveKeycloakConfigRequest>
export type SaveKeycloakConfigResponseType = Static<typeof SaveKeycloakConfigResponse>
export type KeycloakConfigResponseType = Static<typeof KeycloakConfigResponse>
export type SessionSettingsType = Static<typeof SessionSettings>
