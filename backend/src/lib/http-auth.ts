// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { DicomServerConfigType, DicomServerViewType } from '@/schemas'

export type UpstreamCredentials = Pick<DicomServerConfigType, 'authType' | 'authHeader' | 'username' | 'password'>

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

/** An OAuth client_secret_basic header and the client it names (RFC 6749 §2.3.1), or null. */
export function clientBasicAuth(authorization: string | undefined): { header: string; clientId: string } | null {
  const header = authorization?.trim() ?? ''
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header)
  if (!match) return null
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon <= 0) return null
  try {
    return { header, clientId: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')) }
  } catch {
    return null
  }
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
