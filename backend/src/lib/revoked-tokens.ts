// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { TtlCache } from './cache/ttl-cache'

/** No access token outlives this, so neither does its revocation. */
const MAX_REMEMBERED_MS = 24 * 60 * 60 * 1000

/**
 * The jti of every access token revoked through this proxy, until it would have expired anyway.
 * Keycloak records the revocation for introspection; this lets the proxy's own local JWT check
 * honour it too. Per process, like the token context store.
 */
const revoked = new TtlCache<true>({ ttlMs: MAX_REMEMBERED_MS, maxEntries: 100_000, cleanupIntervalMs: 5 * 60 * 1000 })

export function markTokenRevoked(jti: string, exp?: number): void {
  const remainingMs = exp === undefined ? MAX_REMEMBERED_MS : exp * 1000 - Date.now()
  if (remainingMs <= 0) return
  revoked.set(jti, true, Math.min(remainingMs, MAX_REMEMBERED_MS))
}

export function isTokenRevoked(jti: unknown): boolean {
  return typeof jti === 'string' && revoked.has(jti)
}
