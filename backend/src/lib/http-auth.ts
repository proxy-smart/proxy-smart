// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { DicomServerConfigType, DicomServerViewType } from '@/schemas'

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

export function redactUpstreamCredentials(server: DicomServerConfigType): DicomServerViewType {
  const { password, authHeader, ...rest } = server
  return { ...rest, hasPassword: Boolean(password), hasAuthHeader: Boolean(authHeader) }
}

/** A blank secret keeps the stored one; credentials the auth type does not use are dropped. */
export function mergeUpstreamCredentials(
  current: DicomServerConfigType,
  update: Partial<DicomServerConfigType>,
): DicomServerConfigType {
  const { username, password, authHeader, ...rest } = { ...current, ...update }
  const usesBasic = rest.authType === 'basic'
  const usesHeader = rest.authType === 'bearer' || rest.authType === 'header'
  const keptPassword = password || current.password
  const keptHeader = authHeader || current.authHeader
  return {
    ...rest,
    ...(usesBasic && username ? { username } : {}),
    ...(usesBasic && keptPassword ? { password: keptPassword } : {}),
    ...(usesHeader && keptHeader ? { authHeader: keptHeader } : {}),
  }
}
