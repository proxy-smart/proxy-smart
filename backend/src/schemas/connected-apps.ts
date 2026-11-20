// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

export const ConnectedApp = t.Object({
  clientId: t.String({ description: 'The client identifier; for a client named by its metadata document, the document URL' }),
  name: t.String({ description: 'The name the user saw when connecting it' }),
  host: t.Optional(t.String({ description: 'The host that vouches for a client named by its metadata document' })),
  kind: t.Union([t.Literal('metadata-document'), t.Literal('dynamic-registration'), t.Literal('mcp-client')], {
    description: 'How the app was connected: by its Client ID Metadata Document, by dynamic registration, or through the shared MCP client',
  }),
  resources: t.Array(t.String(), { description: 'Resources the user approved this app for' }),
  scopes: t.Array(t.String(), { description: 'Permissions the user approved' }),
  connectedAt: t.Optional(t.Number({ description: 'When the user first approved it (Unix milliseconds)' })),
}, { title: 'ConnectedApp' })
export type ConnectedAppType = Static<typeof ConnectedApp>

export const ConnectedAppsResponse = t.Object({
  apps: t.Array(ConnectedApp),
}, { title: 'ConnectedAppsResponse' })

export const ConnectedAppQuery = t.Object({
  client_id: t.String({ minLength: 1, description: 'The app to disconnect' }),
}, { title: 'ConnectedAppQuery' })
