// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { DicomServerConfigType } from '@/schemas'

export type UpstreamCredentials = Pick<DicomServerConfigType, 'authType' | 'authHeader' | 'username' | 'password'>

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

/** Build auth header from server config */
export function upstreamAuthHeader(server: UpstreamCredentials): string | null {
  switch (server.authType) {
    case 'basic':
      return server.username && server.password ? basicAuthHeader(server.username, server.password) : null
    case 'bearer':
    case 'header':
      return server.authHeader || null
    default:
      return null
  }
}
