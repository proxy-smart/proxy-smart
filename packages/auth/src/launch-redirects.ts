// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { LaunchSession, SmartProxyConfig } from './types'

/** RFC 9207: every authorization response the proxy sends, code or error, names it as issuer. */
export function withIssuer(url: URL, config: SmartProxyConfig): URL {
  url.searchParams.set('iss', config.baseUrl)
  return url
}

export function clientRedirectUrl(config: SmartProxyConfig, session: LaunchSession, code: string): string {
  const url = new URL(session.clientRedirectUri)
  url.searchParams.set('code', code)
  if (session.clientState) url.searchParams.set('state', session.clientState)
  return withIssuer(url, config).href
}

export function pickerRedirectUrl(
  config: SmartProxyConfig,
  path: string,
  sessionKey: string,
  code: string,
  aud: string | undefined,
): string {
  const url = new URL(`${config.baseUrl}${path}`)
  url.searchParams.set('session', sessionKey)
  url.searchParams.set('code', code)
  if (aud) url.searchParams.set('aud', aud)
  return url.href
}
