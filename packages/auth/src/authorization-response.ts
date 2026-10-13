// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { SmartProxyConfig } from './types'

/** RFC 9207 `iss` on every authorization response, code or error; clients string-compare it, so `baseUrl` verbatim. */
export function withIssuer(url: URL, config: Pick<SmartProxyConfig, 'baseUrl'>): URL {
  url.searchParams.set('iss', config.baseUrl)
  return url
}

export interface AuthorizationError {
  error: string
  error_description?: string
  state?: string
}

/** An RFC 6749 §4.1.2.1 error response, addressed to a redirect_uri the caller has already validated. */
export function authorizationErrorRedirect(
  redirectUri: string,
  { error, error_description, state }: AuthorizationError,
  config: Pick<SmartProxyConfig, 'baseUrl'>,
): string {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  if (error_description) url.searchParams.set('error_description', error_description)
  if (state) url.searchParams.set('state', state)
  return withIssuer(url, config).href
}
