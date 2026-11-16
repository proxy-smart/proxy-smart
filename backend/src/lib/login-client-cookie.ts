// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '@/config'

export const LOGIN_CLIENT_COOKIE = 'proxy_smart_login_client'
const MAX_AGE_SECONDS = 60 * 60
const MAX_CLIENT_ID_LENGTH = 512
const PRINTABLE = /^[\x21-\x7e]+$/

/** A client_id worth remembering: printable ASCII, no spaces, bounded. CIMD ids are URLs, so `/` and `:` pass. */
export function isRememberableClientId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_CLIENT_ID_LENGTH && PRINTABLE.test(value)
}

/** Remembers which client started the sign-in, for /auth/return when Keycloak never rendered its login page. */
export function loginClientCookie(clientId: string | undefined): string | undefined {
  if (!isRememberableClientId(clientId)) return undefined
  const secure = config.baseUrl.startsWith('https:') ? '; Secure' : ''
  return `${LOGIN_CLIENT_COOKIE}=${encodeURIComponent(clientId)}; Path=/auth; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`
}

export function rememberedLoginClient(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== LOGIN_CLIENT_COOKIE) continue
    try {
      const value = decodeURIComponent(part.slice(separator + 1).trim())
      return isRememberableClientId(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}
